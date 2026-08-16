import type {
  OrganizerRunCommand,
  OrganizerRunResult,
} from "../../shared/contracts.js";

export class OrganizerRunInProgressError extends Error {
  public constructor() {
    super("An organizer run is already in progress.");
    this.name = "OrganizerRunInProgressError";
  }
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<OrganizerRunResult>;
}

export class OrganizerRunManager {
  private active?: ActiveRun;

  public constructor(
    private readonly execute: (
      command: OrganizerRunCommand,
      signal: AbortSignal,
    ) => Promise<OrganizerRunResult>,
  ) {}

  public run(command: OrganizerRunCommand = {}): Promise<OrganizerRunResult> {
    if (this.active) {
      if (command.trigger === "push" || command.trigger === "backup") {
        return this.active.promise;
      }
      return Promise.reject(new OrganizerRunInProgressError());
    }

    const controller = new AbortController();
    let promise: Promise<OrganizerRunResult>;
    try {
      promise = this.execute(command, controller.signal);
    } catch (reason) {
      promise = Promise.reject(reason);
    }
    const active: ActiveRun = {
      controller,
      promise,
    };
    this.active = active;
    void promise
      .finally(() => {
        if (this.active === active) {
          this.active = undefined;
        }
      })
      .catch(() => undefined);
    return promise;
  }

  public cancel(): boolean {
    if (!this.active || this.active.controller.signal.aborted) {
      return false;
    }
    this.active.controller.abort(
      new DOMException("Organizer run cancelled.", "AbortError"),
    );
    return true;
  }

  public isRunning(): boolean {
    return this.active !== undefined;
  }
}
