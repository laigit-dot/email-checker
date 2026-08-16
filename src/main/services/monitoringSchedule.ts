import type { ActiveHours } from "../../shared/contracts.js";

function minutes(value: string): number {
  const [hours = 0, mins = 0] = value.split(":").map(Number);
  return hours * 60 + mins;
}

export function isWithinActiveHours(
  now: Date,
  activeHours: ActiveHours,
): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutes(activeHours.start);
  const end = minutes(activeHours.end);

  if (start <= end) {
    return current >= start && current <= end;
  }

  return current >= start || current <= end;
}

export function nextBackupPollAt(
  now: Date,
  cadenceMinutes: number,
  activeHours: ActiveHours,
): Date {
  const candidate = new Date(now.getTime() + cadenceMinutes * 60_000);

  if (isWithinActiveHours(candidate, activeHours)) {
    return candidate;
  }

  const start = minutes(activeHours.start);
  const result = new Date(now);
  result.setSeconds(0, 0);
  result.setHours(Math.floor(start / 60), start % 60, 0, 0);

  if (result.getTime() <= now.getTime()) {
    result.setDate(result.getDate() + 1);
  }

  return result;
}
