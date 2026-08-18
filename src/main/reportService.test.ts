import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmailRecord, RunSummary } from "../shared/contracts";
import { ReportService, validateSlackWebhook } from "./services/reportService";

const record: EmailRecord = {
  id: "message-1",
  provider: "gmail",
  accountId: "account-1",
  sender: "recruiter@example.com",
  subject: "Interview invitation",
  receivedAt: "2026-08-11T12:30:00.000Z",
  processedAt: "2026-08-11T12:31:00.000Z",
  webUrl: "https://mail.google.com/mail/u/0/#inbox/message-1",
  status: {
    unread: true,
    organized: true,
    failed: false,
    urgent: true,
  },
};

const run: RunSummary = {
  startedAt: "2026-08-11T12:30:00.000Z",
  finishedAt: "2026-08-11T12:34:56.789Z",
  accountCount: 1,
  processedCount: 1,
  counts: {
    total: 1,
    unread: 1,
    organized: 1,
    failed: 0,
    urgent: 1,
  },
};

describe("ReportService", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "email-reports-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes listable JSON and CSV reports and rejects arbitrary paths", async () => {
    const service = new ReportService(directory);

    const reports = await service.write(
      [],
      new Date("2026-08-11T12:34:56.789Z"),
    );

    expect(reports.map((report) => report.name).sort()).toEqual([
      "run-2026-08-11T12-34-56-789Z.csv",
      "run-2026-08-11T12-34-56-789Z.json",
    ]);
    expect(
      service.getReportPath("run-2026-08-11T12-34-56-789Z.json"),
    ).toBe(join(directory, "run-2026-08-11T12-34-56-789Z.json"));
    expect(service.getReportPath("../settings.json")).toBeUndefined();
  });

  it("allows only Slack incoming-webhook HTTPS hosts", () => {
    expect(
      validateSlackWebhook(
        "https://hooks.slack.com/services/T000/B000/secret",
      ).hostname,
    ).toBe("hooks.slack.com");
    expect(() =>
      validateSlackWebhook("https://example.com/services/T/B/secret"),
    ).toThrow();
    expect(() =>
      validateSlackWebhook("http://hooks.slack.com/services/T/B/secret"),
    ).toThrow();
  });

  it("restores the latest run records from the newest JSON report", async () => {
    const service = new ReportService(directory);

    await service.write([record], run);

    const latestJson = (await service.list()).find(
      (report) => report.format === "json",
    );
    expect(latestJson?.insights).toEqual({
      generatedAt: "2026-08-11T12:34:56.789Z",
      run,
      emails: [record],
    });
  });

  it("restores emails from archives that omit run metadata", async () => {
    const service = new ReportService(directory);
    const name = "run-2026-08-11T12-34-56-789Z.json";
    await writeFile(
      join(directory, name),
      JSON.stringify({
        generatedAt: "2026-08-11T12:34:56.789Z",
        emails: [record],
      }),
      "utf8",
    );

    const latestJson = (await service.list()).find(
      (report) => report.name === name,
    );
    expect(latestJson?.insights).toEqual({
      generatedAt: "2026-08-11T12:34:56.789Z",
      emails: [record],
    });
  });

  it("ignores archived insights with invalid run timestamps", async () => {
    const service = new ReportService(directory);
    const name = "run-2026-08-11T12-34-56-789Z.json";
    await writeFile(
      join(directory, name),
      JSON.stringify({
        run: { ...run, startedAt: "not-a-timestamp" },
        emails: [record],
      }),
      "utf8",
    );

    const latestJson = (await service.list()).find(
      (report) => report.name === name,
    );
    expect(latestJson?.insights).toBeUndefined();
  });
});
