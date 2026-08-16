import { randomUUID } from "node:crypto";

import type { HttpResponseInit } from "@azure/functions";
import { z } from "zod";

import type {
  GoogleTokenVerifier,
  Registration,
  RegistrationStore,
  RelayPublisher,
  RelayPushEvent,
} from "./contracts.js";
import {
  authenticateRelay,
  deriveInstallationId,
  extractBearerToken,
  sha256,
  verifySecretHash,
} from "./security.js";

export interface RelayHttpRequest {
  headers: Headers;
  query: URLSearchParams;
  json(): Promise<unknown>;
}

export interface RelayHandlerDependencies {
  relayApiKey: string;
  webPubSubTokenTtlMinutes: number;
  store: RegistrationStore;
  publisher: RelayPublisher;
  googleTokenVerifier: GoogleTokenVerifier;
  now?: () => Date;
  eventId?: () => string;
}

const negotiateSchema = z.object({ version: z.literal(1) }).strict();

const timestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const registrationSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(["outlook", "gmail"]),
    accountId: z.string().trim().min(1).max(500),
    providerAddress: z.string().trim().email().max(320),
    resourceId: z.string().trim().min(1).max(2_000),
    expiresAt: timestampSchema,
    verificationSecret: z.string().min(1).max(2_048).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === "outlook" && !value.verificationSecret) {
      context.addIssue({
        code: "custom",
        path: ["verificationSecret"],
        message: "Outlook requires a verification secret.",
      });
    }
    if (value.provider === "gmail" && value.verificationSecret !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["verificationSecret"],
        message: "Gmail must omit the verification secret.",
      });
    }
  });

const graphNotificationSchema = z
  .object({
    subscriptionId: z.string().min(1).max(2_000),
    clientState: z.string().max(2_048).optional(),
    lifecycleEvent: z.string().max(200).optional(),
    changeType: z.string().max(200).optional(),
    resource: z.string().max(4_000).optional(),
    tenantId: z.string().max(500).optional(),
    subscriptionExpirationDateTime: z
      .string()
      .datetime({ offset: true })
      .optional(),
    resourceData: z.unknown().optional(),
    encryptedContent: z.unknown().optional(),
  })
  .strict();

const graphBodySchema = z
  .object({
    value: z.array(graphNotificationSchema).min(1).max(1_000),
  })
  .strict();

const pubSubMessageSchema = z
  .object({
    data: z.string().min(1).max(1_000_000),
    messageId: z.string().min(1).max(200).optional(),
    publishTime: z.string().datetime({ offset: true }).optional(),
    orderingKey: z.string().max(1_024).optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const pubSubBodySchema = z
  .object({
    message: pubSubMessageSchema,
    subscription: z.string().max(2_000).optional(),
    deliveryAttempt: z.number().int().positive().optional(),
  })
  .strict();

const gmailDataSchema = z
  .object({
    emailAddress: z.string().trim().email().max(320),
    historyId: z.string().min(1).max(200),
  })
  .strict();

function json(status: number, jsonBody: unknown): HttpResponseInit {
  return {
    status,
    jsonBody,
    headers: { "cache-control": "no-store" },
  };
}

function badRequest(): HttpResponseInit {
  return json(400, { error: "bad_request" });
}

function unauthorized(): HttpResponseInit {
  return json(401, { error: "unauthorized" });
}

function forbidden(): HttpResponseInit {
  return json(403, { error: "forbidden" });
}

function unavailable(): HttpResponseInit {
  return json(503, { error: "service_unavailable" });
}

async function readJson(request: RelayHttpRequest): Promise<
  | { ok: true; value: unknown }
  | { ok: false }
> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

function decodeBase64Json(value: string): unknown {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("Invalid base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Non-canonical base64.");
  }
  return JSON.parse(decoded.toString("utf8")) as unknown;
}

export function createRelayHandlers(dependencies: RelayHandlerDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const eventId = dependencies.eventId ?? randomUUID;
  const installationId = deriveInstallationId(dependencies.relayApiKey);

  async function negotiate(
    request: RelayHttpRequest,
  ): Promise<HttpResponseInit> {
    if (!authenticateRelay(request.headers, dependencies.relayApiKey)) {
      return unauthorized();
    }
    const body = await readJson(request);
    if (!body.ok || !negotiateSchema.safeParse(body.value).success) {
      return badRequest();
    }

    const expiresAt = new Date(
      now().getTime() + dependencies.webPubSubTokenTtlMinutes * 60_000,
    );
    try {
      const webSocketUrl = await dependencies.publisher.negotiate(
        installationId,
        expiresAt,
      );
      return json(200, {
        version: 1,
        webSocketUrl,
        expiresAt: expiresAt.toISOString(),
      });
    } catch {
      return unavailable();
    }
  }

  async function register(
    request: RelayHttpRequest,
  ): Promise<HttpResponseInit> {
    if (!authenticateRelay(request.headers, dependencies.relayApiKey)) {
      return unauthorized();
    }
    const body = await readJson(request);
    const parsed = body.ok
      ? registrationSchema.safeParse(body.value)
      : { success: false as const };
    if (!parsed.success || parsed.data.expiresAt <= now()) {
      return badRequest();
    }

    const registration: Registration = {
      installationId,
      provider: parsed.data.provider,
      accountId: parsed.data.accountId,
      providerAddress: parsed.data.providerAddress,
      resourceId: parsed.data.resourceId,
      expiresAt: parsed.data.expiresAt,
      ...(parsed.data.verificationSecret
        ? { verificationHash: sha256(parsed.data.verificationSecret) }
        : {}),
    };
    try {
      await dependencies.store.upsert(registration);
      return json(200, { ok: true });
    } catch {
      return unavailable();
    }
  }

  async function processGraph(
    request: RelayHttpRequest,
    kind: RelayPushEvent["kind"],
  ): Promise<HttpResponseInit> {
    if (request.query.has("validationToken")) {
      return {
        status: 200,
        body: request.query.get("validationToken") ?? "",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      };
    }

    const body = await readJson(request);
    const parsed = body.ok
      ? graphBodySchema.safeParse(body.value)
      : { success: false as const };
    if (!parsed.success) {
      return badRequest();
    }

    try {
      const routed: Registration[] = [];
      for (const item of parsed.data.value) {
        const registration =
          await dependencies.store.findOutlookByResourceId(
            item.subscriptionId,
            now(),
          );
        if (!registration) {
          continue;
        }
        if (
          !item.clientState ||
          !registration.verificationHash ||
          !verifySecretHash(item.clientState, registration.verificationHash)
        ) {
          return forbidden();
        }
        routed.push(registration);
      }

      const occurredAt = now().toISOString();
      for (const registration of routed) {
        await dependencies.publisher.publish(registration.installationId, {
          version: 1,
          eventId: eventId(),
          provider: "outlook",
          accountId: registration.accountId,
          kind,
          occurredAt,
        });
      }
      return json(202, { ok: true });
    } catch {
      return unavailable();
    }
  }

  async function outlookNotifications(
    request: RelayHttpRequest,
  ): Promise<HttpResponseInit> {
    return processGraph(request, "mail.changed");
  }

  async function outlookLifecycle(
    request: RelayHttpRequest,
  ): Promise<HttpResponseInit> {
    return processGraph(request, "subscription.lifecycle");
  }

  async function gmailPubSub(
    request: RelayHttpRequest,
  ): Promise<HttpResponseInit> {
    const token = extractBearerToken(request.headers);
    if (!token) {
      return unauthorized();
    }
    try {
      await dependencies.googleTokenVerifier.verify(token);
    } catch {
      return unauthorized();
    }

    const body = await readJson(request);
    const parsed = body.ok
      ? pubSubBodySchema.safeParse(body.value)
      : { success: false as const };
    if (!parsed.success) {
      return badRequest();
    }

    let gmailData: z.infer<typeof gmailDataSchema>;
    try {
      gmailData = gmailDataSchema.parse(
        decodeBase64Json(parsed.data.message.data),
      );
    } catch {
      return badRequest();
    }

    try {
      const registration = await dependencies.store.findGmailByAddress(
        gmailData.emailAddress,
        now(),
      );
      if (!registration) {
        return { status: 204 };
      }
      await dependencies.publisher.publish(registration.installationId, {
        version: 1,
        eventId: parsed.data.message.messageId ?? eventId(),
        provider: "gmail",
        accountId: registration.accountId,
        kind: "mail.changed",
        occurredAt: now().toISOString(),
        cursor: gmailData.historyId,
      });
      return { status: 204 };
    } catch {
      return unavailable();
    }
  }

  function health(): HttpResponseInit {
    return json(200, {
      ok: true,
      version: 1,
      time: now().toISOString(),
    });
  }

  async function cleanup(): Promise<number> {
    return dependencies.store.deleteExpired(now());
  }

  return {
    negotiate,
    register,
    outlookNotifications,
    outlookLifecycle,
    gmailPubSub,
    health,
    cleanup,
  };
}

export type RelayHandlers = ReturnType<typeof createRelayHandlers>;
