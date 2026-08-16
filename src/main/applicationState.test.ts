import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailRecord } from "../shared/contracts";
import { ApplicationStateService } from "./services/applicationState";
import { EmailHistoryStore } from "./services/emailHistoryStore";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function record(index: number): EmailRecord {
  const receivedAt = new Date(NOW.getTime() - index * 1_000).toISOString();
  return {
    id: String(index),
    provider: "gmail",
    accountId: "account-1",
    sender: "sender@example.com",
    subject: `Message ${index}`,
    receivedAt,
    processedAt: receivedAt,
    webUrl: `https://mail.google.com/mail/u/0/#inbox/${index}`,
    status: {
      unread: index % 2 === 0,
      organized: index === 0,
      failed: index === 0,
      urgent: index === 0,
    },
  };
}

describe("ApplicationStateService", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "email-state-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns an empty production snapshot when history is empty", async () => {
    const history = new EmailHistoryStore(
      join(directory, "email-history.json"),
      () => NOW,
    );
    const service = new ApplicationStateService(history, () => NOW);

    await service.initialize();
    const snapshot = service.getSnapshot();

    expect(snapshot.state).toBe("idle");
    expect(snapshot.emails).toEqual([]);
    expect(snapshot.counts).toEqual({
      total: 0,
      unread: 0,
      organized: 0,
      failed: 0,
      urgent: 0,
    });
  });

  it("loads persisted history, computes independent counts, and exposes latest 20", async () => {
    const history = new EmailHistoryStore(
      join(directory, "email-history.json"),
      () => NOW,
    );
    await history.save(Array.from({ length: 25 }, (_, index) => record(index)));
    const service = new ApplicationStateService(history, () => NOW);

    await service.initialize();
    const snapshot = service.getSnapshot();

    expect(snapshot.emails).toHaveLength(20);
    expect(snapshot.emails[0]?.id).toBe("0");
    expect(snapshot.counts).toEqual({
      total: 25,
      unread: 13,
      organized: 1,
      failed: 1,
      urgent: 1,
    });
  });

  it("persists updates and supports unsubscribe from snapshot events", async () => {
    const history = new EmailHistoryStore(
      join(directory, "email-history.json"),
      () => NOW,
    );
    const service = new ApplicationStateService(history, () => NOW);
    await service.initialize();
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);

    await service.replaceRecords([record(0)]);
    unsubscribe();
    await service.replaceRecords([record(1)]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      counts: { total: 1, organized: 1, failed: 1, urgent: 1 },
    });
    await expect(history.load()).resolves.toEqual([
      expect.objectContaining({ id: "1" }),
    ]);
  });

  it("surfaces the live checkpoint as the snapshot message while running", async () => {
    const history = new EmailHistoryStore(
      join(directory, "email-history.json"),
      () => NOW,
    );
    const service = new ApplicationStateService(history, () => NOW);
    await service.initialize();

    await service.replaceRecords([record(0)], {
      phase: "running",
      summary: {
        startedAt: NOW.toISOString(),
        accountCount: 1,
        processedCount: 0,
        counts: { total: 1, unread: 1, organized: 1, failed: 1, urgent: 1 },
      },
      checkpoint: {
        at: NOW.toISOString(),
        step: "classifying",
        label: "Classifying 1 of 25 · Invoice",
        processedCount: 0,
        queuedCount: 25,
        accountEmail: "owner@example.com",
        accountIndex: 1,
        accountCount: 1,
        messageIndex: 1,
        messageCount: 25,
        subject: "Invoice",
      },
    });

    expect(service.getSnapshot()).toMatchObject({
      state: "running",
      message: "Classifying 1 of 25 · Invoice",
      run: {
        phase: "running",
        checkpoint: { step: "classifying", queuedCount: 25 },
      },
    });

    service.updateRun({
      phase: "failed",
      checkpoint: {
        at: NOW.toISOString(),
        step: "failed",
        label: "Microsoft Graph request failed (401).",
        processedCount: 0,
      },
    });

    expect(service.getSnapshot().message).toBe(
      "Microsoft Graph request failed (401).",
    );

    service.updateRun({
      phase: "cancelled",
      checkpoint: {
        at: NOW.toISOString(),
        step: "cancelled",
        label: "Organizer run cancelled.",
        processedCount: 0,
      },
    });

    expect(service.getSnapshot().message).toBe("Organizer run cancelled.");
  });
});
