import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const APP_USER_MODEL_ID = "com.codeshop.emailchecker";
export const DEV_APP_USER_MODEL_ID = "com.codeshop.emailchecker.dev";

export interface WindowsShortcutDetails {
  target: string;
  cwd: string;
  args: string;
  description: string;
  icon: string;
  iconIndex: number;
  appUserModelId: string;
}

export function windowsAppUserModelId(packaged: boolean): string {
  return packaged ? APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
}

export function windowsStartMenuShortcutPath(
  appDataPath: string,
  packaged: boolean,
): string {
  const name = packaged ? "Email Checker.lnk" : "Email Checker Dev.lnk";
  return join(
    appDataPath,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    name,
  );
}

export function windowsAppShortcutDetails(input: {
  execPath: string;
  appPath: string;
  iconPath: string;
  packaged: boolean;
}): WindowsShortcutDetails {
  return {
    target: input.execPath,
    cwd: input.appPath,
    args: input.packaged ? "" : `"${input.appPath}"`,
    description: "Email Checker",
    icon: input.iconPath,
    iconIndex: 0,
    appUserModelId: windowsAppUserModelId(input.packaged),
  };
}

export function installWindowsNotificationShortcut(
  writeShortcut: (path: string, details: WindowsShortcutDetails) => boolean,
  input: {
    appDataPath: string;
    execPath: string;
    appPath: string;
    iconPath: string;
    packaged: boolean;
  },
): string | undefined {
  if (input.packaged || input.iconPath.length === 0) {
    return undefined;
  }

  const shortcutPath = windowsStartMenuShortcutPath(
    input.appDataPath,
    input.packaged,
  );
  mkdirSync(dirname(shortcutPath), { recursive: true });
  const wrote = writeShortcut(shortcutPath, windowsAppShortcutDetails(input));
  return wrote ? shortcutPath : undefined;
}
