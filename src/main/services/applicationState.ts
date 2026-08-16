import type {
  EmailRecord,
  RunState,
  StatusSnapshot,
  StatusSnapshotListener,
} from "../../shared/contracts.js";
import {
  computeStatusCounts,
  latestEmailRecords,
} from "../../domain/emailStatus.js";
import type { EmailHistoryStore } from "./emailHistoryStore.js";

const EMPTY_HISTORY_MESSAGE =
  "Connect an account and run the organizer to build local history.";

function historyMessage(recordCount: number): string {
  if (recordCount === 0) {
    return EMPTY_HISTORY_MESSAGE;
  }
  return `${recordCount} email${recordCount === 1 ? "" : "s"} retained in local history.`;
}

function snapshotMessage(recordCount: number, run: RunState): string {
  if (
    run.checkpoint?.label &&
    (run.phase === "running" ||
      run.phase === "cancelled" ||
      run.phase === "failed")
  ) {
    return run.checkpoint.label;
  }
  return historyMessage(recordCount);
}

function emptySnapshot(now: Date, run: RunState = { phase: "idle" }): StatusSnapshot {
  return {
    state: run.phase,
    message: snapshotMessage(0, run),
    generatedAt: now.toISOString(),
    counts: {
      total: 0,
      unread: 0,
      organized: 0,
      failed: 0,
      urgent: 0,
    },
    emails: [],
    run,
  };
}

export class ApplicationStateService {
  private snapshot: StatusSnapshot;
  private readonly listeners = new Set<StatusSnapshotListener>();

  public constructor(
    private readonly history: EmailHistoryStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.snapshot = emptySnapshot(this.now());
  }

  public async initialize(): Promise<void> {
    const records = await this.history.load();
    this.snapshot =
      records.length === 0
        ? emptySnapshot(this.now())
        : this.createSnapshot(records, { phase: "idle" });
  }

  public getSnapshot(): StatusSnapshot {
    return structuredClone(this.snapshot);
  }

  public subscribe(listener: StatusSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async replaceRecords(
    records: readonly EmailRecord[],
    run: RunState = { phase: "idle" },
  ): Promise<void> {
    await this.history.save(records);
    const retained = await this.history.load();
    this.snapshot =
      retained.length === 0
        ? emptySnapshot(this.now(), run)
        : this.createSnapshot(retained, run);

    this.emit();
  }

  public updateRun(run: RunState): void {
    this.snapshot =
      this.snapshot.emails.length === 0
        ? {
            ...emptySnapshot(this.now(), run),
            counts: this.snapshot.counts,
          }
        : {
            ...this.snapshot,
            state: run.phase,
            message: snapshotMessage(this.snapshot.counts.total, run),
            generatedAt: this.now().toISOString(),
            run,
          };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.getSnapshot());
    }
  }

  private createSnapshot(
    records: readonly EmailRecord[],
    run: RunState,
  ): StatusSnapshot {
    return {
      state: run.phase,
      message: snapshotMessage(records.length, run),
      generatedAt: this.now().toISOString(),
      counts: computeStatusCounts(records),
      emails: latestEmailRecords(records),
      run,
    };
  }
}
