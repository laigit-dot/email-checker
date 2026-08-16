import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { EmailRecord, ReportSummary, RunSummary } from "../../shared/contracts.js";
import {
  serializeCsvReport,
  serializeJsonReport,
} from "../../domain/reports.js";

const reportNamePattern = /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(json|csv)$/;

export function validateSlackWebhook(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["hooks.slack.com", "hooks.slack-gov.com"].includes(
      url.hostname.toLowerCase(),
    ) ||
    !url.pathname.startsWith("/services/")
  ) {
    throw new Error("Slack webhook must be an approved HTTPS incoming webhook.");
  }
  return url;
}

export class ReportService {
  public constructor(
    private readonly reportsDirectory: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  public async write(
    records: readonly EmailRecord[],
    generatedAt = new Date(),
  ): Promise<ReportSummary[]> {
    await mkdir(this.reportsDirectory, { recursive: true });
    const stem = `run-${generatedAt
      .toISOString()
      .replaceAll(":", "-")
      .replace(".", "-")}`;
    const jsonName = `${stem}.json`;
    const csvName = `${stem}.csv`;
    await Promise.all([
      writeFile(
        join(this.reportsDirectory, jsonName),
        serializeJsonReport(records, generatedAt.toISOString()),
        "utf8",
      ),
      writeFile(
        join(this.reportsDirectory, csvName),
        serializeCsvReport(records),
        "utf8",
      ),
    ]);
    return this.list();
  }

  public async list(): Promise<ReportSummary[]> {
    await mkdir(this.reportsDirectory, { recursive: true });
    const names = (await readdir(this.reportsDirectory)).filter((name) =>
      reportNamePattern.test(name),
    );
    const reports = await Promise.all(
      names.map(async (name): Promise<ReportSummary> => {
        const details = await stat(join(this.reportsDirectory, name));
        return {
          name,
          format: name.endsWith(".csv") ? "csv" : "json",
          createdAt: details.mtime.toISOString(),
          size: details.size,
        };
      }),
    );
    return reports.sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  }

  public getReportPath(name: string): string | undefined {
    if (basename(name) !== name || !reportNamePattern.test(name)) {
      return undefined;
    }
    return join(this.reportsDirectory, name);
  }

  public async sendSlackSummary(
    webhook: string,
    summary: RunSummary,
  ): Promise<void> {
    const url = validateSlackWebhook(webhook);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text:
          `Email Checker processed ${summary.processedCount} messages. ` +
          `${summary.counts.organized} organized, ${summary.counts.urgent} urgent, ` +
          `${summary.counts.failed} failed.`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Slack summary failed (${response.status}).`);
    }
  }
}
