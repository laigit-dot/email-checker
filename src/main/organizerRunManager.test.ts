import { describe, expect, it, vi } from "vitest";

import type {
  OrganizerRunCommand,
  OrganizerRunResult,
} from "../shared/contracts";
import {
  OrganizerRunInProgressError,
  OrganizerRunManager,
} from "./services/organizerRunManager";

const result: OrganizerRunResult = {
  ok: true,
  summary: {
    startedAt: "2026-08-12T12:00:00.000Z",
    finishedAt: "2026-08-12T12:01:00.000Z",
    accountCount: 1,
    processedCount: 1,
    counts: { total: 1, unread: 1, organized: 0, failed: 0, urgent: 0 },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("OrganizerRunManager", () => {
  it("rejects a second manual run while one is active", async () => {
    const pending = deferred<OrganizerRunResult>();
    const execute = vi.fn(
      async (_command: OrganizerRunCommand, _signal: AbortSignal) =>
        pending.promise,
    );
    const manager = new OrganizerRunManager(execute);

    const first = manager.run({ trigger: "manual" });

    await expect(manager.run({ trigger: "manual" })).rejects.toBeInstanceOf(
      OrganizerRunInProgressError,
    );
    expect(execute).toHaveBeenCalledOnce();

    pending.resolve(result);
    await expect(first).resolves.toBe(result);
  });

  it("coalesces automatic triggers into the active run", async () => {
    const pending = deferred<OrganizerRunResult>();
    const execute = vi.fn(async () => pending.promise);
    const manager = new OrganizerRunManager(execute);

    const first = manager.run({ trigger: "backup" });
    const second = manager.run({ trigger: "push", accountIds: ["account-1"] });

    expect(second).toBe(first);
    expect(execute).toHaveBeenCalledOnce();

    pending.resolve(result);
    await expect(second).resolves.toBe(result);
  });

  it("aborts the active run and reports whether work was cancelled", async () => {
    const execute = vi.fn(
      async (_command: OrganizerRunCommand, signal: AbortSignal) =>
        new Promise<OrganizerRunResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const manager = new OrganizerRunManager(execute);

    const running = manager.run({ trigger: "manual" });

    expect(manager.cancel()).toBe(true);
    expect(manager.cancel()).toBe(false);
    await expect(running).rejects.toMatchObject({
      name: "AbortError",
      message: "Organizer run cancelled.",
    });
    expect(manager.isRunning()).toBe(false);
  });
});
