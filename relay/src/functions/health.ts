import { app } from "@azure/functions";

import { invokeHttp } from "../functionAdapter.js";

app.http("health", {
  route: "health",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: (request, context) =>
    invokeHttp(request, context, (handlers) => handlers.health()),
});
