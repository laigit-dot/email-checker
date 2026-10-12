import { describe, expect, it } from "vitest";

import type { EmailRecord, EmailStatus, RunSummary } from "../shared/contracts";
import {
  clusterNewlyProcessedEmails,
  findUrgentOrganizedEmails,
  formatRelativeTime,
  getLatestRunEmails,
  getReportRunEmails,
  getStatusChips,
  providerLabel,
  checkpointStepLabel,
  runProgress,
} from "./viewHelpers";

function email(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return {
    id: "message-1",
    provider: "gmail",
    accountId: "account-1",
    sender: "sender@example.com",
    subject: "A regular update",
    receivedAt: "2026-08-11T11:00:00.000Z",
    processedAt: "2026-08-11T11:30:00.000Z",
    webUrl: "https://mail.google.com/mail/u/0/#inbox/message-1",
    status: {
      unread: true,
      organized: false,
      failed: false,
      urgent: false,
    },
    ...overrides,
  };
}

const latestRun: RunSummary = {
  startedAt: "2026-08-11T11:00:00.000Z",
  finishedAt: "2026-08-11T12:00:00.000Z",
  accountCount: 1,
  processedCount: 2,
  counts: {
    total: 2,
    unread: 2,
    organized: 1,
    failed: 0,
    urgent: 1,
  },
};

describe("getStatusChips", () => {
  it("returns every applicable status in a stable priority order", () => {
    const status: EmailStatus = {
      unread: true,
      organized: true,
      failed: true,
      urgent: true,
    };

    expect(getStatusChips(status)).toEqual([
      { key: "failed", label: "Failed" },
      { key: "urgent", label: "Urgent" },
      { key: "unread", label: "Unread" },
      { key: "organized", label: "Organized" },
    ]);
  });

  it("omits statuses that do not apply", () => {
    expect(
      getStatusChips({
        unread: false,
        organized: true,
        failed: false,
        urgent: false,
      }),
    ).toEqual([{ key: "organized", label: "Organized" }]);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");

  it.each([
    ["2026-08-11T11:59:45.000Z", "Just now"],
    ["2026-08-11T11:56:00.000Z", "4m ago"],
    ["2026-08-11T09:40:00.000Z", "2h ago"],
    ["2026-08-09T12:00:00.000Z", "Aug 9"],
    ["not-a-date", "Unknown time"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatRelativeTime(value, now)).toBe(expected);
  });
});

describe("providerLabel", () => {
  it("uses recognizable provider names", () => {
    expect(providerLabel("gmail")).toBe("Gmail");
    expect(providerLabel("outlook")).toBe("Outlook");
  });
});

describe("run checkpoints", () => {
  it("labels each organizer step", () => {
    expect(checkpointStepLabel("classifying")).toBe("Classifying");
    expect(checkpointStepLabel("fetching")).toBe("Fetching inbox");
  });

  it("exposes determinate progress after messages are queued", () => {
    expect(runProgress(undefined)).toBeUndefined();
    expect(
      runProgress({
        at: "2026-08-12T12:00:00.000Z",
        step: "starting",
        label: "Starting",
        processedCount: 0,
      }),
    ).toBeUndefined();
    expect(
      runProgress({
        at: "2026-08-12T12:00:00.000Z",
        step: "classifying",
        label: "Classifying 2 of 25",
        processedCount: 1,
        queuedCount: 25,
      }),
    ).toEqual({ value: 1, max: 25 });
  });
});

describe("report insights", () => {
  it("returns only messages processed during the latest run", () => {
    const beforeRun = email({
      id: "old",
      processedAt: "2026-08-11T10:59:59.000Z",
    });
    const duringRun = email({
      id: "new",
      processedAt: "2026-08-11T11:30:00.000Z",
    });
    const afterRun = email({
      id: "future",
      processedAt: "2026-08-11T12:00:01.000Z",
    });

    expect(getLatestRunEmails([beforeRun, duringRun, afterRun], latestRun)).toEqual([
      duringRun,
    ]);
  });

  it("clusters newly processed messages when run timestamps are missing", () => {
    const olderRun = email({
      id: "older",
      processedAt: "2026-08-16T21:15:00.000Z",
    });
    const latestOne = email({
      id: "latest-1",
      processedAt: "2026-08-18T04:24:33.000Z",
    });
    const latestTwo = email({
      id: "latest-2",
      processedAt: "2026-08-18T04:32:42.000Z",
    });

    expect(
      clusterNewlyProcessedEmails(
        [olderRun, latestOne, latestTwo],
        "2026-08-18T04:32:45.979Z",
      ).map(({ id }) => id),
    ).toEqual(["latest-2", "latest-1"]);
    expect(
      getReportRunEmails(
        [olderRun, latestOne, latestTwo],
        undefined,
        "2026-08-18T04:32:45.979Z",
      ).map(({ id }) => id),
    ).toEqual(["latest-2", "latest-1"]);
  });

  it("lists urgent organized messages from the latest process", () => {
    const urgentOrganized = email({
      id: "urgent-filed",
      sender: "recruiter@example.com",
      subject: "Interview availability",
      destinationFolder: "Availability",
      status: {
        unread: true,
        organized: true,
        failed: false,
        urgent: true,
      },
    });
    const organizedOnly = email({
      id: "filed",
      destinationFolder: "Job Alert",
      status: {
        unread: false,
        organized: true,
        failed: false,
        urgent: false,
      },
    });
    const urgentFailed = email({
      id: "failed",
      status: {
        unread: true,
        organized: false,
        failed: true,
        urgent: true,
      },
    });

    expect(
      findUrgentOrganizedEmails([
        organizedOnly,
        urgentFailed,
        urgentOrganized,
      ]).map(({ id }) => id),
    ).toEqual(["urgent-filed"]);
  });
});
