import { TableClient, type TableEntity } from "@azure/data-tables";

import type {
  Provider,
  Registration,
  RegistrationStore,
} from "./contracts.js";
import { sha256 } from "./security.js";

const registrationPartition = "registration";

interface StoredRegistration {
  kind: "registration";
  installationId: string;
  provider: Provider;
  accountId: string;
  providerAddress: string;
  providerAddressHash: string;
  resourceId: string;
  resourceIdHash: string;
  expiresAt: Date;
  verificationHash?: string;
}

interface StoredLookup {
  kind: "lookup";
  registrationRowKey: string;
  expiresAt: Date;
}

type StoredEntity = StoredRegistration | StoredLookup;

function isStatus(error: unknown, statusCode: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === statusCode
  );
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function registrationRowKey(registration: {
  installationId: string;
  provider: Provider;
  accountId: string;
}): string {
  return sha256(
    `${registration.installationId}\u0000${registration.provider}\u0000${registration.accountId}`,
  );
}

export function providerLookupRowKey(
  provider: Provider,
  value: string,
): string {
  const normalized = provider === "gmail" ? normalizeAddress(value) : value;
  return sha256(`${provider}\u0000${normalized}`);
}

export class TableRegistrationStore implements RegistrationStore {
  private readonly client: TableClient;

  public constructor(
    connectionString: string,
    tableName: string,
    client?: TableClient,
  ) {
    this.client =
      client ?? TableClient.fromConnectionString(connectionString, tableName);
  }

  public async initialize(): Promise<void> {
    try {
      await this.client.createTable();
    } catch (error) {
      if (!isStatus(error, 409)) {
        throw error;
      }
    }
  }

  public async upsert(registration: Registration): Promise<void> {
    const rowKey = registrationRowKey(registration);
    const providerAddressHash = providerLookupRowKey(
      "gmail",
      registration.providerAddress,
    );
    const resourceIdHash = providerLookupRowKey(
      "outlook",
      registration.resourceId,
    );
    const previous = await this.getRegistration(rowKey);

    const entity: TableEntity<StoredRegistration> = {
      partitionKey: registrationPartition,
      rowKey,
      kind: "registration",
      installationId: registration.installationId,
      provider: registration.provider,
      accountId: registration.accountId,
      providerAddress: registration.providerAddress,
      providerAddressHash,
      resourceId: registration.resourceId,
      resourceIdHash,
      expiresAt: registration.expiresAt,
      ...(registration.verificationHash
        ? { verificationHash: registration.verificationHash }
        : {}),
    };

    await this.client.upsertEntity(entity, "Replace");
    const lookupRowKey =
      registration.provider === "outlook"
        ? resourceIdHash
        : providerAddressHash;
    await this.client.upsertEntity<StoredLookup>(
      {
        partitionKey: registration.provider,
        rowKey: lookupRowKey,
        kind: "lookup",
        registrationRowKey: rowKey,
        expiresAt: registration.expiresAt,
      },
      "Replace",
    );

    if (previous) {
      const previousLookup =
        previous.provider === "outlook"
          ? previous.resourceIdHash
          : previous.providerAddressHash;
      if (previousLookup !== lookupRowKey) {
        await this.deleteIgnoringMissing(previous.provider, previousLookup);
      }
    }
  }

  public async findOutlookByResourceId(
    resourceId: string,
    now: Date,
  ): Promise<Registration | undefined> {
    return this.findByLookup(
      "outlook",
      providerLookupRowKey("outlook", resourceId),
      now,
    );
  }

  public async findGmailByAddress(
    providerAddress: string,
    now: Date,
  ): Promise<Registration | undefined> {
    return this.findByLookup(
      "gmail",
      providerLookupRowKey("gmail", providerAddress),
      now,
    );
  }

  public async deleteExpired(now: Date): Promise<number> {
    let registrationsDeleted = 0;
    for await (const entity of this.client.listEntities<StoredEntity>()) {
      if (!entity.partitionKey || !entity.rowKey) {
        continue;
      }
      const expiresAt =
        entity.expiresAt instanceof Date
          ? entity.expiresAt
          : new Date(entity.expiresAt);
      if (expiresAt.getTime() > now.getTime()) {
        continue;
      }
      await this.deleteIgnoringMissing(entity.partitionKey, entity.rowKey);
      if (entity.kind === "registration") {
        registrationsDeleted += 1;
      }
    }
    return registrationsDeleted;
  }

  private async findByLookup(
    provider: Provider,
    lookupRowKey: string,
    now: Date,
  ): Promise<Registration | undefined> {
    try {
      const lookup = await this.client.getEntity<StoredLookup>(
        provider,
        lookupRowKey,
      );
      const lookupExpiry = new Date(lookup.expiresAt);
      if (lookup.kind !== "lookup" || lookupExpiry <= now) {
        return undefined;
      }
      const registration = await this.getRegistration(
        lookup.registrationRowKey,
      );
      if (!registration || registration.provider !== provider) {
        return undefined;
      }
      const registrationLookup =
        provider === "outlook"
          ? registration.resourceIdHash
          : registration.providerAddressHash;
      if (registrationLookup !== lookupRowKey) {
        return undefined;
      }
      const expiresAt = new Date(registration.expiresAt);
      if (expiresAt <= now) {
        return undefined;
      }
      return {
        installationId: registration.installationId,
        provider: registration.provider,
        accountId: registration.accountId,
        providerAddress: registration.providerAddress,
        resourceId: registration.resourceId,
        expiresAt,
        ...(registration.verificationHash
          ? { verificationHash: registration.verificationHash }
          : {}),
      };
    } catch (error) {
      if (isStatus(error, 404)) {
        return undefined;
      }
      throw error;
    }
  }

  private async getRegistration(
    rowKey: string,
  ): Promise<StoredRegistration | undefined> {
    try {
      const entity = await this.client.getEntity<StoredRegistration>(
        registrationPartition,
        rowKey,
      );
      return entity.kind === "registration" ? entity : undefined;
    } catch (error) {
      if (isStatus(error, 404)) {
        return undefined;
      }
      throw error;
    }
  }

  private async deleteIgnoringMissing(
    partitionKey: string,
    rowKey: string,
  ): Promise<void> {
    try {
      await this.client.deleteEntity(partitionKey, rowKey);
    } catch (error) {
      if (!isStatus(error, 404)) {
        throw error;
      }
    }
  }
}
