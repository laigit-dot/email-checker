import { describe, expect, it } from "vitest";

import { createRelayRegistration } from "./services/relayRegistration";

describe("relay provider registration", () => {
  it("includes the Outlook address and verification secret", () => {
    expect(
      createRelayRegistration(
        {
          id: "outlook-account",
          provider: "outlook",
          email: "owner@contoso.com",
          health: { status: "connected" },
        },
        "subscription-1",
        "2026-08-12T12:00:00.000Z",
        "client-state-secret",
      ),
    ).toEqual({
      version: 1,
      provider: "outlook",
      accountId: "outlook-account",
      providerAddress: "owner@contoso.com",
      resourceId: "subscription-1",
      expiresAt: "2026-08-12T12:00:00.000Z",
      verificationSecret: "client-state-secret",
    });
  });

  it("includes the Gmail address without an Outlook verification secret", () => {
    expect(
      createRelayRegistration(
        {
          id: "gmail-account",
          provider: "gmail",
          email: "owner@gmail.com",
          health: { status: "connected" },
        },
        "history-1",
        "2026-08-12T12:00:00.000Z",
      ),
    ).toEqual({
      version: 1,
      provider: "gmail",
      accountId: "gmail-account",
      providerAddress: "owner@gmail.com",
      resourceId: "history-1",
      expiresAt: "2026-08-12T12:00:00.000Z",
    });
  });
});
