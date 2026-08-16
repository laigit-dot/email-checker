export type Provider = "outlook" | "gmail";

export interface Registration {
  installationId: string;
  provider: Provider;
  accountId: string;
  providerAddress: string;
  resourceId: string;
  expiresAt: Date;
  verificationHash?: string;
}

export interface RelayPushEvent {
  version: 1;
  eventId: string;
  provider: Provider;
  accountId: string;
  kind: "mail.changed" | "subscription.lifecycle";
  occurredAt: string;
  cursor?: string;
}

export interface RegistrationStore {
  initialize(): Promise<void>;
  upsert(registration: Registration): Promise<void>;
  findOutlookByResourceId(
    resourceId: string,
    now: Date,
  ): Promise<Registration | undefined>;
  findGmailByAddress(
    providerAddress: string,
    now: Date,
  ): Promise<Registration | undefined>;
  deleteExpired(now: Date): Promise<number>;
}

export interface RelayPublisher {
  negotiate(
    installationId: string,
    expiresAt: Date,
  ): Promise<string>;
  publish(installationId: string, event: RelayPushEvent): Promise<void>;
}

export interface GoogleTokenVerifier {
  verify(token: string): Promise<void>;
}
