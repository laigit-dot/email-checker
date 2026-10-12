import { describe, expect, it } from "vitest";

import type { EmailRecord, RunSummary } from "../shared/contracts";
import { serializeCsvReport, serializeJsonReport } from "./reports";

const record: EmailRecord = {
  id: "message-1",
  provider: "outlook",
  accountId: "account-1",
  sender: "+malicious@example.com",
  subject: '=HYPERLINK("https://bad.example")',
  receivedAt: "2026-08-11T10:00:00.000Z",
  processedAt: "2026-08-11T10:01:00.000Z",
  webUrl: "https://outlook.office.com/mail/message-1",
  destinationFolder: "Receipts",
  summary: "Invoice, August",
  reason: "Contains a receipt",
  confidence: 0.97,
  status: {
    unread: true,
    organized: true,
    failed: true,
    urgent: true,
  },
  failure: {
    operation: "mark-read",
    detail: "temporary failure",
    occurredAt: "2026-08-11T10:01:00.000Z",
  },
};

const run: RunSummary = {
  startedAt: "2026-08-11T10:00:00.000Z",
  finishedAt: "2026-08-11T12:00:00.000Z",
  accountCount: 1,
  processedCount: 1,
  counts: {
    total: 1,
    unread: 1,
    organized: 1,
    failed: 1,
    urgent: 1,
  },
};

describe("report serialization", () => {
  it("serializes independent status flags and totals to JSON", () => {
    const report = JSON.parse(
      serializeJsonReport([record], "2026-08-11T12:00:00.000Z", run),
    );

    expect(report.generatedAt).toBe("2026-08-11T12:00:00.000Z");
    expect(report.run).toEqual(run);
    expect(report.counts).toEqual({
      total: 1,
      unread: 1,
      organized: 1,
      failed: 1,
      urgent: 1,
    });
    expect(report.emails[0].status).toEqual(record.status);
  });

  it("writes independent CSV fields and protects spreadsheet formulas", () => {
    const csv = serializeCsvReport([record]);
    const [header, row] = csv.trim().split("\r\n");

    expect(header).toContain("unread,organized,failed,urgent");
    expect(row).toContain("true,true,true,true");
    expect(row).toContain(`"'=HYPERLINK(""https://bad.example"")"`);
    expect(row).toContain("'+malicious@example.com");
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });
});
