import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmailRecord } from "../shared/contracts";
import {
  DEFAULT_ORGANIZER_SETTINGS,
  JsonSettingsStore,
} from "./services/settingsStore";
import { EmailHistoryStore } from "./services/emailHistoryStore";
import {
  EncryptedSecretStore,
  type EncryptionAdapter,
} from "./services/secretStore";

function record(id: string, receivedAt: string): EmailRecord {
  return {
    id,
    provider: "gmail",
    accountId: "account-1",
    sender: "sender@example.com",
    subject: id,
    receivedAt,
    processedAt: receivedAt,
    webUrl: `https://mail.google.com/mail/u/0/#inbox/${id}`,
    status: {
      unread: true,
      organized: false,
      failed: false,
      urgent: false,
    },
  };
}

const reversibleEncryption: EncryptionAdapter = {
  encryptString(value) {
    return Buffer.from([...Buffer.from(value)].reverse());
  },
  decryptString(value) {
    return Buffer.from([...value].reverse()).toString("utf8");
  },
};

describe("main-process persistence", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "email-checker-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("uses non-destructive settings defaults when storage is missing", async () => {
    const store = new JsonSettingsStore(join(directory, "settings.json"));

    await expect(store.load()).resolves.toEqual(
      expect.objectContaining({
        dryRun: true,
        markAsRead: false,
        unreadOnly: true,
        folders: [
          "Action Required",
          "Receipts",
          "Newsletters",
          "Updates",
          "Personal",
          "Review",
        ],
        scanLimit: 25,
      }),
    );
  });

  it("round-trips valid settings and rejects invalid settings", async () => {
    const store = new JsonSettingsStore(join(directory, "settings.json"));
    const settings = {
      ...DEFAULT_ORGANIZER_SETTINGS,
      model: "qwen3:8b",
      selectedAccountIds: ["one@example.com"],
      dryRun: false,
      markAsRead: true,
    };

    await store.save(settings);
    await expect(store.load()).resolves.toEqual(settings);
    await expect(
      store.save({ ...settings, confidenceThreshold: 2 }),
    ).rejects.toThrow();
  });

  it("migrates partial legacy settings without losing valid known fields", async () => {
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        model: "legacy-model",
        dryRun: false,
        markAsRead: true,
        unknownLegacyField: "ignored",
      }),
      "utf8",
    );

    await expect(new JsonSettingsStore(path).load()).resolves.toEqual(
      expect.objectContaining({
        model: "legacy-model",
        dryRun: false,
        markAsRead: true,
        unreadOnly: true,
        activeHours: { start: "07:30", end: "23:30" },
        backupPollMinutes: 30,
        rootFolder: "AI Organized",
      }),
    );
  });

  it("falls back safely when settings JSON is corrupt", async () => {
    const path = join(directory, "settings.json");
    await writeFile(path, "{invalid", "utf8");

    await expect(new JsonSettingsStore(path).load()).resolves.toEqual(
      DEFAULT_ORGANIZER_SETTINGS,
    );
  });

  it("atomically persists only the retained 30-day email history", async () => {
    const path = join(directory, "email-history.json");
    const now = new Date("2026-08-11T12:00:00.000Z");
    const store = new EmailHistoryStore(path, () => now);

    await store.save([
      record("expired", "2026-07-11T11:59:59.999Z"),
      record("retained", "2026-07-12T12:00:00.000Z"),
      record("newest", "2026-08-11T11:00:00.000Z"),
    ]);

    await expect(store.load()).resolves.toEqual([
      expect.objectContaining({ id: "newest" }),
      expect.objectContaining({ id: "retained" }),
    ]);
    expect(await readdir(directory)).toEqual(["email-history.json"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(2);
  });

  it("returns an empty history for corrupt or invalid persisted records", async () => {
    const path = join(directory, "email-history.json");
    await writeFile(path, JSON.stringify([{ id: "incomplete" }]), "utf8");

    await expect(new EmailHistoryStore(path).load()).resolves.toEqual([]);
  });

  it("stores encrypted secrets as base64 without exposing a bulk read", async () => {
    const path = join(directory, "secrets.json");
    const store = new EncryptedSecretStore(path, reversibleEncryption);

    await store.set("ollama-api-key", "super-secret");

    await expect(store.get("ollama-api-key")).resolves.toBe("super-secret");
    expect(await readFile(path, "utf8")).not.toContain("super-secret");
    expect("getAll" in store).toBe(false);

    await store.delete("ollama-api-key");
    await expect(store.get("ollama-api-key")).resolves.toBeUndefined();
  });
});
