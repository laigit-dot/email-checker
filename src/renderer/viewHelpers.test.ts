import { describe, expect, it } from "vitest";

import type { EmailStatus } from "../shared/contracts";
import {
  formatRelativeTime,
  getStatusChips,
  providerLabel,
  checkpointStepLabel,
  runProgress,
} from "./viewHelpers";

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
