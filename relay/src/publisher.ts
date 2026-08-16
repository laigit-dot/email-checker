import { WebPubSubServiceClient } from "@azure/web-pubsub";

import type { RelayPublisher, RelayPushEvent } from "./contracts.js";

export class AzureWebPubSubPublisher implements RelayPublisher {
  private readonly client: WebPubSubServiceClient;

  public constructor(
    connectionString: string,
    hubName: string,
    client?: WebPubSubServiceClient,
  ) {
    this.client =
      client ?? new WebPubSubServiceClient(connectionString, hubName);
  }

  public async negotiate(
    installationId: string,
    expiresAt: Date,
  ): Promise<string> {
    const expirationTimeInMinutes = Math.max(
      1,
      Math.ceil((expiresAt.getTime() - Date.now()) / 60_000),
    );
    const token = await this.client.getClientAccessToken({
      userId: installationId,
      expirationTimeInMinutes,
    });
    return token.url;
  }

  public async publish(
    installationId: string,
    event: RelayPushEvent,
  ): Promise<void> {
    await this.client.sendToUser(installationId, { ...event });
  }
}
