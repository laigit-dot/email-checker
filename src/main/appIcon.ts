import { existsSync } from "node:fs";
import { join } from "node:path";

export interface AppIconFiles {
  ico?: string;
  png?: string;
  windowIcon: string;
  notificationIcon: string;
}

export function firstExistingPath(
  candidates: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Keep checking remaining candidates.
    }
  }
  return undefined;
}

export function resolveAppIconFiles(
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): AppIconFiles {
  const icoCandidates = roots.map((root) => join(root, "icon.ico"));
  const pngCandidates = roots.map((root) => join(root, "icon.png"));
  const ico = firstExistingPath(icoCandidates);
  const png = firstExistingPath(pngCandidates);
  const fallback = icoCandidates.at(-1) ?? pngCandidates.at(-1) ?? "";
  const windowIcon =
    platform === "win32"
      ? (ico ?? png ?? fallback)
      : (png ?? ico ?? fallback);
  const notificationIcon = png ?? ico ?? windowIcon;
  return { ico, png, windowIcon, notificationIcon };
}
