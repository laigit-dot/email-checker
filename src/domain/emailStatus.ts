import { z } from "zod";

import type {
  Classification,
  EmailRecord,
  StatusCounts,
} from "../shared/contracts.js";

export const EMAIL_HISTORY_RETENTION_DAYS = 30;
export const FLOATING_EMAIL_LIMIT = 20;

const classifierResponseSchema = z
  .object({
    folder: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    confidence: z.number().finite().min(0).max(1),
    urgent: z.boolean().default(false),
  })
  .strict();

const promptInjectionPatterns = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)\b/i,
  /\b(?:system|developer)\s*:\s*(?:prompt|message|instruction|reveal|ignore|override)\b/i,
  /\b(?:reveal|show|print|repeat|expose)\s+(?:the\s+)?(?:hidden|system|developer)\s+(?:prompt|instructions?|message)\b/i,
  /\bprompt\s+injection\b/i,
  /\bjailbreak\b/i,
  /\b(?:override|bypass)\s+(?:the\s+)?(?:system|developer|safety)\s+(?:prompt|instructions?|rules?)\b/i,
  /\b(?:do\s+not|don't)\s+(?:classify|summarize|organize)\s+(?:this|the)\s+(?:email|message)\b/i,
];

export function normalizeClassification(
  rawJson: string,
  allowedFolders: readonly string[],
  confidenceThreshold: number,
): Classification {
  if (
    !Number.isFinite(confidenceThreshold) ||
    confidenceThreshold < 0 ||
    confidenceThreshold > 1
  ) {
    throw new RangeError("Confidence threshold must be between 0 and 1.");
  }

  const parsed: unknown = JSON.parse(rawJson);
  const classification = classifierResponseSchema.parse(parsed);
  const canonicalFolder = allowedFolders.find(
    (folder) =>
      folder.toLowerCase() === classification.folder.toLowerCase(),
  );
  const reviewFolder =
    allowedFolders.find(
      (folder) => folder.toLowerCase() === "review",
    ) ?? "Review";

  if (
    !canonicalFolder ||
    classification.confidence < confidenceThreshold
  ) {
    return { ...classification, folder: reviewFolder };
  }

  return { ...classification, folder: canonicalFolder };
}

export function detectPromptInjection(content: string): boolean {
  return promptInjectionPatterns.some((pattern) => pattern.test(content));
}

export function combineUrgency(
  providerMarkedHighImportance: boolean,
  aiClassifiedUrgent: boolean,
): boolean {
  return providerMarkedHighImportance || aiClassifiedUrgent;
}

export function computeStatusCounts(
  records: readonly EmailRecord[],
): StatusCounts {
  return records.reduce<StatusCounts>(
    (counts, record) => ({
      total: counts.total + 1,
      unread: counts.unread + Number(record.status.unread),
      organized: counts.organized + Number(record.status.organized),
      failed: counts.failed + Number(record.status.failed),
      urgent: counts.urgent + Number(record.status.urgent),
    }),
    { total: 0, unread: 0, organized: 0, failed: 0, urgent: 0 },
  );
}

export function sortEmailRecordsNewestFirst(
  records: readonly EmailRecord[],
): EmailRecord[] {
  return [...records].sort(
    (left, right) =>
      Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
  );
}

export function pruneEmailRecords(
  records: readonly EmailRecord[],
  now = new Date(),
  retentionDays = EMAIL_HISTORY_RETENTION_DAYS,
): EmailRecord[] {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1_000;

  return sortEmailRecordsNewestFirst(records).filter(
    (record) => Date.parse(record.processedAt) >= cutoff,
  );
}

export function latestEmailRecords(
  records: readonly EmailRecord[],
  limit = FLOATING_EMAIL_LIMIT,
): EmailRecord[] {
  return sortEmailRecordsNewestFirst(records).slice(0, Math.max(0, limit));
}

export function applyMarkReadFailure(
  record: EmailRecord,
  detail: string,
  occurredAt = new Date().toISOString(),
): EmailRecord {
  return {
    ...record,
    status: {
      ...record.status,
      organized: record.status.organized,
      failed: true,
    },
    failure: {
      operation: "mark-read",
      detail,
      occurredAt,
    },
  };
}
