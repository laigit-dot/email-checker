import { z } from "zod";

export const timestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Expected an ISO-compatible timestamp.",
);

export const emailStatusSchema = z
  .object({
    unread: z.boolean(),
    organized: z.boolean(),
    failed: z.boolean(),
    urgent: z.boolean(),
  })
  .strict();

export const processingFailureSchema = z
  .object({
    operation: z.enum(["classify", "organize", "mark-read", "unknown"]),
    detail: z.string().min(1),
    occurredAt: timestampSchema,
  })
  .strict();

export const emailRecordSchema = z
  .object({
    id: z.string().min(1),
    provider: z.enum(["outlook", "gmail"]),
    accountId: z.string().min(1),
    sender: z.string(),
    subject: z.string(),
    receivedAt: timestampSchema,
    processedAt: timestampSchema,
    webUrl: z.string().url(),
    status: emailStatusSchema,
    destinationFolder: z.string().min(1).optional(),
    summary: z.string().optional(),
    reason: z.string().optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    failure: processingFailureSchema.optional(),
  })
  .strip();

export const emailHistorySchema = z.array(emailRecordSchema);
