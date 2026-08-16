import { app } from "@azure/functions";

import { invokeHttp } from "../functionAdapter.js";

app.http("gmail-pubsub", {
  route: "gmail/pubsub",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: (request, context) =>
    invokeHttp(request, context, (handlers) => handlers.gmailPubSub(request)),
});
