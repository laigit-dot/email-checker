import type { EmailRecord } from "../shared/contracts.js";
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
): string {
  return `${JSON.stringify(
    {
      generatedAt,
      counts: computeStatusCounts(records),
      emails: sortEmailRecordsNewestFirst(records),
    },
    null,
    2,
  )}\n`;
}
