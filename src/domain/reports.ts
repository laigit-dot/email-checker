import type { EmailRecord, RunSummary } from "../shared/contracts.js";
import {
  computeStatusCounts,
  sortEmailRecordsNewestFirst,
} from "./emailStatus.js";

const csvColumns = [
  "id",
  "provider",
  "accountId",
  "sender",
  "subject",
  "receivedAt",
  "processedAt",
  "webUrl",
  "destinationFolder",
  "summary",
  "reason",
  "confidence",
  "unread",
  "organized",
  "failed",
  "urgent",
  "failureOperation",
  "failureDetail",
] as const;

function protectSpreadsheetFormula(value: string): string {
  return /^\s*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | boolean | undefined): string {
  const text = protectSpreadsheetFormula(
    value === undefined ? "" : String(value),
  );

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function toCsvRow(record: EmailRecord): string {
  return [
    record.id,
    record.provider,
    record.accountId,
    record.sender,
    record.subject,
    record.receivedAt,
    record.processedAt,
    record.webUrl,
    record.destinationFolder,
    record.summary,
    record.reason,
    record.confidence,
    record.status.unread,
    record.status.organized,
    record.status.failed,
    record.status.urgent,
    record.failure?.operation,
    record.failure?.detail,
  ]
    .map(csvCell)
    .join(",");
}

export function serializeCsvReport(records: readonly EmailRecord[]): string {
  const rows = sortEmailRecordsNewestFirst(records).map(toCsvRow);
  return `\uFEFF${csvColumns.join(",")}\r\n${rows.join("\r\n")}\r\n`;
}

export function serializeJsonReport(
  records: readonly EmailRecord[],
  generatedAt = new Date().toISOString(),
  run?: RunSummary,
): string {
  return `${JSON.stringify(
    {
      generatedAt,
      ...(run ? { run } : {}),
      counts: computeStatusCounts(records),
      emails: sortEmailRecordsNewestFirst(records),
    },
    null,
    2,
  )}\n`;
}

const NEW_RUN_GAP_MS = 30 * 60 * 1000;

function sortByProcessedAtDesc(
  emails: readonly EmailRecord[],
): EmailRecord[] {
  return [...emails].sort(
    (left, right) =>
      Date.parse(right.processedAt) - Date.parse(left.processedAt),
  );
}

export function getLatestRunEmails(
  emails: readonly EmailRecord[],
  summary: RunSummary | undefined,
): EmailRecord[] {
  if (!summary) {
    return [];
  }

  const startedAt = Date.parse(summary.startedAt);
  const finishedAt = summary.finishedAt
    ? Date.parse(summary.finishedAt)
    : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(startedAt) || Number.isNaN(finishedAt)) {
    return [];
  }

  return sortByProcessedAtDesc(
    emails.filter((email) => {
      const processedAt = Date.parse(email.processedAt);
      return (
        Number.isFinite(processedAt) &&
        processedAt >= startedAt &&
        processedAt <= finishedAt
      );
    }),
  );
}

export function clusterNewlyProcessedEmails(
  emails: readonly EmailRecord[],
  generatedAt?: string,
): EmailRecord[] {
  const dated = emails
    .map((email) => ({ email, processedAt: Date.parse(email.processedAt) }))
    .filter(({ processedAt }) => Number.isFinite(processedAt))
    .sort((left, right) => right.processedAt - left.processedAt);

  const newest = dated[0];
  if (!newest) {
    return [];
  }

  const generated = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  const anchor = Number.isFinite(generated) ? generated : newest.processedAt;
  const cluster: EmailRecord[] = [];
  let previous = anchor;

  for (const item of dated) {
    if (item.processedAt - anchor > NEW_RUN_GAP_MS) {
      continue;
    }
    if (previous - item.processedAt > NEW_RUN_GAP_MS) {
      break;
    }
    cluster.push(item.email);
    previous = item.processedAt;
  }

  return cluster;
}

export function getReportRunEmails(
  emails: readonly EmailRecord[],
  summary: RunSummary | undefined,
  generatedAt?: string,
): EmailRecord[] {
  const fromSummary = getLatestRunEmails(emails, summary);
  if (fromSummary.length > 0) {
    return fromSummary;
  }
  return clusterNewlyProcessedEmails(
    emails,
    generatedAt ?? summary?.finishedAt,
  );
}

export function findUrgentOrganizedEmails(
  emails: readonly EmailRecord[],
): EmailRecord[] {
  return sortByProcessedAtDesc(
    emails.filter(
      (email) => email.status.urgent && email.status.organized,
    ),
  );
}
