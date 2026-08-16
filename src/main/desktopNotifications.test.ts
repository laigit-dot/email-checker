import { describe, expect, it } from "vitest";

import type { EmailRecord } from "../shared/contracts.js";
import {
  createEmailNotification,
  findNewEmails,
} from "./desktopNotifications.js";

function email(
  id: string,
  options: {
    accountId?: string;
    failed?: boolean;
    urgent?: boolean;
  } = {},
): EmailRecord {
  return {
    id,
    provider: "outlook",
    accountId: options.accountId ?? "account-1",
    sender: "sender@example.com",
    subject: `Subject ${id}`,
    receivedAt: "2026-08-13T12:00:00.000Z",
    processedAt: "2026-08-13T12:00:01.000Z",
    webUrl: `https://outlook.office.com/mail/inbox/id/${id}`,
    status: {
      unread: true,
      organized: !options.failed,
      failed: options.failed ?? false,
      urgent: options.urgent ?? false,
    },
  };
}

describe("findNewEmails", () => {
  it("returns only records not seen by the running app", () => {
    const knownIds = new Set(["outlook\u0000account-1\u0000existing"]);

    expect(
      findNewEmails([email("new"), email("existing")], knownIds).map(
        (record) => record.id,
      ),
    ).toEqual(["new"]);
    expect(knownIds).toEqual(
      new Set([
        "outlook\u0000account-1\u0000existing",
        "outlook\u0000account-1\u0000new",
      ]),
    );
  });

  it("distinguishes identical provider IDs in different accounts", () => {
    const knownIds = new Set(["outlook\u0000account-1\u0000same"]);

    expect(
      findNewEmails(
        [email("same"), email("same", { accountId: "account-2" })],
        knownIds,
      ).map((record) => record.accountId),
    ).toEqual(["account-2"]);
  });
});

describe("createEmailNotification", () => {
  it("uses sender and subject for one new message", () => {
    expect(createEmailNotification([email("one")])).toEqual({
      title: "New email processed",
      body: "sender@example.com · Subject one",
    });
  });

  it("summarizes urgent and failed messages in a batch", () => {
    expect(
      createEmailNotification([
        email("one", { urgent: true }),
        email("two", { failed: true }),
        email("three", { urgent: true }),
      ]),
    ).toEqual({
      title: "3 new emails processed",
      body: "2 urgent · 1 needs attention",
    });
  });
});
