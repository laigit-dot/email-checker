import { app } from "@azure/functions";

import { invokeHttp } from "../functionAdapter.js";

app.http("desktop-negotiate", {
  route: "desktop/negotiate",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: (request, context) =>
    invokeHttp(request, context, (handlers) => handlers.negotiate(request)),
});

app.http("desktop-register", {
  route: "desktop/register",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: (request, context) =>
    invokeHttp(request, context, (handlers) => handlers.register(request)),
});
