import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReportService, validateSlackWebhook } from "./services/reportService";

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

    expect(reports.map((report) => report.name)).toEqual([
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
});
