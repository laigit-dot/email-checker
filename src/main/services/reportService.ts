import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import {
  emailHistorySchema,
  timestampSchema,
} from "../../domain/schemas.js";
import type {
  EmailRecord,
  ReportInsights,
  ReportSummary,
  RunSummary,
} from "../../shared/contracts.js";
import {
  getReportRunEmails,
  serializeCsvReport,
  serializeJsonReport,
} from "../../domain/reports.js";

const reportNamePattern = /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(json|csv)$/;
const statusCountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    unread: z.number().int().nonnegative(),
    organized: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    urgent: z.number().int().nonnegative(),
  })
  .strict();
const runSummarySchema = z
  .object({
    startedAt: timestampSchema,
    finishedAt: timestampSchema.optional(),
    accountCount: z.number().int().nonnegative(),
    processedCount: z.number().int().nonnegative(),
    counts: statusCountsSchema,
    error: z.string().optional(),
  })
  .strict();
const reportInsightsSchema = z
  .object({
    generatedAt: timestampSchema.optional(),
    run: runSummarySchema.optional(),
    emails: emailHistorySchema,
  })
  .strip();

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
    generatedAtOrRun: Date | RunSummary = new Date(),
  ): Promise<ReportSummary[]> {
    const run =
      generatedAtOrRun instanceof Date ? undefined : generatedAtOrRun;
    const generatedAt =
      generatedAtOrRun instanceof Date
        ? generatedAtOrRun
        : new Date(generatedAtOrRun.finishedAt ?? Date.now());
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
        serializeJsonReport(records, generatedAt.toISOString(), run),
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
    const sortedReports = reports.sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
    const latestJson = sortedReports.find((report) => report.format === "json");
    if (!latestJson) {
      return sortedReports;
    }

    const insights = await this.readInsights(latestJson.name);
    return sortedReports.map((report) =>
      report.name === latestJson.name && insights
        ? { ...report, insights }
        : report,
    );
  }

  public getReportPath(name: string): string | undefined {
    if (basename(name) !== name || !reportNamePattern.test(name)) {
      return undefined;
    }
    return join(this.reportsDirectory, name);
  }

  private async readInsights(name: string): Promise<ReportInsights | undefined> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(this.reportsDirectory, name), "utf8"),
      );
      const result = reportInsightsSchema.safeParse(parsed);
      if (!result.success) {
        return undefined;
      }
      return {
        ...(result.data.generatedAt
          ? { generatedAt: result.data.generatedAt }
          : {}),
        ...(result.data.run ? { run: result.data.run } : {}),
        emails: getReportRunEmails(
          result.data.emails,
          result.data.run,
          result.data.generatedAt,
        ),
      };
    } catch {
      return undefined;
    }
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
