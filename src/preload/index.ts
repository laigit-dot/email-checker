import { contextBridge, ipcRenderer } from "electron";

import type {
  DesktopApi,
  DeviceCodeNotice,
  DeviceCodeNoticeListener,
  ListAiModelsRequest,
  ShellMotion,
  ShellMotionListener,
  ListAiModelsResult,
  MonitoringState,
  MonitoringStateListener,
  OrganizerRunCommand,
  OrganizerRunResult,
  OrganizerSecretName,
  OrganizerSettings,
  Provider,
  ProviderAccountSummary,
  ReportSummary,
  SecretState,
  SetSecretCommand,
  StatusSnapshot,
  StatusSnapshotListener,
} from "../shared/contracts";

const statusListeners = new Set<StatusSnapshotListener>();
const deviceCodeListeners = new Set<DeviceCodeNoticeListener>();
const monitoringListeners = new Set<MonitoringStateListener>();
const shellMotionListeners = new Set<ShellMotionListener>();

function forwardStatusUpdate(
  _event: Electron.IpcRendererEvent,
  snapshot: StatusSnapshot,
): void {
  for (const listener of statusListeners) {
    listener(snapshot);
  }
}

function onStatusUpdate(listener: StatusSnapshotListener): () => void {
  statusListeners.add(listener);

  if (statusListeners.size === 1) {
    ipcRenderer.on("data:status-updated", forwardStatusUpdate);
    ipcRenderer.send("data:subscribe-status");
  }

  return () => {
    statusListeners.delete(listener);

    if (statusListeners.size === 0) {
      ipcRenderer.removeListener("data:status-updated", forwardStatusUpdate);
      ipcRenderer.send("data:unsubscribe-status");
    }
  };
}

function forwardDeviceCode(
  _event: Electron.IpcRendererEvent,
  notice: DeviceCodeNotice,
): void {
  for (const listener of deviceCodeListeners) {
    listener(notice);
  }
}

function onDeviceCode(listener: DeviceCodeNoticeListener): () => void {
  deviceCodeListeners.add(listener);
  if (deviceCodeListeners.size === 1) {
    ipcRenderer.on("accounts:device-code", forwardDeviceCode);
    ipcRenderer.send("accounts:subscribe-device-code");
  }
  return () => {
    deviceCodeListeners.delete(listener);
    if (deviceCodeListeners.size === 0) {
      ipcRenderer.removeListener("accounts:device-code", forwardDeviceCode);
      ipcRenderer.send("accounts:unsubscribe-device-code");
    }
  };
}

function forwardMonitoringState(
  _event: Electron.IpcRendererEvent,
  state: MonitoringState,
): void {
  for (const listener of monitoringListeners) {
    listener(state);
  }
}

function onMonitoringState(listener: MonitoringStateListener): () => void {
  monitoringListeners.add(listener);
  if (monitoringListeners.size === 1) {
    ipcRenderer.on("monitoring:state-updated", forwardMonitoringState);
    ipcRenderer.send("monitoring:subscribe");
  }
  return () => {
    monitoringListeners.delete(listener);
    if (monitoringListeners.size === 0) {
      ipcRenderer.removeListener(
        "monitoring:state-updated",
        forwardMonitoringState,
      );
      ipcRenderer.send("monitoring:unsubscribe");
    }
  };
}

function forwardShellMotion(
  _event: Electron.IpcRendererEvent,
  motion: ShellMotion,
): void {
  for (const listener of shellMotionListeners) {
    listener(motion);
  }
}

function onShellMotion(listener: ShellMotionListener): () => void {
  shellMotionListeners.add(listener);
  if (shellMotionListeners.size === 1) {
    ipcRenderer.on("shell:motion", forwardShellMotion);
  }
  return () => {
    shellMotionListeners.delete(listener);
    if (shellMotionListeners.size === 0) {
      ipcRenderer.removeListener("shell:motion", forwardShellMotion);
    }
  };
}

const desktopApi: DesktopApi = Object.freeze({
  window: Object.freeze({
    close: () => ipcRenderer.send("window:close"),
    minimize: () => ipcRenderer.send("window:minimize"),
    showFloating: () => ipcRenderer.send("window:show-floating"),
    restoreMain: () => ipcRenderer.send("window:restore-main"),
    showSidebar: () => ipcRenderer.send("window:show-sidebar"),
    onShellMotion,
  }),
  openEmail: (url: string) =>
    ipcRenderer.invoke("email:open", url) as Promise<boolean>,
  settings: Object.freeze({
    get: () =>
      ipcRenderer.invoke("settings:get") as Promise<{
        settings: OrganizerSettings;
        secrets: SecretState;
      }>,
    save: (settings: OrganizerSettings) =>
      ipcRenderer.invoke("settings:save", settings) as Promise<OrganizerSettings>,
    setSecret: (command: SetSecretCommand) =>
      ipcRenderer.invoke("secrets:set", command) as Promise<SecretState>,
    deleteSecret: (name: OrganizerSecretName) =>
      ipcRenderer.invoke("secrets:delete", name) as Promise<SecretState>,
    listAiModels: (request: ListAiModelsRequest) =>
      ipcRenderer.invoke(
        "settings:list-ai-models",
        request,
      ) as Promise<ListAiModelsResult>,
  }),
  accounts: Object.freeze({
    list: () =>
      ipcRenderer.invoke("accounts:list") as Promise<ProviderAccountSummary[]>,
    connect: (provider: Provider) =>
      ipcRenderer.invoke(
        "accounts:connect",
        provider,
      ) as Promise<ProviderAccountSummary>,
    disconnect: (provider: Provider, accountId: string) =>
      ipcRenderer.invoke("accounts:disconnect", {
        provider,
        accountId,
      }) as Promise<boolean>,
    onDeviceCode,
  }),
  organizer: Object.freeze({
    runNow: (command?: OrganizerRunCommand) =>
      ipcRenderer.invoke(
        "organizer:run-now",
        command,
      ) as Promise<OrganizerRunResult>,
  }),
  monitoring: Object.freeze({
    getState: () =>
      ipcRenderer.invoke("monitoring:get-state") as Promise<MonitoringState>,
    start: () =>
      ipcRenderer.invoke("monitoring:start") as Promise<MonitoringState>,
    pause: () =>
      ipcRenderer.invoke("monitoring:pause") as Promise<MonitoringState>,
    stop: () =>
      ipcRenderer.invoke("monitoring:stop") as Promise<MonitoringState>,
    onStateUpdate: onMonitoringState,
  }),
  reports: Object.freeze({
    list: () =>
      ipcRenderer.invoke("reports:list") as Promise<ReportSummary[]>,
    open: (name: string) =>
      ipcRenderer.invoke("reports:open", name) as Promise<boolean>,
  }),
  data: Object.freeze({
    getStatus: () =>
      ipcRenderer.invoke("data:get-status") as Promise<StatusSnapshot>,
    onStatusUpdate,
  }),
});

contextBridge.exposeInMainWorld("desktop", desktopApi);
