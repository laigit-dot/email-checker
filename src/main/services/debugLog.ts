import { AsyncLocalStorage } from "node:async_hooks";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

export type OrganizerLogLevel = "debug" | "info" | "warn" | "error";

export interface OrganizerLogContext {
  runId?: string;
  trigger?: string;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STRING = 400;
const SECRET_KEY =
  /(?:token|secret|authorization|api[-_]?key|password|webhook|clientstate|access[-_]?token|refresh[-_]?token)/i;
const ENABLED_LOG_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);

const contextStore = new AsyncLocalStorage<OrganizerLogContext>();

let logFilePath: string | undefined;
let enabled = false;

export function isOrganizerLogEnabled(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = source.ORGANIZER_LOG?.trim().toLowerCase();
  return value !== undefined && ENABLED_LOG_VALUES.has(value);
}

export function getOrganizerLogPath(): string | undefined {
  return logFilePath;
}

export function configureOrganizerLog(filePath: string): void {
  if (!isOrganizerLogEnabled()) {
    enabled = false;
    logFilePath = undefined;
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  if (existsSync(filePath) && statSync(filePath).size > MAX_FILE_BYTES) {
    const previous = filePath.replace(/\.log$/i, ".prev.log");
    try {
      renameSync(filePath, previous);
    } catch {
      // Keep appending if rotation fails; debugging must not crash the app.
    }
  }
  logFilePath = filePath;
  enabled = true;
  write("info", "logger.ready", {
    filePath,
    hint: "Comprehensive organizer debug logging is on. Reproduce the issue, then inspect this file.",
  });
}

export function withOrganizerLogContext<T>(
  context: OrganizerLogContext,
  run: () => Promise<T>,
): Promise<T> {
  return contextStore.run(context, run);
}

export function logOrganizer(
  level: OrganizerLogLevel,
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (!enabled) {
    return;
  }
  write(level, event, details);
}

export function errorFields(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    const extra: Record<string, unknown> = {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    };
    const record = reason as Error & {
      code?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    if (record.code !== undefined) {
      extra.code = record.code;
    }
    if (record.status !== undefined) {
      extra.status = record.status;
    }
    if (record.cause !== undefined) {
      extra.cause = errorFields(record.cause);
    }
    return extra;
  }
  return { message: String(reason) };
}

function write(
  level: OrganizerLogLevel,
  event: string,
  details: Record<string, unknown>,
): void {
  const context = contextStore.getStore() ?? {};
  const entry = sanitize({
    ts: new Date().toISOString(),
    level,
    event,
    ...context,
    ...details,
  });
  const line = JSON.stringify(entry);
  const consoleDetails =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? omit(entry as Record<string, unknown>, ["ts", "level", "event", "stack"])
      : {};
  const consoleLine = `[organizer ${level}] ${event} ${JSON.stringify({
    ...context,
    ...consoleDetails,
  })}`;

  if (level === "error" || level === "warn") {
    console.error(consoleLine);
  } else {
    console.log(consoleLine);
  }

  if (!logFilePath) {
    return;
  }
  try {
    appendFileSync(logFilePath, `${line}\n`, "utf8");
  } catch (reason) {
    console.error("[organizer error] logger.write.failed", errorFields(reason));
  }
}

function omit(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const skipped = new Set(keys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !skipped.has(key)),
  );
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(${value.length} chars)`
      : value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitize(item));
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key)
      ? nested
        ? `[redacted ${typeof nested}]`
        : nested
      : sanitize(nested);
  }
  return result;
}
