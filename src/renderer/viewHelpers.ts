import type {
  EmailStatus,
  Provider,
  RunCheckpoint,
  StatusCounts,
} from "../shared/contracts";
import {
  clusterNewlyProcessedEmails,
  findUrgentOrganizedEmails,
  getLatestRunEmails,
  getReportRunEmails,
} from "../domain/reports";

export type StatusKey = keyof EmailStatus;

export interface StatusChip {
  key: StatusKey;
  label: string;
}

const STATUS_CHIPS: readonly StatusChip[] = [
  { key: "failed", label: "Failed" },
  { key: "urgent", label: "Urgent" },
  { key: "unread", label: "Unread" },
  { key: "organized", label: "Organized" },
];

export const METRICS: ReadonlyArray<{
  key: Exclude<keyof StatusCounts, "total">;
  label: string;
  detail: string;
}> = [
  { key: "unread", label: "Unread", detail: "Still awaiting review" },
  { key: "organized", label: "Organized", detail: "Filed by your rules" },
  { key: "failed", label: "Failed", detail: "Needs your attention" },
  { key: "urgent", label: "Urgent", detail: "Priority messages" },
];

export function getStatusChips(status: EmailStatus): StatusChip[] {
  return STATUS_CHIPS.filter(({ key }) => status[key]);
}

export function formatRelativeTime(
  value: string,
  now = new Date(),
): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return "Unknown time";
  }

  const elapsed = Math.max(0, now.getTime() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);

  if (minutes < 1) {
    return "Just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

export function providerLabel(provider: Provider): string {
  return provider === "gmail" ? "Gmail" : "Outlook";
}

const CHECKPOINT_STEP_LABELS: Record<RunCheckpoint["step"], string> = {
  starting: "Starting",
  fetching: "Fetching inbox",
  classifying: "Classifying",
  filing: "Filing",
  completing: "Finishing",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function checkpointStepLabel(step: RunCheckpoint["step"]): string {
  return CHECKPOINT_STEP_LABELS[step];
}

export function runProgress(
  checkpoint: RunCheckpoint | undefined,
): { value: number; max: number } | undefined {
  if (!checkpoint?.queuedCount || checkpoint.queuedCount <= 0) {
    return undefined;
  }
  return {
    value: Math.min(checkpoint.processedCount, checkpoint.queuedCount),
    max: checkpoint.queuedCount,
  };
}

export {
  clusterNewlyProcessedEmails,
  findUrgentOrganizedEmails,
  getLatestRunEmails,
  getReportRunEmails,
};
