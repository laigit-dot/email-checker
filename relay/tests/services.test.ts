import type { TableClient } from "@azure/data-tables";
import type { OAuth2Client } from "google-auth-library";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { GoogleOidcTokenVerifier } from "../src/googleTokenVerifier.js";
import {
  authenticateRelay,
  constantTimeEqual,
  deriveInstallationId,
  sha256,
  verifySecretHash,
} from "../src/security.js";
import {
  providerLookupRowKey,
  registrationRowKey,
  TableRegistrationStore,
} from "../src/storage.js";

const validEnvironment = {
  RELAY_API_KEY: "a-long-random-relay-key",
  AzureWebJobsStorage: "UseDevelopmentStorage=true",
  WEB_PUBSUB_CONNECTION_STRING: "Endpoint=https://example;AccessKey=placeholder;",
  GOOGLE_PUBSUB_AUDIENCE: "https://relay.example/api/gmail/pubsub",
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: "push@example.iam.gserviceaccount.com",
};

describe("environment configuration", () => {
  it("loads validated defaults without exposing raw environment names", () => {
    expect(loadConfig(validEnvironment)).toEqual({
      relayApiKey: validEnvironment.RELAY_API_KEY,
      storageConnectionString: validEnvironment.AzureWebJobsStorage,
      registrationTable: "RelayRegistrations",
      webPubSubConnectionString:
        validEnvironment.WEB_PUBSUB_CONNECTION_STRING,
      webPubSubHub: "email",
      webPubSubTokenTtlMinutes: 60,
      googlePubSubAudience: validEnvironment.GOOGLE_PUBSUB_AUDIENCE,
      googlePubSubServiceAccount:
        validEnvironment.GOOGLE_PUBSUB_SERVICE_ACCOUNT,
    });
  });

  it("rejects malformed required settings and invalid table names", () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        GOOGLE_PUBSUB_AUDIENCE: "not-a-url",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment,
        RELAY_REGISTRATION_TABLE: "invalid-table-name",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment,
        RELAY_API_KEY: "short",
      }),
    ).toThrow();
  });
});

describe("security helpers", () => {
  it("derives an opaque deterministic installation ID", () => {
    const id = deriveInstallationId("relay-key");
    expect(id).toBe(sha256("relay-key"));
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id).not.toContain("relay-key");
  });

  it("uses strict bearer parsing and constant-time hash comparisons", () => {
    expect(
      authenticateRelay(
        new Headers({ authorization: "Bearer expected-key" }),
        "expected-key",
      ),
    ).toBe(true);
    expect(
      authenticateRelay(
        new Headers({ authorization: "Basic expected-key" }),
        "expected-key",
      ),
    ).toBe(false);
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different")).toBe(false);
    expect(verifySecretHash("secret", sha256("secret"))).toBe(true);
    expect(verifySecretHash("wrong", sha256("secret"))).toBe(false);
  });

  it("hashes provider lookup values and normalizes Gmail case", () => {
    const gmailUpper = providerLookupRowKey("gmail", "Owner@Gmail.com");
    const gmailLower = providerLookupRowKey("gmail", "owner@gmail.com");
    expect(gmailUpper).toBe(gmailLower);
    expect(gmailUpper).toMatch(/^[a-f0-9]{64}$/);
    expect(gmailUpper).not.toContain("gmail.com");
    expect(
      registrationRowKey({
        installationId: "install",
        provider: "gmail",
        accountId: "account",
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("Google OIDC verifier", () => {
  it("accepts only the configured verified service-account identity", async () => {
    const validClient = {
      verifyIdToken: async () => ({
        getPayload: () => ({
          email: "push@example.iam.gserviceaccount.com",
          email_verified: true,
        }),
      }),
    } as unknown as OAuth2Client;
    const verifier = new GoogleOidcTokenVerifier(
      "https://relay.example/api/gmail/pubsub",
      "push@example.iam.gserviceaccount.com",
      validClient,
    );
    await expect(verifier.verify("signed-token")).resolves.toBeUndefined();

    const wrongIdentityClient = {
      verifyIdToken: async () => ({
        getPayload: () => ({
          email: "attacker@example.iam.gserviceaccount.com",
          email_verified: true,
        }),
      }),
    } as unknown as OAuth2Client;
    const wrongIdentityVerifier = new GoogleOidcTokenVerifier(
      "https://relay.example/api/gmail/pubsub",
      "push@example.iam.gserviceaccount.com",
      wrongIdentityClient,
    );
    await expect(
      wrongIdentityVerifier.verify("signed-token"),
    ).rejects.toThrow("not authorized");
  });
});

describe("Table registration storage", () => {
  it("uses hashed indexes, replaces renewals, and cleans expired rows offline", async () => {
    const entities = new Map<string, Record<string, unknown>>();
    let createCalls = 0;
    const key = (partitionKey: string, rowKey: string) =>
      `${partitionKey}/${rowKey}`;
    const fakeClient = {
      createTable: async () => {
        createCalls += 1;
      },
      upsertEntity: async (entity: {
        partitionKey: string;
        rowKey: string;
      }) => {
        entities.set(
          key(entity.partitionKey, entity.rowKey),
          structuredClone(entity),
        );
      },
      getEntity: async (partitionKey: string, rowKey: string) => {
        const entity = entities.get(key(partitionKey, rowKey));
        if (!entity) {
          throw { statusCode: 404 };
        }
        return structuredClone(entity);
      },
      deleteEntity: async (partitionKey: string, rowKey: string) => {
        if (!entities.delete(key(partitionKey, rowKey))) {
          throw { statusCode: 404 };
        }
      },
      listEntities: () => ({
        async *[Symbol.asyncIterator]() {
          for (const entity of entities.values()) {
            yield structuredClone(entity);
          }
        },
      }),
    } as unknown as TableClient;
    const store = new TableRegistrationStore(
      "not-used",
      "RelayRegistrations",
      fakeClient,
    );
    await store.initialize();
    expect(createCalls).toBe(1);

    const original = {
      installationId: "installation",
      provider: "outlook" as const,
      accountId: "account",
      providerAddress: "owner@contoso.com",
      resourceId: "subscription-original",
      expiresAt: new Date("2026-08-12T00:00:00.000Z"),
      verificationHash: sha256("graph-secret"),
    };
    await store.upsert(original);
    const serializedRows = JSON.stringify([...entities.keys()]);
    expect(serializedRows).not.toContain(original.resourceId);
    expect(serializedRows).not.toContain(original.providerAddress);
    await expect(
      store.findOutlookByResourceId(
        original.resourceId,
        new Date("2026-08-11T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      accountId: "account",
      verificationHash: sha256("graph-secret"),
    });

    await store.upsert({
      ...original,
      resourceId: "subscription-renewed",
    });
    await expect(
      store.findOutlookByResourceId(
        original.resourceId,
        new Date("2026-08-11T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.findOutlookByResourceId(
        "subscription-renewed",
        new Date("2026-08-11T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ accountId: "account" });

    await expect(
      store.deleteExpired(new Date("2026-08-13T00:00:00.000Z")),
    ).resolves.toBe(1);
    expect(entities.size).toBe(0);
  });
});
