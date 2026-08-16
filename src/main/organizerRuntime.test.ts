import { describe, expect, it, vi } from "vitest";

import type {
  Classification,
  OrganizerSettings,
  ProviderAccountSummary,
} from "../shared/contracts";
import { applyMarkReadFailure } from "../domain/emailStatus";
import {
  isWithinActiveHours,
  nextBackupPollAt,
} from "./services/monitoringSchedule";
import {
  OrganizerEngine,
  type OrganizerProviderAdapter,
  type ProviderMessage,
} from "./services/organizerEngine";
import { DEFAULT_ORGANIZER_SETTINGS } from "./services/settingsStore";

const account: ProviderAccountSummary = {
  id: "account-1",
  provider: "gmail",
  email: "owner@example.com",
  health: { status: "connected" },
};

const message: ProviderMessage = {
  id: "message-1",
  sender: "sender@example.com",
  subject: "Invoice",
  receivedAt: "2026-08-11T12:00:00.000Z",
  bodyPreview: "Invoice attached",
  webUrl: "https://mail.google.com/mail/u/0/#inbox/message-1",
  unread: true,
  highImportance: false,
};

const classification: Classification = {
  folder: "Receipts",
  summary: "A receipt",
  reason: "Invoice language",
  confidence: 0.98,
  urgent: false,
};

function adapter(values?: Partial<OrganizerProviderAdapter>): OrganizerProviderAdapter {
  return {
    fetchMessages: vi.fn(async () => [message]),
    moveMessage: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    ...values,
  };
}

function settings(values?: Partial<OrganizerSettings>): OrganizerSettings {
  return { ...DEFAULT_ORGANIZER_SETTINGS, ...values };
}

describe("organizer runtime", () => {
  it("uses inclusive active-hour boundaries and delays outside the window", () => {
    expect(
      isWithinActiveHours(
        new Date(2026, 7, 11, 7, 30),
        { start: "07:30", end: "23:30" },
      ),
    ).toBe(true);
    expect(
      isWithinActiveHours(
        new Date(2026, 7, 11, 23, 30),
        { start: "07:30", end: "23:30" },
      ),
    ).toBe(true);
    expect(
      isWithinActiveHours(
        new Date(2026, 7, 11, 7, 29),
        { start: "07:30", end: "23:30" },
      ),
    ).toBe(false);
    expect(
      nextBackupPollAt(
        new Date(2026, 7, 11, 23, 20),
        30,
        { start: "07:30", end: "23:30" },
      ),
    ).toEqual(new Date(2026, 7, 12, 7, 30));
  });

  it("never mutates provider state during dry runs", async () => {
    const provider = adapter();
    const engine = new OrganizerEngine({
      classifier: { classify: vi.fn(async () => classification) },
      adapters: { gmail: provider },
      loadHistory: async () => [],
      publish: vi.fn(async () => undefined),
      now: () => new Date("2026-08-11T12:01:00.000Z"),
    });

    const result = await engine.run([account], settings({ dryRun: true }));

    expect(provider.moveMessage).not.toHaveBeenCalled();
    expect(provider.markRead).not.toHaveBeenCalled();
    expect(result.records[0]).toMatchObject({
      destinationFolder: "Receipts",
      status: { organized: false, failed: false },
    });
  });

  it("retains organized success when the later mark-read operation fails", async () => {
    const provider = adapter({
      markRead: vi.fn(async () => {
        throw new Error("read update denied");
      }),
    });
    const engine = new OrganizerEngine({
      classifier: { classify: vi.fn(async () => classification) },
      adapters: { gmail: provider },
      loadHistory: async () => [],
      publish: vi.fn(async () => undefined),
      now: () => new Date("2026-08-11T12:01:00.000Z"),
    });

    const result = await engine.run(
      [account],
      settings({ dryRun: false, markAsRead: true }),
    );

    expect(result.records[0]).toMatchObject({
      status: { organized: true, unread: true, failed: true },
      failure: { operation: "mark-read", detail: "read update denied" },
    });
    expect(provider.moveMessage).toHaveBeenCalledOnce();
  });

  it("isolates one message failure and continues the account", async () => {
    const provider = adapter({
      fetchMessages: vi.fn(async () => [
        { ...message, id: "bad", subject: "bad" },
        { ...message, id: "good", subject: "good", highImportance: true },
      ]),
    });
    const engine = new OrganizerEngine({
      classifier: {
        classify: vi.fn(async (input) => {
          if (input.subject === "bad") throw new Error("classifier unavailable");
          return classification;
        }),
      },
      adapters: { gmail: provider },
      loadHistory: async () => [],
      publish: vi.fn(async () => undefined),
    });

    const result = await engine.run(
      [account],
      settings({ dryRun: false }),
    );

    expect(result.records).toHaveLength(2);
    expect(result.records.find((item) => item.id === "bad")).toMatchObject({
      status: { failed: true, organized: false },
      failure: { operation: "classify" },
    });
    expect(result.records.find((item) => item.id === "good")).toMatchObject({
      status: { failed: false, organized: true, urgent: true },
    });
  });

  it("isolates one account fetch failure and continues other accounts", async () => {
    const provider = adapter({
      fetchMessages: vi.fn(async (accountId) => {
        if (accountId === "broken") throw new Error("token expired");
        return [message];
      }),
    });
    const engine = new OrganizerEngine({
      classifier: { classify: vi.fn(async () => classification) },
      adapters: { gmail: provider },
      loadHistory: async () => [],
      publish: vi.fn(async () => undefined),
    });

    const result = await engine.run(
      [
        { ...account, id: "broken", email: "broken@example.com" },
        { ...account, id: "healthy", email: "healthy@example.com" },
      ],
      settings(),
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.accountId).toBe("healthy");
    expect(result.summary.error).toContain("broken@example.com");
  });

  it("publishes start, fetch, classify, and complete checkpoints", async () => {
    const publish = vi.fn(async () => undefined);
    const engine = new OrganizerEngine({
      classifier: { classify: vi.fn(async () => classification) },
      adapters: { gmail: adapter() },
      loadHistory: async () => [],
      publish,
      now: () => new Date("2026-08-11T12:01:00.000Z"),
    });

    await engine.run([account], settings({ dryRun: true }));

    const checkpoints = publish.mock.calls.map(
      ([, run]) => run.checkpoint?.step,
    );
    expect(checkpoints).toEqual([
      "starting",
      "fetching",
      "fetching",
      "classifying",
      "classifying",
      "completing",
    ]);
    expect(publish.mock.calls.map((call) => call[2])).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(publish.mock.calls[3]?.[1]).toMatchObject({
      phase: "running",
      checkpoint: {
        step: "classifying",
        label: "Classifying 1 of 1 · Invoice",
        accountEmail: "owner@example.com",
        messageIndex: 1,
        messageCount: 1,
        queuedCount: 1,
      },
    });
    expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({
      phase: "completed",
      checkpoint: {
        step: "completing",
        processedCount: 1,
        queuedCount: 1,
      },
    });
  });

  it("stops after the active classification when the run is cancelled", async () => {
    let releaseClassification!: () => void;
    const classificationStarted = new Promise<void>((resolve) => {
      releaseClassification = resolve;
    });
    let finishClassification!: (value: Classification) => void;
    const pendingClassification = new Promise<Classification>((resolve) => {
      finishClassification = resolve;
    });
    const classify = vi.fn(async () => {
      releaseClassification();
      return pendingClassification;
    });
    const provider = adapter({
      fetchMessages: vi.fn(async () => [
        { ...message, id: "first", subject: "First" },
        { ...message, id: "second", subject: "Second" },
      ]),
    });
    const engine = new OrganizerEngine({
      classifier: { classify },
      adapters: { gmail: provider },
      loadHistory: async () => [],
      publish: vi.fn(async () => undefined),
    });
    const controller = new AbortController();

    const running = engine.run(
      [account],
      settings({ dryRun: true }),
      controller.signal,
    );
    await classificationStarted;
    controller.abort(new DOMException("Organizer run cancelled.", "AbortError"));
    finishClassification(classification);

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(classify).toHaveBeenCalledOnce();
  });

  it("records a completed move before honoring cancellation", async () => {
    let moveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      moveStarted = resolve;
    });
    let finishMove!: () => void;
    const pendingMove = new Promise<void>((resolve) => {
      finishMove = resolve;
    });
    const publish = vi.fn(async () => undefined);
    const provider = adapter({
      fetchMessages: vi.fn(async () => [
        { ...message, id: "first", subject: "First" },
        { ...message, id: "second", subject: "Second" },
      ]),
      moveMessage: vi.fn(async () => {
        moveStarted();
        return pendingMove;
      }),
    });
    const engine = new OrganizerEngine({
      classifier: { classify: vi.fn(async () => classification) },
      adapters: { gmail: provider },
      loadHistory: async () => [],
      publish,
    });
    const controller = new AbortController();

    const running = engine.run(
      [account],
      settings({ dryRun: false }),
      controller.signal,
    );
    await started;
    controller.abort(new DOMException("Organizer run cancelled.", "AbortError"));
    finishMove();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.moveMessage).toHaveBeenCalledOnce();
    expect(publish.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({
        id: "first",
        status: expect.objectContaining({ organized: true, failed: false }),
      }),
    ]);
  });

  it("keeps independent failure flags", () => {
    const failed = applyMarkReadFailure(
      {
        id: "x",
        provider: "gmail",
        accountId: "a",
        sender: "",
        subject: "",
        receivedAt: "2026-08-11T12:00:00.000Z",
        processedAt: "2026-08-11T12:00:00.000Z",
        webUrl: "https://mail.google.com/mail/",
        status: { unread: true, organized: true, failed: false, urgent: true },
      },
      "denied",
    );

    expect(failed.status).toEqual({
      unread: true,
      organized: true,
      failed: true,
      urgent: true,
    });
  });
});
