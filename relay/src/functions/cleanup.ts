import { app } from "@azure/functions";

import { getProductionHandlers } from "../context.js";

app.timer("registration-cleanup", {
  schedule: "0 0 * * * *",
  handler: async (_timer, context) => {
    try {
      const handlers = await getProductionHandlers();
      const deleted = await handlers.cleanup();
      context.log(`Expired relay registrations deleted: ${deleted}.`);
    } catch {
      context.error("Relay registration cleanup failed.");
      throw new Error("Relay registration cleanup failed.");
    }
  },
});
