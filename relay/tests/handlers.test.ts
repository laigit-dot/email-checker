import { describe, expect, it } from "vitest";

import type {
  GoogleTokenVerifier,
  Registration,
  RegistrationStore,
  RelayPublisher,
  RelayPushEvent,
} from "../src/contracts.js";
import {
  createRelayHandlers,
  type RelayHttpRequest,
} from "../src/handlers.js";
import { deriveInstallationId, sha256 } from "../src/security.js";

const relayApiKey = "relay-test-key-with-enough-entropy";
const fixedNow = new Date("2026-08-11T15:00:00.000Z");
const future = "2026-08-12T15:00:00.000Z";

class MemoryStore implements RegistrationStore {
  public registrations: Registration[] = [];

  public async initialize(): Promise<void> {}

  public async upsert(registration: Registration): Promise<void> {
    this.registrations = this.registrations.filter(
      (item) =>
        !(
          item.installationId === registration.installationId &&
          item.provider === registration.provider &&
          item.accountId === registration.accountId
        ),
    );
    this.registrations.push(structuredClone(registration));
  }

  public async findOutlookByResourceId(
    resourceId: string,
    now: Date,
  ): Promise<Registration | undefined> {
    return this.registrations.find(
      (item) =>
        item.provider === "outlook" &&
        item.resourceId === resourceId &&
        item.expiresAt > now,
    );
  }

  public async findGmailByAddress(
    providerAddress: string,
    now: Date,
  ): Promise<Registration | undefined> {
    const normalized = providerAddress.toLowerCase();
    return this.registrations.find(
      (item) =>
        item.provider === "gmail" &&
        item.providerAddress.toLowerCase() === normalized &&
        item.expiresAt > now,
    );
  }

  public async deleteExpired(now: Date): Promise<number> {
    const expired = this.registrations.filter(
      (registration) => registration.expiresAt <= now,
    );
    this.registrations = this.registrations.filter(
      (registration) => registration.expiresAt > now,
    );
    return expired.length;
  }
}

class FakePublisher implements RelayPublisher {
  public negotiationUrl =
    "wss://example.webpubsub.azure.com/client/hubs/email?access_token=signed";
  public negotiated: Array<{ installationId: string; expiresAt: Date }> = [];
  public published: Array<{
    installationId: string;
    event: RelayPushEvent;
  }> = [];
  public failNegotiation = false;
  public failPublishing = false;

  public async negotiate(
    installationId: string,
    expiresAt: Date,
  ): Promise<string> {
    if (this.failNegotiation) {
      throw new Error("offline");
    }
    this.negotiated.push({ installationId, expiresAt });
    return this.negotiationUrl;
  }

  public async publish(
    installationId: string,
    event: RelayPushEvent,
  ): Promise<void> {
    if (this.failPublishing) {
      throw new Error("offline");
    }
    this.published.push({ installationId, event });
  }
}

class FakeGoogleVerifier implements GoogleTokenVerifier {
  public tokens: string[] = [];
  public reject = false;

  public async verify(token: string): Promise<void> {
    this.tokens.push(token);
    if (this.reject) {
      throw new Error("invalid");
    }
  }
}

function request(
  body: unknown,
  options: {
    authorization?: string;
    query?: string;
    invalidJson?: boolean;
  } = {},
): RelayHttpRequest {
  return {
    headers: new Headers(
      options.authorization
        ? { authorization: options.authorization }
        : undefined,
    ),
    query: new URLSearchParams(options.query),
    json: options.invalidJson
      ? async () => {
          throw new Error("invalid json");
        }
      : async () => body,
  };
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function createFixture() {
  const store = new MemoryStore();
  const publisher = new FakePublisher();
  const googleTokenVerifier = new FakeGoogleVerifier();
  let sequence = 0;
  const handlers = createRelayHandlers({
    relayApiKey,
    webPubSubTokenTtlMinutes: 30,
    store,
    publisher,
    googleTokenVerifier,
    now: () => new Date(fixedNow),
    eventId: () => `event-${++sequence}`,
  });
  return { handlers, store, publisher, googleTokenVerifier };
}

async function addOutlook(store: MemoryStore): Promise<Registration> {
  const registration: Registration = {
    installationId: deriveInstallationId(relayApiKey),
    provider: "outlook",
    accountId: "outlook-account",
    providerAddress: "owner@contoso.com",
    resourceId: "subscription-1",
    expiresAt: new Date(future),
    verificationHash: sha256("graph-secret"),
  };
  await store.upsert(registration);
  return registration;
}

async function addGmail(store: MemoryStore): Promise<Registration> {
  const registration: Registration = {
    installationId: deriveInstallationId(relayApiKey),
    provider: "gmail",
    accountId: "gmail-account",
    providerAddress: "Owner@Gmail.com",
    resourceId: "history-start",
    expiresAt: new Date(future),
  };
  await store.upsert(registration);
  return registration;
}

describe("desktop authentication and negotiation", () => {
  it("rejects missing and incorrect bearer credentials", async () => {
    const { handlers } = createFixture();
    expect((await handlers.negotiate(request({ version: 1 }))).status).toBe(
      401,
    );
    expect(
      (
        await handlers.negotiate(
          request(
            { version: 1 },
            { authorization: "Bearer incorrect-relay-key" },
          ),
        )
      ).status,
    ).toBe(401);
  });

  it("returns a signed URL for the deterministic installation ID", async () => {
    const { handlers, publisher } = createFixture();
    const response = await handlers.negotiate(
      request(
        { version: 1 },
        { authorization: `Bearer ${relayApiKey}` },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      version: 1,
      webSocketUrl: publisher.negotiationUrl,
      expiresAt: "2026-08-11T15:30:00.000Z",
    });
    expect(publisher.negotiated).toEqual([
      {
        installationId: deriveInstallationId(relayApiKey),
        expiresAt: new Date("2026-08-11T15:30:00.000Z"),
      },
    ]);
  });

  it("rejects unknown request fields and hides publisher errors", async () => {
    const { handlers, publisher } = createFixture();
    const extra = await handlers.negotiate(
      request(
        { version: 1, extra: true },
        { authorization: `Bearer ${relayApiKey}` },
      ),
    );
    expect(extra).toMatchObject({
      status: 400,
      jsonBody: { error: "bad_request" },
    });

    publisher.failNegotiation = true;
    const failed = await handlers.negotiate(
      request(
        { version: 1 },
        { authorization: `Bearer ${relayApiKey}` },
      ),
    );
    expect(failed).toMatchObject({
      status: 503,
      jsonBody: { error: "service_unavailable" },
    });
  });
});

describe("desktop registration", () => {
  it("requires and hashes the Outlook verification secret", async () => {
    const { handlers, store } = createFixture();
    const missingSecret = await handlers.register(
      request(
        {
          version: 1,
          provider: "outlook",
          accountId: "account",
          providerAddress: "owner@contoso.com",
          resourceId: "subscription",
          expiresAt: future,
        },
        { authorization: `Bearer ${relayApiKey}` },
      ),
    );
    expect(missingSecret.status).toBe(400);

    const response = await handlers.register(
      request(
        {
          version: 1,
          provider: "outlook",
          accountId: "account",
          providerAddress: "owner@contoso.com",
          resourceId: "subscription",
          expiresAt: future,
          verificationSecret: "secret-value",
        },
        { authorization: `Bearer ${relayApiKey}` },
      ),
    );
    expect(response).toMatchObject({ status: 200, jsonBody: { ok: true } });
    expect(store.registrations[0]).toMatchObject({
      installationId: deriveInstallationId(relayApiKey),
      verificationHash: sha256("secret-value"),
    });
    expect(JSON.stringify(store.registrations[0])).not.toContain(
      "secret-value",
    );
  });

  it("rejects a Gmail secret, expired registrations, and malformed JSON", async () => {
    const { handlers } = createFixture();
    const base = {
      version: 1,
      provider: "gmail",
      accountId: "account",
      providerAddress: "owner@gmail.com",
      resourceId: "history",
      expiresAt: future,
    };
    expect(
      (
        await handlers.register(
          request(
            { ...base, verificationSecret: "not-allowed" },
            { authorization: `Bearer ${relayApiKey}` },
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handlers.register(
          request(
            { ...base, expiresAt: "2026-08-10T15:00:00.000Z" },
            { authorization: `Bearer ${relayApiKey}` },
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handlers.register(
          request(undefined, {
            authorization: `Bearer ${relayApiKey}`,
            invalidJson: true,
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("Microsoft Graph webhooks", () => {
  it("echoes the decoded validation token as plain text", async () => {
    const { handlers } = createFixture();
    const response = await handlers.outlookNotifications(
      request(undefined, {
        query: "validationToken=hello%20Graph%2Btoken",
        invalidJson: true,
      }),
    );
    expect(response).toEqual({
      status: 200,
      body: "hello Graph+token",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  it("routes valid clientState to the registered account", async () => {
    const { handlers, store, publisher } = createFixture();
    const registration = await addOutlook(store);
    const response = await handlers.outlookNotifications(
      request({
        value: [
          {
            subscriptionId: "subscription-1",
            clientState: "graph-secret",
            changeType: "updated",
          },
        ],
      }),
    );
    expect(response.status).toBe(202);
    expect(publisher.published).toEqual([
      {
        installationId: registration.installationId,
        event: {
          version: 1,
          eventId: "event-1",
          provider: "outlook",
          accountId: "outlook-account",
          kind: "mail.changed",
          occurredAt: fixedNow.toISOString(),
        },
      },
    ]);
  });

  it("emits lifecycle events and never forwards invalid clientState", async () => {
    const { handlers, store, publisher } = createFixture();
    await addOutlook(store);
    const invalid = await handlers.outlookLifecycle(
      request({
        value: [
          {
            subscriptionId: "subscription-1",
            clientState: "wrong-secret",
            lifecycleEvent: "reauthorizationRequired",
          },
        ],
      }),
    );
    expect(invalid.status).toBe(403);
    expect(publisher.published).toHaveLength(0);

    const valid = await handlers.outlookLifecycle(
      request({
        value: [
          {
            subscriptionId: "subscription-1",
            clientState: "graph-secret",
            lifecycleEvent: "reauthorizationRequired",
          },
        ],
      }),
    );
    expect(valid.status).toBe(202);
    expect(publisher.published[0]?.event.kind).toBe(
      "subscription.lifecycle",
    );
  });

  it("acknowledges unknown subscriptions and retries publisher failures", async () => {
    const { handlers, store, publisher } = createFixture();
    expect(
      (
        await handlers.outlookNotifications(
          request({
            value: [
              { subscriptionId: "unknown", clientState: "anything" },
            ],
          }),
        )
      ).status,
    ).toBe(202);

    await addOutlook(store);
    publisher.failPublishing = true;
    const failed = await handlers.outlookNotifications(
      request({
        value: [
          {
            subscriptionId: "subscription-1",
            clientState: "graph-secret",
          },
        ],
      }),
    );
    expect(failed.status).toBe(503);
  });
});

describe("Gmail Pub/Sub", () => {
  it("verifies OIDC before routing case-insensitively with history cursor", async () => {
    const { handlers, store, publisher, googleTokenVerifier } =
      createFixture();
    const registration = await addGmail(store);
    const response = await handlers.gmailPubSub(
      request(
        {
          message: {
            data: encoded({
              emailAddress: "owner@gmail.COM",
              historyId: "987654321",
            }),
            messageId: "pubsub-message-1",
          },
          subscription: "projects/project/subscriptions/email-push",
        },
        { authorization: "Bearer google-oidc-token" },
      ),
    );

    expect(response.status).toBe(204);
    expect(googleTokenVerifier.tokens).toEqual(["google-oidc-token"]);
    expect(publisher.published).toEqual([
      {
        installationId: registration.installationId,
        event: {
          version: 1,
          eventId: "pubsub-message-1",
          provider: "gmail",
          accountId: "gmail-account",
          kind: "mail.changed",
          occurredAt: fixedNow.toISOString(),
          cursor: "987654321",
        },
      },
    ]);
  });

  it("rejects failed OIDC and malformed base64 without looking up mail", async () => {
    const { handlers, publisher, googleTokenVerifier } = createFixture();
    googleTokenVerifier.reject = true;
    const unauthorizedResponse = await handlers.gmailPubSub(
      request(
        { message: { data: encoded({ emailAddress: "x@y.com", historyId: "1" }) } },
        { authorization: "Bearer rejected-token" },
      ),
    );
    expect(unauthorizedResponse.status).toBe(401);

    googleTokenVerifier.reject = false;
    const malformed = await handlers.gmailPubSub(
      request(
        { message: { data: "not+canonical" } },
        { authorization: "Bearer valid-token" },
      ),
    );
    expect(malformed.status).toBe(400);
    expect(publisher.published).toHaveLength(0);
  });

  it("acknowledges unknown valid registrations without a retry storm", async () => {
    const { handlers, publisher } = createFixture();
    const response = await handlers.gmailPubSub(
      request(
        {
          message: {
            data: encoded({
              emailAddress: "unknown@gmail.com",
              historyId: "100",
            }),
          },
        },
        { authorization: "Bearer valid-google-token" },
      ),
    );
    expect(response).toEqual({ status: 204 });
    expect(publisher.published).toHaveLength(0);
  });

  it("returns a retryable error when publishing fails", async () => {
    const { handlers, store, publisher } = createFixture();
    await addGmail(store);
    publisher.failPublishing = true;
    const response = await handlers.gmailPubSub(
      request(
        {
          message: {
            data: encoded({
              emailAddress: "owner@gmail.com",
              historyId: "101",
            }),
          },
        },
        { authorization: "Bearer valid-google-token" },
      ),
    );
    expect(response).toMatchObject({
      status: 503,
      jsonBody: { error: "service_unavailable" },
    });
  });
});

describe("health and cleanup", () => {
  it("reports health and removes only expired registrations", async () => {
    const { handlers, store } = createFixture();
    await store.upsert({
      installationId: "installation",
      provider: "gmail",
      accountId: "expired",
      providerAddress: "expired@gmail.com",
      resourceId: "old",
      expiresAt: new Date("2026-08-11T14:59:59.000Z"),
    });
    await addGmail(store);

    expect(handlers.health()).toMatchObject({
      status: 200,
      jsonBody: {
        ok: true,
        version: 1,
        time: fixedNow.toISOString(),
      },
    });
    await expect(handlers.cleanup()).resolves.toBe(1);
    expect(store.registrations.map((item) => item.accountId)).toEqual([
      "gmail-account",
    ]);
  });
});
