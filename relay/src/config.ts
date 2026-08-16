import { z } from "zod";

const environmentSchema = z
  .object({
    RELAY_API_KEY: z.string().min(16),
    AzureWebJobsStorage: z.string().min(1),
    RELAY_REGISTRATION_TABLE: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/)
      .default("RelayRegistrations"),
    WEB_PUBSUB_CONNECTION_STRING: z.string().min(1),
    WEB_PUBSUB_HUB: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/)
      .default("email"),
    WEB_PUBSUB_TOKEN_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1440)
      .default(60),
    GOOGLE_PUBSUB_AUDIENCE: z.string().url(),
    GOOGLE_PUBSUB_SERVICE_ACCOUNT: z.string().email(),
  })
  .strict();

export interface RelayConfig {
  relayApiKey: string;
  storageConnectionString: string;
  registrationTable: string;
  webPubSubConnectionString: string;
  webPubSubHub: string;
  webPubSubTokenTtlMinutes: number;
  googlePubSubAudience: string;
  googlePubSubServiceAccount: string;
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  const parsed = environmentSchema.parse({
    RELAY_API_KEY: source.RELAY_API_KEY,
    AzureWebJobsStorage: source.AzureWebJobsStorage,
    RELAY_REGISTRATION_TABLE: source.RELAY_REGISTRATION_TABLE,
    WEB_PUBSUB_CONNECTION_STRING: source.WEB_PUBSUB_CONNECTION_STRING,
    WEB_PUBSUB_HUB: source.WEB_PUBSUB_HUB,
    WEB_PUBSUB_TOKEN_TTL_MINUTES: source.WEB_PUBSUB_TOKEN_TTL_MINUTES,
    GOOGLE_PUBSUB_AUDIENCE: source.GOOGLE_PUBSUB_AUDIENCE,
    GOOGLE_PUBSUB_SERVICE_ACCOUNT: source.GOOGLE_PUBSUB_SERVICE_ACCOUNT,
  });

  return {
    relayApiKey: parsed.RELAY_API_KEY,
    storageConnectionString: parsed.AzureWebJobsStorage,
    registrationTable: parsed.RELAY_REGISTRATION_TABLE,
    webPubSubConnectionString: parsed.WEB_PUBSUB_CONNECTION_STRING,
    webPubSubHub: parsed.WEB_PUBSUB_HUB,
    webPubSubTokenTtlMinutes: parsed.WEB_PUBSUB_TOKEN_TTL_MINUTES,
    googlePubSubAudience: parsed.GOOGLE_PUBSUB_AUDIENCE,
    googlePubSubServiceAccount:
      parsed.GOOGLE_PUBSUB_SERVICE_ACCOUNT.toLowerCase(),
  };
}
