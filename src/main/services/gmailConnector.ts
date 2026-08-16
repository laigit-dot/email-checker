import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

import { google } from "googleapis";
import { z } from "zod";

import type { ProviderAccountSummary } from "../../shared/contracts.js";
import type {
  OrganizerProviderAdapter,
  ProviderMessage,
} from "./organizerEngine.js";
import { errorFields, logOrganizer } from "./debugLog.js";
import type { EncryptedSecretStore } from "./secretStore.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const accountIndexSchema = z.array(
  z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string().optional(),
  }),
);
const tokenSchema = z.record(z.string(), z.unknown());

export interface GmailApi {
  listMessages(options: {
    unreadOnly: boolean;
    limit: number;
  }): Promise<{ messages: Array<{ id: string }> }>;
  getMessage(id: string): Promise<{
    id: string;
    internalDate?: string | null;
    labelIds?: string[] | null;
    snippet?: string | null;
    payload?: {
      headers?: Array<{ name?: string | null; value?: string | null }> | null;
    } | null;
  }>;
  listLabels(): Promise<{ labels: Array<{ id?: string | null; name?: string | null }> }>;
  createLabel(options: { name: string }): Promise<{ id: string }>;
  modifyMessage(options: {
    id: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<unknown>;
  watch(options: {
    topicName: string;
  }): Promise<{ historyId?: string | null; expiration?: string | null }>;
  listHistory(cursor: string): Promise<{
    historyId?: string;
    messageIds: string[];
  }>;
}

type GmailApiFactory = (accountId: string) => Promise<GmailApi>;

export interface GmailConnectorOptions {
  clientId: string;
  clientSecret: string;
  secrets: EncryptedSecretStore;
  openExternal: (url: URL) => Promise<void>;
  now?: () => Date;
}

function tokenSecretName(accountId: string): string {
  return `gmail-token-${createHash("sha256").update(accountId).digest("hex")}`;
}

function gmailErrorFields(reason: unknown): Record<string, unknown> {
  const fields = errorFields(reason);
  if (typeof reason !== "object" || reason === null) {
    return fields;
  }
  const record = reason as {
    code?: unknown;
    status?: unknown;
    errors?: unknown;
    response?: { status?: unknown; data?: unknown };
  };
  return {
    ...fields,
    code: record.code,
    status: record.status ?? record.response?.status,
    errors: record.errors,
    responseData: record.response?.data,
  };
}

export function mergeOAuthTokens<
  TStored extends object,
  TUpdate extends object,
>(
  stored: TStored,
  update: TUpdate,
): TStored & TUpdate {
  return { ...stored, ...update };
}

export class OAuthTokenPersistence {
  private credentials: Record<string, unknown>;
  private pending: Promise<void> = Promise.resolve();

  public constructor(
    initial: Record<string, unknown>,
    private readonly persist: (
      credentials: Record<string, unknown>,
    ) => Promise<void>,
  ) {
    this.credentials = { ...initial };
  }

  public update(update: object): Promise<void> {
    this.credentials = { ...this.credentials, ...update };
    const snapshot = { ...this.credentials };
    this.pending = this.pending.then(() => this.persist(snapshot));
    return this.pending;
  }
}

function approvedGoogleAuthUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !(
      url.hostname === "accounts.google.com" ||
      url.hostname.endsWith(".accounts.google.com")
    )
  ) {
    throw new Error("Google returned an unapproved authorization URL.");
  }
  return url;
}

export class GmailConnector {
  private readonly now: () => Date;

  public constructor(private readonly options: GmailConnectorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async connect(): Promise<ProviderAccountSummary> {
    const state = randomBytes(24).toString("base64url");
    let resolveCode: (code: string) => void = () => undefined;
    let rejectCode: (reason: Error) => void = () => undefined;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (
          url.pathname !== "/oauth2/callback" ||
          url.searchParams.get("state") !== state
        ) {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end("Invalid OAuth callback.");
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (error || !code) {
          rejectCode(new Error("Google authorization was declined."));
          response.writeHead(400, { "content-type": "text/plain" });
          response.end("Authorization was not completed.");
          return;
        }
        resolveCode(code);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("Email Checker is connected. You can close this tab.");
      } catch {
        rejectCode(new Error("Invalid Google OAuth callback."));
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Invalid callback.");
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not start the Google OAuth callback.");
      }
      const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
      const oauth = new google.auth.OAuth2(
        this.options.clientId,
        this.options.clientSecret,
        redirectUri,
      );
      const authorizationUrl = approvedGoogleAuthUrl(
        oauth.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: [GMAIL_SCOPE, EMAIL_SCOPE],
          state,
        }),
      );
      await this.options.openExternal(authorizationUrl);
      const code = await codePromise;
      const { tokens } = await oauth.getToken(code);
      oauth.setCredentials(tokens);
      const profile = await google.oauth2({ version: "v2", auth: oauth }).userinfo.get();
      const email = profile.data.email;
      if (!email) {
        throw new Error("Google did not return an account email.");
      }
      const id = profile.data.id ?? email;
      await this.options.secrets.set(tokenSecretName(id), JSON.stringify(tokens));
      const accounts = await this.loadAccountIndex();
      const next = accounts.filter((account) => account.id !== id);
      next.push({
        id,
        email,
        displayName: profile.data.name ?? undefined,
      });
      await this.options.secrets.set("gmail-account-index", JSON.stringify(next));
      return {
        id,
        provider: "gmail",
        email,
        displayName: profile.data.name ?? undefined,
        health: {
          status: "connected",
          lastCheckedAt: this.now().toISOString(),
        },
      };
    } finally {
      server.close();
    }
  }

  public async listAccounts(): Promise<ProviderAccountSummary[]> {
    return (await this.loadAccountIndex()).map((account) => ({
      ...account,
      provider: "gmail",
      health: {
        status: "connected",
        lastCheckedAt: this.now().toISOString(),
      },
    }));
  }

  public async removeAccount(accountId: string): Promise<boolean> {
    const accounts = await this.loadAccountIndex();
    if (!accounts.some((account) => account.id === accountId)) {
      return false;
    }
    await this.options.secrets.delete(tokenSecretName(accountId));
    await this.options.secrets.set(
      "gmail-account-index",
      JSON.stringify(accounts.filter((account) => account.id !== accountId)),
    );
    return true;
  }

  public createAdapter(): GmailAdapter {
    return new GmailAdapter((accountId) => this.createApi(accountId));
  }

  private async loadAccountIndex() {
    const raw = await this.options.secrets.get("gmail-account-index");
    if (!raw) {
      return [];
    }
    try {
      return accountIndexSchema.parse(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  private async createApi(accountId: string): Promise<GmailApi> {
    const raw = await this.options.secrets.get(tokenSecretName(accountId));
    if (!raw) {
      logOrganizer("error", "gmail.token.missing", { accountId });
      throw new Error("Gmail account is not connected.");
    }
    logOrganizer("debug", "gmail.api.create", { accountId });
    const stored = tokenSchema.parse(JSON.parse(raw));
    const oauth = new google.auth.OAuth2(
      this.options.clientId,
      this.options.clientSecret,
    );
    oauth.setCredentials(stored);
    const tokenPersistence = new OAuthTokenPersistence(
      stored,
      async (credentials) =>
        this.options.secrets.set(
          tokenSecretName(accountId),
          JSON.stringify(credentials),
        ),
    );
    oauth.on("tokens", (tokens) => {
      void tokenPersistence.update(tokens);
    });
    const gmail = google.gmail({ version: "v1", auth: oauth });
    return {
      listMessages: async ({ unreadOnly, limit }) => {
        const response = await gmail.users.messages.list({
          userId: "me",
          maxResults: limit,
          q: unreadOnly ? "in:inbox is:unread" : "in:inbox",
        });
        return {
          messages: (response.data.messages ?? [])
            .flatMap((item) => (item.id ? [{ id: item.id }] : [])),
        };
      },
      getMessage: async (id) => {
        const response = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "Subject"],
        });
        if (!response.data.id) {
          throw new Error("Gmail returned a message without an id.");
        }
        return { ...response.data, id: response.data.id };
      },
      listLabels: async () => {
        const response = await gmail.users.labels.list({ userId: "me" });
        return { labels: response.data.labels ?? [] };
      },
      createLabel: async ({ name }) => {
        const response = await gmail.users.labels.create({
          userId: "me",
          requestBody: {
            name,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          },
        });
        if (!response.data.id) {
          throw new Error("Gmail returned a label without an id.");
        }
        return { id: response.data.id };
      },
      modifyMessage: ({ id, addLabelIds, removeLabelIds }) =>
        gmail.users.messages.modify({
          userId: "me",
          id,
          requestBody: { addLabelIds, removeLabelIds },
        }),
      watch: async ({ topicName }) => {
        const response = await gmail.users.watch({
          userId: "me",
          requestBody: { topicName, labelIds: ["INBOX"] },
        });
        return response.data;
      },
      listHistory: async (cursor) => {
        const response = await gmail.users.history.list({
          userId: "me",
          startHistoryId: cursor,
          historyTypes: ["messageAdded"],
          labelId: "INBOX",
        });
        const messageIds = new Set<string>();
        for (const history of response.data.history ?? []) {
          for (const item of history.messagesAdded ?? []) {
            if (item.message?.id) {
              messageIds.add(item.message.id);
            }
          }
        }
        return {
          historyId: response.data.historyId ?? undefined,
          messageIds: [...messageIds],
        };
      },
    };
  }
}

export class GmailAdapter implements OrganizerProviderAdapter {
  private readonly labelCache = new Map<string, string>();

  public constructor(private readonly getApi: GmailApiFactory) {}

  public async fetchMessages(
    accountId: string,
    options: { unreadOnly: boolean; limit: number },
  ): Promise<ProviderMessage[]> {
    logOrganizer("debug", "gmail.fetch.start", {
      accountId,
      unreadOnly: options.unreadOnly,
      limit: options.limit,
      query: options.unreadOnly ? "in:inbox is:unread" : "in:inbox",
    });
    try {
      const api = await this.getApi(accountId);
      const listed = await api.listMessages(options);
      logOrganizer("info", "gmail.fetch.listed", {
        accountId,
        listed: listed.messages.length,
        ids: listed.messages.map((message) => message.id),
      });
      const messages = await Promise.all(
        listed.messages.map(async ({ id }) => {
          const message = await api.getMessage(id);
          const headers = message.payload?.headers ?? [];
          const header = (name: string) =>
            headers.find(
              (item) => item.name?.toLowerCase() === name.toLowerCase(),
            )?.value ?? "";
          const labels = new Set(message.labelIds ?? []);
          return {
            id: message.id,
            sender: header("From"),
            subject: header("Subject"),
            receivedAt: new Date(Number(message.internalDate ?? 0)).toISOString(),
            bodyPreview: message.snippet ?? "",
            webUrl: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}`,
            unread: labels.has("UNREAD"),
            highImportance: labels.has("IMPORTANT"),
          };
        }),
      );
      logOrganizer("info", "gmail.fetch.ok", {
        accountId,
        returned: messages.length,
        unreadReturned: messages.filter((message) => message.unread).length,
      });
      return messages;
    } catch (reason) {
      logOrganizer("error", "gmail.fetch.failed", {
        accountId,
        unreadOnly: options.unreadOnly,
        ...gmailErrorFields(reason),
      });
      throw reason;
    }
  }

  public async moveMessage(
    accountId: string,
    messageId: string,
    rootFolder: string,
    folder: string,
  ): Promise<void> {
    const labelName = `${rootFolder}/${folder}`;
    try {
      const api = await this.getApi(accountId);
      const labelId = await this.ensureLabel(accountId, api, labelName);
      logOrganizer("debug", "gmail.move.start", {
        accountId,
        messageId,
        labelName,
        labelId,
      });
      await api.modifyMessage({
        id: messageId,
        addLabelIds: [labelId],
      });
      logOrganizer("info", "gmail.tag.ok", {
        accountId,
        messageId,
        labelName,
        labelId,
        hint: "Label applied; message stays in Inbox.",
      });
    } catch (reason) {
      logOrganizer("error", "gmail.move.failed", {
        accountId,
        messageId,
        labelName,
        ...gmailErrorFields(reason),
      });
      throw reason;
    }
  }

  public async markRead(accountId: string, messageId: string): Promise<void> {
    await (await this.getApi(accountId)).modifyMessage({
      id: messageId,
      removeLabelIds: ["UNREAD"],
    });
  }

  public async startWatch(
    accountId: string,
    topicName: string,
  ): Promise<{ cursor?: string; expiresAt?: string }> {
    const watched = await (await this.getApi(accountId)).watch({ topicName });
    return {
      cursor: watched.historyId ?? undefined,
      expiresAt: watched.expiration
        ? new Date(Number(watched.expiration)).toISOString()
        : undefined,
    };
  }

  public async refreshHistory(
    accountId: string,
    cursor: string,
    limit: number,
  ): Promise<{ cursor?: string; messageIds: string[]; fullSync: boolean }> {
    const api = await this.getApi(accountId);
    try {
      const result = await api.listHistory(cursor);
      return {
        cursor: result.historyId,
        messageIds: result.messageIds,
        fullSync: false,
      };
    } catch (reason) {
      const status =
        typeof reason === "object" && reason
          ? (reason as { code?: number; status?: number }).code ??
            (reason as { status?: number }).status
          : undefined;
      if (status !== 404) {
        throw reason;
      }
      const listed = await api.listMessages({ unreadOnly: false, limit });
      return {
        cursor: undefined,
        messageIds: listed.messages.map((message) => message.id),
        fullSync: true,
      };
    }
  }

  private async ensureLabel(
    accountId: string,
    api: GmailApi,
    name: string,
  ): Promise<string> {
    const key = `${accountId}\u0000${name}`;
    const cached = this.labelCache.get(key);
    if (cached) {
      return cached;
    }
    const existing = (await api.listLabels()).labels.find(
      (label) => label.name?.toLowerCase() === name.toLowerCase() && label.id,
    );
    const id = existing?.id ?? (await api.createLabel({ name })).id;
    if (!id) {
      throw new Error("Gmail label could not be created.");
    }
    logOrganizer(existing ? "debug" : "info", "gmail.label.ready", {
      accountId,
      name,
      labelId: id,
      created: !existing,
    });
    this.labelCache.set(key, id);
    return id;
  }
}
