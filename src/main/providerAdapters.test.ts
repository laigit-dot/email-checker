import { describe, expect, it, vi } from "vitest";
import type { TokenCacheContext } from "@azure/msal-node";

import {
  GmailAdapter,
  mergeOAuthTokens,
  OAuthTokenPersistence,
  type GmailApi,
} from "./services/gmailConnector";
import {
  EncryptedMsalCachePlugin,
  OutlookGraphAdapter,
} from "./services/outlookConnector";
import type { EncryptedSecretStore } from "./services/secretStore";

describe("provider adapters", () => {
  it("retains the Gmail refresh token when refreshed credentials are persisted", () => {
    expect(
      mergeOAuthTokens(
        { refresh_token: "refresh", access_token: "old" },
        { access_token: "new", expiry_date: 123 },
      ),
    ).toEqual({
      refresh_token: "refresh",
      access_token: "new",
      expiry_date: 123,
    });
  });

  it("merges repeated Gmail token events into the latest persisted credentials", async () => {
    const persist = vi.fn(async () => undefined);
    const persistence = new OAuthTokenPersistence(
      { refresh_token: "refresh", access_token: "old" },
      persist,
    );

    await persistence.update({ access_token: "access-1", expiry_date: 100 });
    await persistence.update({ access_token: "access-2", scope: "gmail.modify" });

    expect(persist).toHaveBeenLastCalledWith({
      refresh_token: "refresh",
      access_token: "access-2",
      expiry_date: 100,
      scope: "gmail.modify",
    });
  });

  it("loads and persists the serialized MSAL cache through encrypted storage", async () => {
    const secrets = {
      get: vi.fn(async () => "encrypted-cache-value"),
      set: vi.fn(async () => undefined),
    } as unknown as EncryptedSecretStore;
    const deserialize = vi.fn();
    const context = {
      cacheHasChanged: true,
      tokenCache: {
        deserialize,
        serialize: () => "next-cache-value",
      },
    } as unknown as TokenCacheContext;
    const plugin = new EncryptedMsalCachePlugin(secrets);

    await plugin.beforeCacheAccess(context);
    await plugin.afterCacheAccess(context);

    expect(deserialize).toHaveBeenCalledWith("encrypted-cache-value");
    expect(secrets.set).toHaveBeenCalledWith(
      "outlook-msal-cache",
      "next-cache-value",
    );
  });

  it("maps Graph inbox fields without exposing message bodies", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          value: [
            {
              id: "graph-1",
              from: { emailAddress: { address: "sender@example.com" } },
              subject: "Important",
              receivedDateTime: "2026-08-11T12:00:00.000Z",
              importance: "high",
              isRead: false,
              webLink: "https://outlook.office.com/mail/deeplink/read/graph-1",
              bodyPreview: "Preview only",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new OutlookGraphAdapter(
      async () => "access-token",
      fetch,
    );

    await expect(
      adapter.fetchMessages("account-1", { unreadOnly: true, limit: 20 }),
    ).resolves.toEqual([
      {
        id: "graph-1",
        sender: "sender@example.com",
        subject: "Important",
        receivedAt: "2026-08-11T12:00:00.000Z",
        bodyPreview: "Preview only",
        webUrl: "https://outlook.office.com/mail/deeplink/read/graph-1",
        unread: true,
        highImportance: true,
      },
    ]);
    const requestUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("prefer")).toBe('IdType="ImmutableId"');
    expect(requestUrl.searchParams.get("$select")).toContain("bodyPreview");
    expect(requestUrl.searchParams.get("$filter")).toBe(
      "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false",
    );
  });

  it("includes the Graph error body when inbox listing fails", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "InefficientFilter",
            message: "The restriction or sort order is too complex.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new OutlookGraphAdapter(async () => "access-token", fetch);

    await expect(
      adapter.fetchMessages("account-1", { unreadOnly: true, limit: 20 }),
    ).rejects.toThrow(/400.*InefficientFilter|too complex/i);
  });

  it("creates Outlook folders under Inbox and moves the message there", async () => {
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (path.includes("/me/mailFolders/inbox/childFolders") && method === "GET") {
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.includes("/me/mailFolders/inbox/childFolders") && method === "POST") {
        return new Response(
          JSON.stringify({ id: "inbox-root", displayName: "AI Organized" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (path.includes("/mailFolders/inbox-root/childFolders") && method === "GET") {
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.includes("/mailFolders/inbox-root/childFolders") && method === "POST") {
        return new Response(
          JSON.stringify({ id: "inbox-child", displayName: "Receipts" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (path.includes("/move") && method === "POST") {
        return new Response(JSON.stringify({ id: "moved-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(path, { status: 500 });
    });
    const adapter = new OutlookGraphAdapter(async () => "access-token", fetch);

    await adapter.moveMessage(
      "account-1",
      "graph-1",
      "AI Organized",
      "Receipts",
    );

    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/me/mailFolders/inbox/childFolders"))).toBe(
      true,
    );
    expect(urls.some((url) => url.includes("/me/mailFolders?"))).toBe(false);
    const moveCall = fetch.mock.calls.find((call) =>
      String(call[0]).includes("/move"),
    );
    expect(JSON.parse(String(moveCall?.[1]?.body))).toEqual({
      destinationId: "inbox-child",
    });
  });

  it("maps Gmail metadata and applies organization labels", async () => {
    const modify = vi.fn(async () => ({ data: {} }));
    const api: GmailApi = {
      listMessages: vi.fn(async () => ({ messages: [{ id: "gmail-1" }] })),
      getMessage: vi.fn(async () => ({
        id: "gmail-1",
        internalDate: "1786459200000",
        labelIds: ["INBOX", "UNREAD"],
        snippet: "Preview only",
        payload: {
          headers: [
            { name: "From", value: "sender@example.com" },
            { name: "Subject", value: "A subject" },
          ],
        },
      })),
      listLabels: vi.fn(async () => ({ labels: [] })),
      createLabel: vi.fn(async ({ name }) => ({ id: `label:${name}` })),
      modifyMessage: modify,
      watch: vi.fn(async () => ({ historyId: "42", expiration: "1000" })),
      listHistory: vi.fn(async () => ({ historyId: "43", messageIds: [] })),
    };
    const adapter = new GmailAdapter(async () => api);

    const messages = await adapter.fetchMessages("account-1", {
      unreadOnly: true,
      limit: 10,
    });
    await adapter.moveMessage(
      "account-1",
      "gmail-1",
      "AI Organized",
      "Receipts",
    );

    expect(messages[0]).toMatchObject({
      id: "gmail-1",
      sender: "sender@example.com",
      subject: "A subject",
      unread: true,
      highImportance: false,
      webUrl: "https://mail.google.com/mail/u/0/#all/gmail-1",
    });
    expect(modify).toHaveBeenCalledWith({
      id: "gmail-1",
      addLabelIds: ["label:AI Organized/Receipts"],
    });
  });

  it("falls back to a full Gmail sync when a history cursor is stale", async () => {
    const api: GmailApi = {
      listMessages: vi.fn(async () => ({ messages: [{ id: "fresh" }] })),
      getMessage: vi.fn(),
      listLabels: vi.fn(),
      createLabel: vi.fn(),
      modifyMessage: vi.fn(),
      watch: vi.fn(),
      listHistory: vi.fn(async () => {
        throw Object.assign(new Error("stale"), { code: 404 });
      }),
    };
    const adapter = new GmailAdapter(async () => api);

    await expect(adapter.refreshHistory("account-1", "old", 25)).resolves.toEqual({
      cursor: undefined,
      messageIds: ["fresh"],
      fullSync: true,
    });
  });
});
