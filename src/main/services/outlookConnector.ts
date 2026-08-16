import {
  PublicClientApplication,
  type AccountInfo,
  type ICachePlugin,
  type IPublicClientApplication,
  type TokenCacheContext,
} from "@azure/msal-node";
import { z } from "zod";

import type {
  DeviceCodeNotice,
  ProviderAccountSummary,
} from "../../shared/contracts.js";
import type {
  OrganizerProviderAdapter,
  ProviderMessage,
} from "./organizerEngine.js";
import { errorFields, logOrganizer } from "./debugLog.js";
import type { EncryptedSecretStore } from "./secretStore.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const MAIL_SCOPES = ["Mail.ReadWrite", "offline_access"];

const graphMessageSchema = z.object({
  id: z.string(),
  from: z
    .object({ emailAddress: z.object({ address: z.string().default("") }) })
    .nullish(),
  subject: z.string().nullish(),
  receivedDateTime: z.string(),
  importance: z.string().nullish(),
  isRead: z.boolean(),
  webLink: z.string().url(),
  bodyPreview: z.string().nullish(),
});

const graphListSchema = z.object({ value: z.array(graphMessageSchema) });
const folderSchema = z.object({ id: z.string(), displayName: z.string() });
const folderListSchema = z.object({
  value: z.array(folderSchema),
  "@odata.nextLink": z.string().optional(),
});
const subscriptionSchema = z.object({
  id: z.string(),
  expirationDateTime: z.string(),
});

const TENANT_ALIASES = new Set(["common", "organizations", "consumers"]);
const TENANT_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function assertAzureTenantId(tenantId: string): void {
  const value = tenantId.trim();
  if (
    TENANT_ALIASES.has(value.toLowerCase()) ||
    TENANT_GUID.test(value) ||
    TENANT_DOMAIN.test(value)
  ) {
    return;
  }
  throw new Error(
    `Invalid Azure tenant "${tenantId}". Use the Directory (tenant) ID GUID, or common / organizations.`,
  );
}

function approvedDeviceLoginUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !(
      host === "microsoft.com" ||
      host.endsWith(".microsoft.com") ||
      host === "microsoftonline.com" ||
      host.endsWith(".microsoftonline.com")
    )
  ) {
    throw new Error("MSAL returned an unapproved device-login URL.");
  }
  return url;
}

function resolveDeviceLoginUrl(response: {
  verificationUri?: string;
  message?: string;
}): URL {
  const candidates: string[] = [];
  if (response.verificationUri?.trim()) {
    candidates.push(response.verificationUri.trim());
  }
  for (const match of response.message?.match(/https:\/\/[^\s]+/g) ?? []) {
    candidates.push(match.replace(/[.,)]+$/, ""));
  }

  for (const candidate of candidates) {
    try {
      return approvedDeviceLoginUrl(candidate);
    } catch {
      // Try the next candidate from MSAL or the message text.
    }
  }

  throw new Error(
    response.message?.trim() ||
      "Microsoft did not return a device login URL. Check the tenant ID and that Allow public client flows is enabled on the Entra app.",
  );
}

export class EncryptedMsalCachePlugin implements ICachePlugin {
  public constructor(
    private readonly secrets: EncryptedSecretStore,
    private readonly secretName = "outlook-msal-cache",
  ) {}

  public async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
    const serialized = await this.secrets.get(this.secretName);
    if (serialized) {
      context.tokenCache.deserialize(serialized);
    }
  }

  public async afterCacheAccess(context: TokenCacheContext): Promise<void> {
    if (context.cacheHasChanged) {
      await this.secrets.set(
        this.secretName,
        context.tokenCache.serialize(),
      );
    }
  }
}

export interface OutlookConnectorOptions {
  clientId: string;
  tenantId: string;
  secrets: EncryptedSecretStore;
  onDeviceCode: (notice: DeviceCodeNotice) => void;
  createClient?: (cachePlugin: ICachePlugin) => IPublicClientApplication;
  now?: () => Date;
}

export class OutlookConnector {
  private readonly client: IPublicClientApplication;
  private readonly now: () => Date;

  public constructor(private readonly options: OutlookConnectorOptions) {
    assertAzureTenantId(options.tenantId);
    const cachePlugin = new EncryptedMsalCachePlugin(options.secrets);
    this.client =
      options.createClient?.(cachePlugin) ??
      new PublicClientApplication({
        auth: {
          clientId: options.clientId,
          authority: `https://login.microsoftonline.com/${encodeURIComponent(options.tenantId.trim())}`,
        },
        cache: { cachePlugin },
      });
    this.now = options.now ?? (() => new Date());
  }

  public async connect(): Promise<ProviderAccountSummary> {
    const result = await this.client.acquireTokenByDeviceCode({
      scopes: MAIL_SCOPES,
      deviceCodeCallback: (response) => {
        const verificationUri = resolveDeviceLoginUrl(response);
        this.options.onDeviceCode({
          provider: "outlook",
          userCode: response.userCode,
          verificationUri: verificationUri.toString(),
          message: response.message,
          expiresAt: new Date(
            this.now().getTime() + response.expiresIn * 1_000,
          ).toISOString(),
        });
      },
    });

    if (!result?.account) {
      throw new Error("Microsoft sign-in completed without an account.");
    }
    return this.summary(result.account);
  }

  public async listAccounts(): Promise<ProviderAccountSummary[]> {
    return (await this.client.getAllAccounts()).map((account) =>
      this.summary(account),
    );
  }

  public async removeAccount(accountId: string): Promise<boolean> {
    const account = await this.findAccount(accountId);
    if (!account) {
      return false;
    }
    await this.client.getTokenCache().removeAccount(account);
    return true;
  }

  public async acquireMailToken(accountId: string): Promise<string> {
    const account = await this.findAccount(accountId);
    if (!account) {
      logOrganizer("error", "outlook.token.missing-account", { accountId });
      throw new Error("Microsoft account is not connected.");
    }
    try {
      const result = await this.client.acquireTokenSilent({
        account,
        scopes: MAIL_SCOPES,
      });
      logOrganizer("debug", "outlook.token.ok", {
        accountId,
        username: account.username,
        expiresOn: result.expiresOn?.toISOString(),
        scopes: result.scopes,
      });
      return result.accessToken;
    } catch (reason) {
      logOrganizer("error", "outlook.token.failed", {
        accountId,
        username: account.username,
        ...errorFields(reason),
      });
      throw reason;
    }
  }

  private async findAccount(accountId: string): Promise<AccountInfo | undefined> {
    return (await this.client.getAllAccounts()).find(
      (account) => account.homeAccountId === accountId,
    );
  }

  private summary(account: AccountInfo): ProviderAccountSummary {
    return {
      id: account.homeAccountId,
      provider: "outlook",
      email: account.username,
      displayName: account.name,
      health: { status: "connected", lastCheckedAt: this.now().toISOString() },
    };
  }
}

type FetchLike = typeof fetch;

export class OutlookGraphAdapter implements OrganizerProviderAdapter {
  private readonly folderCache = new Map<string, string>();

  public constructor(
    private readonly getToken: (accountId: string) => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  public async fetchMessages(
    accountId: string,
    options: { unreadOnly: boolean; limit: number },
  ): Promise<ProviderMessage[]> {
    const query = new URLSearchParams({
      "$top": String(options.limit),
      "$select":
        "id,from,subject,receivedDateTime,importance,isRead,webLink,bodyPreview",
      "$orderby": "receivedDateTime desc",
    });
    if (options.unreadOnly) {
      query.set(
        "$filter",
        "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false",
      );
    }
    const path = `/me/mailFolders/inbox/messages?${query.toString()}`;
    logOrganizer("debug", "outlook.fetch.start", {
      accountId,
      unreadOnly: options.unreadOnly,
      limit: options.limit,
      filter: query.get("$filter"),
      path,
    });
    const data = graphListSchema.parse(await this.request(accountId, path));
    logOrganizer("info", "outlook.fetch.ok", {
      accountId,
      unreadOnly: options.unreadOnly,
      returned: data.value.length,
      unreadReturned: data.value.filter((message) => !message.isRead).length,
    });
    return data.value.map((message) => ({
      id: message.id,
      sender: message.from?.emailAddress.address ?? "",
      subject: message.subject ?? "",
      receivedAt: message.receivedDateTime,
      bodyPreview: message.bodyPreview ?? "",
      webUrl: message.webLink,
      unread: !message.isRead,
      highImportance: message.importance?.toLowerCase() === "high",
    }));
  }

  public async moveMessage(
    accountId: string,
    messageId: string,
    rootFolder: string,
    folder: string,
  ): Promise<void> {
    const destinationId = await this.ensureFolder(
      accountId,
      rootFolder,
      folder,
    );
    logOrganizer("debug", "outlook.move.start", {
      accountId,
      messageId,
      rootFolder,
      folder,
      destinationId,
    });
    await this.request(
      accountId,
      `/me/messages/${encodeURIComponent(messageId)}/move`,
      {
        method: "POST",
        body: JSON.stringify({ destinationId }),
      },
    );
    logOrganizer("info", "outlook.move.ok", {
      accountId,
      messageId,
      rootFolder,
      folder,
      destinationId,
    });
  }

  public async markRead(accountId: string, messageId: string): Promise<void> {
    await this.request(
      accountId,
      `/me/messages/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body: JSON.stringify({ isRead: true }) },
    );
  }

  public async createSubscription(
    accountId: string,
    relayBaseUrl: string,
    clientState: string,
  ): Promise<{ id: string; expirationDateTime: string }> {
    const base = new URL(relayBaseUrl);
    const expirationDateTime = new Date(
      Date.now() + 71 * 60 * 60 * 1_000,
    ).toISOString();
    return subscriptionSchema.parse(
      await this.request(accountId, "/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          changeType: "created,updated",
          notificationUrl: new URL(
            "/api/outlook/notifications",
            base,
          ).toString(),
          lifecycleNotificationUrl: new URL(
            "/api/outlook/lifecycle",
            base,
          ).toString(),
          resource: "me/mailFolders('Inbox')/messages",
          expirationDateTime,
          clientState,
        }),
      }),
    );
  }

  public async renewSubscription(
    accountId: string,
    subscriptionId: string,
  ): Promise<{ id: string; expirationDateTime: string }> {
    return subscriptionSchema.parse(
      await this.request(
        accountId,
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            expirationDateTime: new Date(
              Date.now() + 71 * 60 * 60 * 1_000,
            ).toISOString(),
          }),
        },
      ),
    );
  }

  public async deleteSubscription(
    accountId: string,
    subscriptionId: string,
  ): Promise<void> {
    await this.request(
      accountId,
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: "DELETE" },
    );
  }

  private async ensureFolder(
    accountId: string,
    rootFolder: string,
    folder: string,
  ): Promise<string> {
    const cacheKey = `${accountId}\u0000${rootFolder}\u0000${folder}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const rootId = await this.findOrCreateFolder(
      accountId,
      "/me/mailFolders/inbox/childFolders",
      rootFolder,
    );
    const childId = await this.findOrCreateFolder(
      accountId,
      `/me/mailFolders/${encodeURIComponent(rootId)}/childFolders`,
      folder,
    );
    this.folderCache.set(cacheKey, childId);
    return childId;
  }

  private async listFolders(
    accountId: string,
    collectionPath: string,
  ): Promise<Array<{ id: string; displayName: string }>> {
    const folders: Array<{ id: string; displayName: string }> = [];
    let path: string | undefined =
      `${collectionPath}?$top=100&$select=id,displayName`;
    while (path) {
      const payload = folderListSchema.parse(await this.request(accountId, path));
      folders.push(...payload.value);
      path = payload["@odata.nextLink"];
    }
    return folders;
  }

  private async findOrCreateFolder(
    accountId: string,
    collectionPath: string,
    displayName: string,
  ): Promise<string> {
    const folders = await this.listFolders(accountId, collectionPath);
    const existing = folders.find(
      (item) => item.displayName.toLowerCase() === displayName.toLowerCase(),
    );
    if (existing) {
      logOrganizer("debug", "outlook.folder.existing", {
        accountId,
        collectionPath,
        displayName,
        folderId: existing.id,
        listed: folders.map((item) => item.displayName),
      });
      return existing.id;
    }
    logOrganizer("info", "outlook.folder.create", {
      accountId,
      collectionPath,
      displayName,
      listed: folders.map((item) => item.displayName),
      hint: collectionPath.includes("/inbox/childFolders")
        ? "Creating a folder under Inbox."
        : undefined,
    });
    return folderSchema.parse(
      await this.request(accountId, collectionPath, {
        method: "POST",
        body: JSON.stringify({ displayName }),
      }),
    ).id;
  }

  private async request(
    accountId: string,
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const method = (init.method ?? "GET").toUpperCase();
    const started = Date.now();
    const token = await this.getToken(accountId);
    const url = path.startsWith("https://") ? path : `${GRAPH_ROOT}${path}`;
    logOrganizer("debug", "outlook.graph.request", {
      accountId,
      method,
      path,
    });
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        Prefer: 'IdType="ImmutableId"',
        ...init.headers,
      },
    });
    const raw = response.status === 204 ? "" : await response.text();
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const snippet = raw.replace(/\s+/g, " ").trim();
      logOrganizer("error", "outlook.graph.failed", {
        accountId,
        method,
        path,
        status: response.status,
        statusText: response.statusText,
        elapsedMs,
        body: snippet,
      });
      throw new Error(
        snippet
          ? `Microsoft Graph request failed (${response.status}): ${snippet.slice(0, 400)}`
          : `Microsoft Graph request failed (${response.status}).`,
      );
    }
    logOrganizer("debug", "outlook.graph.ok", {
      accountId,
      method,
      path,
      status: response.status,
      elapsedMs,
      bodyChars: raw.length,
    });
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (reason) {
      logOrganizer("error", "outlook.graph.invalid-json", {
        accountId,
        method,
        path,
        status: response.status,
        body: raw,
        ...errorFields(reason),
      });
      throw new Error("Microsoft Graph returned invalid JSON.");
    }
  }
}
