import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureOrganizerLog,
  getOrganizerLogPath,
  isOrganizerLogEnabled,
  logOrganizer,
} from "./services/debugLog";

describe("organizer debug log", () => {
  const originalLog = process.env.ORGANIZER_LOG;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "email-checker-log-"));
    delete process.env.ORGANIZER_LOG;
  });

  afterEach(async () => {
    if (originalLog === undefined) {
      delete process.env.ORGANIZER_LOG;
    } else {
      process.env.ORGANIZER_LOG = originalLog;
    }
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("treats ORGANIZER_LOG as off unless explicitly enabled", () => {
    expect(isOrganizerLogEnabled({})).toBe(false);
    expect(isOrganizerLogEnabled({ ORGANIZER_LOG: "1" })).toBe(true);
    expect(isOrganizerLogEnabled({ ORGANIZER_LOG: "true" })).toBe(true);
    expect(isOrganizerLogEnabled({ ORGANIZER_LOG: "ON" })).toBe(true);
    expect(isOrganizerLogEnabled({ ORGANIZER_LOG: "0" })).toBe(false);
    expect(isOrganizerLogEnabled({ ORGANIZER_LOG: "false" })).toBe(false);
    expect(isOrganizerLogEnabled({ ORGANIZER_LOG: "OFF" })).toBe(false);
  });

  it("skips file and console output when logging is off", () => {
    delete process.env.ORGANIZER_LOG;
    const logFile = join(directory, "logs", "organizer-debug.log");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    configureOrganizerLog(logFile);
    logOrganizer("info", "run.start", { trigger: "manual" });
    logOrganizer("error", "run.failed", { message: "boom" });

    expect(getOrganizerLogPath()).toBeUndefined();
    expect(existsSync(logFile)).toBe(false);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("writes logs when ORGANIZER_LOG is enabled", async () => {
    process.env.ORGANIZER_LOG = "1";
    const logFile = join(directory, "logs", "organizer-debug.log");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    configureOrganizerLog(logFile);
    logOrganizer("info", "run.start", { trigger: "manual" });

    expect(getOrganizerLogPath()).toBe(logFile);
    const contents = await readFile(logFile, "utf8");
    expect(contents).toContain('"event":"logger.ready"');
    expect(contents).toContain('"event":"run.start"');
  });
});
