import { app } from "@azure/functions";

import { invokeHttp } from "../functionAdapter.js";

app.http("outlook-notifications", {
  route: "outlook/notifications",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: (request, context) =>
    invokeHttp(request, context, (handlers) =>
      handlers.outlookNotifications(request),
    ),
});

app.http("outlook-lifecycle", {
  route: "outlook/lifecycle",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: (request, context) =>
    invokeHttp(request, context, (handlers) =>
      handlers.outlookLifecycle(request),
    ),
});
