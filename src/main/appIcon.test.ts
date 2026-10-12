import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  firstExistingPath,
  resolveAppIconFiles,
  trayIconPixelSize,
} from "./appIcon";

describe("app icon files", () => {
  let directory: string;

  beforeEach(async () => {
    directory = join(tmpdir(), `email-icons-${Date.now()}`);
    await mkdir(directory, { recursive: true });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("returns the first candidate that exists", async () => {
    const missing = join(directory, "missing.ico");
    const present = join(directory, "icon.ico");
    await writeFile(present, "icon");

    expect(firstExistingPath([missing, present])).toBe(present);
    expect(firstExistingPath([missing])).toBeUndefined();
  });

  it("uses the ICO for Windows windows and the PNG for notifications", async () => {
    await writeFile(join(directory, "icon.ico"), "ico");
    await writeFile(join(directory, "icon.png"), "png");

    expect(resolveAppIconFiles([directory], "win32")).toEqual({
      ico: join(directory, "icon.ico"),
      png: join(directory, "icon.png"),
      windowIcon: join(directory, "icon.ico"),
      notificationIcon: join(directory, "icon.png"),
    });
  });

  it("prefers the PNG on non-Windows platforms", async () => {
    await writeFile(join(directory, "icon.ico"), "ico");
    await writeFile(join(directory, "icon.png"), "png");

    expect(resolveAppIconFiles([directory], "darwin").windowIcon).toBe(
      join(directory, "icon.png"),
    );
  });

  it("falls back to whichever icon file is present", async () => {
    await writeFile(join(directory, "icon.png"), "png");

    expect(resolveAppIconFiles([directory], "win32")).toEqual({
      ico: undefined,
      png: join(directory, "icon.png"),
      windowIcon: join(directory, "icon.png"),
      notificationIcon: join(directory, "icon.png"),
    });
  });

  it("sizes the tray icon for the display scale", () => {
    expect(trayIconPixelSize(1)).toBe(16);
    expect(trayIconPixelSize(1.5)).toBe(24);
    expect(trayIconPixelSize(2)).toBe(32);
    expect(trayIconPixelSize(0)).toBe(16);
  });
});
