import type {
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";

import { getProductionHandlers } from "./context.js";
import type { RelayHandlers } from "./handlers.js";

export async function invokeHttp(
  request: HttpRequest,
  context: InvocationContext,
  select: (
    handlers: RelayHandlers,
    request: HttpRequest,
  ) => Promise<HttpResponseInit> | HttpResponseInit,
): Promise<HttpResponseInit> {
  try {
    const handlers = await getProductionHandlers();
    return await select(handlers, request);
  } catch {
    context.error("Relay request failed.");
    return {
      status: 503,
      jsonBody: { error: "service_unavailable" },
      headers: { "cache-control": "no-store" },
    };
  }
}
