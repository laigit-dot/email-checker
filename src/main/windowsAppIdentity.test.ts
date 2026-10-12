import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  APP_USER_MODEL_ID,
  DEV_APP_USER_MODEL_ID,
  installWindowsNotificationShortcut,
  windowsAppShortcutDetails,
  windowsAppUserModelId,
  windowsStartMenuShortcutPath,
} from "./windowsAppIdentity";

describe("windows app identity", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses a dev identity so development does not replace the installed shortcut", () => {
    expect(windowsAppUserModelId(true)).toBe(APP_USER_MODEL_ID);
    expect(windowsAppUserModelId(false)).toBe(DEV_APP_USER_MODEL_ID);
    expect(windowsStartMenuShortcutPath("C:\\Roaming", false)).toMatch(
      /Email Checker Dev\.lnk$/,
    );
    expect(windowsStartMenuShortcutPath("C:\\Roaming", true)).toMatch(
      /Email Checker\.lnk$/,
    );
  });

  it("points the notification shortcut at the app logo", () => {
    expect(
      windowsAppShortcutDetails({
        execPath: "C:\\electron.exe",
        appPath: "C:\\email-checker",
        iconPath: "C:\\email-checker\\build\\icon.ico",
        packaged: false,
      }),
    ).toMatchObject({
      target: "C:\\electron.exe",
      icon: "C:\\email-checker\\build\\icon.ico",
      iconIndex: 0,
      appUserModelId: DEV_APP_USER_MODEL_ID,
      args: '"C:\\email-checker"',
    });
  });

  it("writes the dev shortcut and skips packaged installs", () => {
    const appDataPath = mkdtempSync(join(tmpdir(), "email-checker-start-"));
    directories.push(appDataPath);
    const writes: string[] = [];

    const shortcut = installWindowsNotificationShortcut(
      (path) => {
        writes.push(path);
        return true;
      },
      {
        appDataPath,
        execPath: "C:\\electron.exe",
        appPath: "C:\\email-checker",
        iconPath: "C:\\email-checker\\build\\icon.ico",
        packaged: false,
      },
    );

    expect(shortcut).toBe(
      windowsStartMenuShortcutPath(appDataPath, false),
    );
    expect(writes).toEqual([shortcut]);
    expect(
      installWindowsNotificationShortcut(() => true, {
        appDataPath,
        execPath: "C:\\Email Checker.exe",
        appPath: "C:\\Program Files\\Email Checker",
        iconPath: "C:\\icon.ico",
        packaged: true,
      }),
    ).toBeUndefined();
  });
});
