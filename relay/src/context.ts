import { loadConfig } from "./config.js";
import { GoogleOidcTokenVerifier } from "./googleTokenVerifier.js";
import { createRelayHandlers, type RelayHandlers } from "./handlers.js";
import { AzureWebPubSubPublisher } from "./publisher.js";
import { TableRegistrationStore } from "./storage.js";

async function createProductionHandlers(): Promise<RelayHandlers> {
  const config = loadConfig();
  const store = new TableRegistrationStore(
    config.storageConnectionString,
    config.registrationTable,
  );
  await store.initialize();

  return createRelayHandlers({
    relayApiKey: config.relayApiKey,
    webPubSubTokenTtlMinutes: config.webPubSubTokenTtlMinutes,
    store,
    publisher: new AzureWebPubSubPublisher(
      config.webPubSubConnectionString,
      config.webPubSubHub,
    ),
    googleTokenVerifier: new GoogleOidcTokenVerifier(
      config.googlePubSubAudience,
      config.googlePubSubServiceAccount,
    ),
  });
}

let productionHandlers: Promise<RelayHandlers> | undefined;

export async function getProductionHandlers(): Promise<RelayHandlers> {
  productionHandlers ??= createProductionHandlers();
  try {
    return await productionHandlers;
  } catch (error) {
    productionHandlers = undefined;
    throw error;
  }
}
