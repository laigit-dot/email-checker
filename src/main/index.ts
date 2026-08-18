import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type {
  DeviceCodeNotice,
  MonitoringState,
  OrganizerRunCommand,
  OrganizerRunResult,
  OrganizerSecretName,
  Provider,
  ProviderAccountSummary,
  RelayRegisterRequest,
  SecretState,
  StatusSnapshot,
} from "../shared/contracts.js";
import { resolveSelectedAccountIds } from "../shared/accountSelection.js";
import { resolveAppIconFiles } from "./appIcon.js";
import { createAppShell, type ShellWindowRoute } from "./appShell.js";
import { parseAllowedEmailUrl } from "./openEmail.js";
import { ApplicationStateService } from "./services/applicationState.js";
import { EmailHistoryStore } from "./services/emailHistoryStore.js";
import { electronSafeStorageAdapter } from "./services/electronSafeStorage.js";
import {
  GmailConnector,
} from "./services/gmailConnector.js";
import { MonitoringCoordinator } from "./services/monitoringCoordinator.js";
import { listAiModels } from "./services/aiModels.js";
import { OllamaClassifier } from "./services/ollamaClassifier.js";
import { OrganizerEngine } from "./services/organizerEngine.js";
import { OrganizerRunManager } from "./services/organizerRunManager.js";
import {
  OutlookConnector,
  OutlookGraphAdapter,
} from "./services/outlookConnector.js";
import { ReportService } from "./services/reportService.js";
import { createRelayRegistration } from "./services/relayRegistration.js";
import { EncryptedSecretStore } from "./services/secretStore.js";
import {
  JsonSettingsStore,
  organizerSettingsSchema,
} from "./services/settingsStore.js";
import {
  configureOrganizerLog,
  errorFields,
  getOrganizerLogPath,
  logOrganizer,
  withOrganizerLogContext,
} from "./services/debugLog.js";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const preloadPath = join(currentDirectory, "..", "preload", "index.cjs");

try {
  process.loadEnvFile();
} catch {
  // .env is optional; set ORGANIZER_LOG=1 to enable organizer debug logging.
}
const rendererPath = join(currentDirectory, "..", "..", "dist", "index.html");
let isQuitting = false;

function resolveAppIcons() {
  return resolveAppIconFiles([
    process.resourcesPath,
    join(app.getAppPath(), "build"),
    join(currentDirectory, "..", "..", "build"),
  ]);
}

const providerSchema = z.enum(["outlook", "gmail"]);
const secretNameSchema = z.enum([
  "relay-api-key",
  "slack-webhook",
  "ollama-api-key",
  "openrouter-api-key",
  "google-client-secret",
]);
const listAiModelsSchema = z
  .object({
    provider: z.enum(["ollama", "openrouter"]),
    endpoint: z.string().max(500).optional(),
    apiKey: z.string().max(20_000).optional(),
  })
  .strict();
const setSecretSchema = z
  .object({ name: secretNameSchema, value: z.string().min(1).max(20_000) })
  .strict();
const disconnectSchema = z
  .object({ provider: providerSchema, accountId: z.string().min(1).max(500) })
  .strict();
const runCommandSchema = z
  .object({
    accountIds: z.array(z.string().min(1).max(500)).optional(),
    trigger: z.enum(["manual", "push", "backup"]).optional(),
  })
  .strict();

interface RuntimeServices {
  settingsStore: JsonSettingsStore;
  secretStore: EncryptedSecretStore;
  state: ApplicationStateService;
  monitoring: MonitoringCoordinator;
  reports: ReportService;
  listAccounts: () => Promise<ProviderAccountSummary[]>;
  connectAccount: (provider: Provider) => Promise<ProviderAccountSummary>;
  disconnectAccount: (
    provider: Provider,
    accountId: string,
  ) => Promise<boolean>;
  runOrganizer: (command?: OrganizerRunCommand) => Promise<OrganizerRunResult>;
  cancelOrganizer: () => boolean;
  getSecretState: () => Promise<SecretState>;
  onDeviceCode: (listener: (notice: DeviceCodeNotice) => void) => () => void;
  onMonitoringState: (
    listener: (state: MonitoringState) => void,
  ) => () => void;
}

function getDevelopmentUrl(): URL | null {
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) {
    return null;
  }

  const url = new URL(process.env.VITE_DEV_SERVER_URL);
  const isLocalHost =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";

  if (url.protocol !== "http:" || !isLocalHost) {
    throw new Error("VITE_DEV_SERVER_URL must use local HTTP.");
  }

  return url;
}

async function loadRenderer(
  window: BrowserWindow,
  route: ShellWindowRoute,
): Promise<void> {
  const developmentUrl = getDevelopmentUrl();

  if (developmentUrl) {
    developmentUrl.searchParams.set("window", route);
    await window.loadURL(developmentUrl.toString());
    return;
  }

  await window.loadFile(rendererPath, {
    query: { window: route },
  });
}

function secureWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
}

function registerIpcHandlers(
  runtime: RuntimeServices,
  appShell: ReturnType<typeof createAppShell>,
): void {
  const getSenderWindow = (
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): BrowserWindow => {
    const window = BrowserWindow.fromWebContents(event.sender);

    if (!window || !appShell.isOwnedWindow(window)) {
      throw new Error("Rejected IPC from an untrusted renderer.");
    }

    return window;
  };
  const requireSenderWindow = (
    event: IpcMainEvent | IpcMainInvokeEvent,
    expected: BrowserWindow | null,
  ): BrowserWindow => {
    const sender = getSenderWindow(event);

    if (!expected || sender !== expected) {
      throw new Error("Rejected IPC action from the wrong application window.");
    }

    return sender;
  };
  const requireControlWindow = (
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): BrowserWindow => {
    const sender = getSenderWindow(event);
    const mainWindow = appShell.getMainWindow();
    const sidebarWindow = appShell.getSidebarWindow();

    if (sender !== mainWindow && sender !== sidebarWindow) {
      throw new Error("Rejected IPC action from the wrong application window.");
    }

    return sender;
  };
  const statusSubscribers = new Set<WebContents>();
  const deviceCodeSubscribers = new Set<WebContents>();
  const monitoringSubscribers = new Set<WebContents>();
  const trackSubscriber = (
    event: IpcMainEvent,
    subscribers: Set<WebContents>,
  ) => {
    getSenderWindow(event);
    subscribers.add(event.sender);
    event.sender.once("destroyed", () => subscribers.delete(event.sender));
  };
  const broadcast = <T>(
    subscribers: Set<WebContents>,
    channel: string,
    value: T,
  ) => {
    for (const subscriber of subscribers) {
      if (subscriber.isDestroyed()) {
        subscribers.delete(subscriber);
      } else {
        subscriber.send(channel, value);
      }
    }
  };

  ipcMain.on("window:close", (event) => {
    appShell.hideSenderWindow(getSenderWindow(event));
  });
  ipcMain.on("window:show-floating", (event) => {
    requireSenderWindow(event, appShell.getMainWindow());
    appShell.showFloatingWindow();
  });
  ipcMain.on("window:restore-main", (event) => {
    const sender = getSenderWindow(event);
    if (
      sender !== appShell.getFloatingWindow() &&
      sender !== appShell.getSidebarWindow()
    ) {
      throw new Error("Rejected IPC action from the wrong application window.");
    }
    appShell.restoreMainWindow();
  });
  ipcMain.on("window:show-sidebar", (event) => {
    getSenderWindow(event);
    appShell.showSidebar();
  });
  ipcMain.handle("email:open", async (event, value: unknown) => {
    getSenderWindow(event);

    if (typeof value !== "string") {
      return false;
    }

    const url = parseAllowedEmailUrl(value);

    if (!url) {
      return false;
    }

    await shell.openExternal(url.toString());
    return true;
  });
  ipcMain.handle("data:get-status", (event) => {
    getSenderWindow(event);
    return runtime.state.getSnapshot();
  });
  ipcMain.on("data:subscribe-status", (event) => {
    trackSubscriber(event, statusSubscribers);
  });
  ipcMain.on("data:unsubscribe-status", (event) => {
    getSenderWindow(event);
    statusSubscribers.delete(event.sender);
  });

  ipcMain.handle("settings:get", async (event) => {
    getSenderWindow(event);
    return {
      settings: await runtime.settingsStore.load(),
      secrets: await runtime.getSecretState(),
    };
  });
  ipcMain.handle("settings:save", async (event, value: unknown) => {
    getSenderWindow(event);
    const settings = organizerSettingsSchema.parse(value);
    await runtime.settingsStore.save(settings);
    return settings;
  });
  ipcMain.handle("secrets:set", async (event, value: unknown) => {
    getSenderWindow(event);
    const command = setSecretSchema.parse(value);
    await runtime.secretStore.set(command.name, command.value);
    return runtime.getSecretState();
  });
  ipcMain.handle("secrets:delete", async (event, value: unknown) => {
    getSenderWindow(event);
    const name = secretNameSchema.parse(value);
    await runtime.secretStore.delete(name);
    return runtime.getSecretState();
  });
  ipcMain.handle("settings:list-ai-models", async (event, value: unknown) => {
    getSenderWindow(event);
    const request = listAiModelsSchema.parse(value ?? {});
    const storedKey =
      request.provider === "openrouter"
        ? await runtime.secretStore.get("openrouter-api-key")
        : await runtime.secretStore.get("ollama-api-key");
    return listAiModels({
      provider: request.provider,
      endpoint: request.endpoint,
      apiKey: request.apiKey?.trim() || storedKey,
    });
  });
  ipcMain.handle("accounts:list", async (event) => {
    getSenderWindow(event);
    return runtime.listAccounts();
  });
  ipcMain.handle("accounts:connect", async (event, value: unknown) => {
    requireSenderWindow(event, appShell.getMainWindow());
    return runtime.connectAccount(providerSchema.parse(value));
  });
  ipcMain.handle("accounts:disconnect", async (event, value: unknown) => {
    requireSenderWindow(event, appShell.getMainWindow());
    const command = disconnectSchema.parse(value);
    return runtime.disconnectAccount(command.provider, command.accountId);
  });
  ipcMain.on("accounts:subscribe-device-code", (event) => {
    trackSubscriber(event, deviceCodeSubscribers);
  });
  ipcMain.on("accounts:unsubscribe-device-code", (event) => {
    getSenderWindow(event);
    deviceCodeSubscribers.delete(event.sender);
  });
  ipcMain.handle("organizer:run-now", async (event, value: unknown) => {
    requireControlWindow(event);
    const command = value === undefined ? undefined : runCommandSchema.parse(value);
    return runtime.runOrganizer(command);
  });
  ipcMain.handle("monitoring:get-state", (event) => {
    getSenderWindow(event);
    return runtime.monitoring.getState();
  });
  ipcMain.handle("monitoring:start", async (event) => {
    requireControlWindow(event);
    return runtime.monitoring.start();
  });
  ipcMain.handle("monitoring:pause", (event) => {
    requireControlWindow(event);
    return runtime.monitoring.pause();
  });
  ipcMain.handle("monitoring:stop", (event) => {
    requireControlWindow(event);
    runtime.cancelOrganizer();
    return runtime.monitoring.stop();
  });
  ipcMain.on("monitoring:subscribe", (event) => {
    trackSubscriber(event, monitoringSubscribers);
  });
  ipcMain.on("monitoring:unsubscribe", (event) => {
    getSenderWindow(event);
    monitoringSubscribers.delete(event.sender);
  });
  ipcMain.handle("reports:list", async (event) => {
    getSenderWindow(event);
    return runtime.reports.list();
  });
  ipcMain.handle("reports:open", async (event, value: unknown) => {
    requireSenderWindow(event, appShell.getMainWindow());
    const name = z.string().min(1).max(200).parse(value);
    const path = runtime.reports.getReportPath(name);
    if (!path) {
      return false;
    }
    return (await shell.openPath(path)) === "";
  });

  runtime.state.subscribe((snapshot: StatusSnapshot) => {
    broadcast(statusSubscribers, "data:status-updated", snapshot);
  });
  runtime.onDeviceCode((notice) =>
    broadcast(deviceCodeSubscribers, "accounts:device-code", notice),
  );
  runtime.onMonitoringState((monitoringState) =>
    broadcast(monitoringSubscribers, "monitoring:state-updated", monitoringState),
  );
}

function subscriptionSecretName(accountId: string): string {
  return `outlook-sub-${createHash("sha256").update(accountId).digest("hex")}`;
}

async function createRuntime(userDataPath: string): Promise<RuntimeServices> {
  const logFilePath = join(userDataPath, "logs", "organizer-debug.log");
  configureOrganizerLog(logFilePath);
  const settingsStore = new JsonSettingsStore(join(userDataPath, "settings.json"));
  const historyStore = new EmailHistoryStore(
    join(userDataPath, "email-history.json"),
  );
  const secretStore = new EncryptedSecretStore(
    join(userDataPath, "secrets.json"),
    electronSafeStorageAdapter,
  );
  const state = new ApplicationStateService(historyStore);
  const reports = new ReportService(join(userDataPath, "reports"));
  const deviceCodeListeners = new Set<(notice: DeviceCodeNotice) => void>();
  const monitoringListeners = new Set<(value: MonitoringState) => void>();
  const publishDeviceCode = (notice: DeviceCodeNotice) => {
    for (const listener of deviceCodeListeners) {
      listener(notice);
    }
  };
  const createOutlook = async () => {
    const settings = await settingsStore.load();
    if (!settings.azureClientId) {
      throw new Error("Configure the Microsoft public client ID first.");
    }
    return new OutlookConnector({
      clientId: settings.azureClientId,
      tenantId: settings.azureTenantId,
      secrets: secretStore,
      onDeviceCode: publishDeviceCode,
    });
  };
  const createGmail = async () => {
    const settings = await settingsStore.load();
    if (!settings.googleClientId) {
      throw new Error("Configure the Google desktop client ID first.");
    }
    const clientSecret = await secretStore.get("google-client-secret");
    if (!clientSecret) {
      throw new Error("Configure the Google desktop client secret first.");
    }
    return new GmailConnector({
      clientId: settings.googleClientId,
      clientSecret,
      secrets: secretStore,
      openExternal: (url) => shell.openExternal(url.toString()),
    });
  };
  const listAccounts = async (): Promise<ProviderAccountSummary[]> => {
    const settings = await settingsStore.load();
    const accounts: ProviderAccountSummary[] = [];
    if (settings.azureClientId) {
      try {
        const outlookAccounts = await (await createOutlook()).listAccounts();
        logOrganizer("debug", "accounts.outlook.listed", {
          count: outlookAccounts.length,
          emails: outlookAccounts.map((account) => account.email),
        });
        accounts.push(...outlookAccounts);
      } catch (reason) {
        logOrganizer("error", "accounts.outlook.list-failed", errorFields(reason));
        accounts.push({
          id: "outlook-configuration",
          provider: "outlook",
          email: "Microsoft 365 configuration",
          health: {
            status: "error",
            message:
              reason instanceof Error ? reason.message : "Microsoft connector failed.",
          },
        });
      }
    }
    if (settings.googleClientId) {
      try {
        const gmailAccounts = await (await createGmail()).listAccounts();
        logOrganizer("debug", "accounts.gmail.listed", {
          count: gmailAccounts.length,
          emails: gmailAccounts.map((account) => account.email),
        });
        accounts.push(...gmailAccounts);
      } catch (reason) {
        logOrganizer("error", "accounts.gmail.list-failed", errorFields(reason));
        accounts.push({
          id: "gmail-configuration",
          provider: "gmail",
          email: "Gmail configuration",
          health: {
            status: "error",
            message:
              reason instanceof Error ? reason.message : "Gmail connector failed.",
          },
        });
      }
    }
    return accounts;
  };
  const connectAccount = async (provider: Provider) => {
    const account =
      provider === "outlook"
        ? await (await createOutlook()).connect()
        : await (await createGmail()).connect();
    const settings = await settingsStore.load();
    if (
      settings.selectedAccountIds.length > 0 &&
      !settings.selectedAccountIds.includes(account.id)
    ) {
      await settingsStore.save({
        ...settings,
        selectedAccountIds: [...settings.selectedAccountIds, account.id],
      });
    }
    return account;
  };
  const disconnectAccount = async (
    provider: Provider,
    accountId: string,
  ): Promise<boolean> => {
    const removed =
      provider === "outlook"
        ? await (async () => {
            const connector = await createOutlook();
            const subscriptionRaw = await secretStore.get(
              subscriptionSecretName(accountId),
            );
            if (subscriptionRaw) {
              try {
                const subscription = z
                  .object({ id: z.string(), expirationDateTime: z.string() })
                  .parse(JSON.parse(subscriptionRaw));
                const adapter = new OutlookGraphAdapter((id) =>
                  connector.acquireMailToken(id),
                );
                await adapter.deleteSubscription(accountId, subscription.id);
              } catch {
                // Account removal still clears local credentials if remote cleanup fails.
              }
              await secretStore.delete(subscriptionSecretName(accountId));
            }
            return connector.removeAccount(accountId);
          })()
        : await (await createGmail()).removeAccount(accountId);
    if (removed) {
      const settings = await settingsStore.load();
      if (settings.selectedAccountIds.includes(accountId)) {
        await settingsStore.save({
          ...settings,
          selectedAccountIds: settings.selectedAccountIds.filter(
            (id) => id !== accountId,
          ),
        });
      }
    }
    return removed;
  };

  const executeOrganizer = async (
    command: OrganizerRunCommand = {},
    signal: AbortSignal,
  ): Promise<OrganizerRunResult> => {
    const runId = randomBytes(4).toString("hex");
    return withOrganizerLogContext(
      { runId, trigger: command.trigger ?? "manual" },
      async () => {
        const started = Date.now();
        let latestSummary: OrganizerRunResult["summary"] | undefined;
        try {
          signal.throwIfAborted();
          const settings = await settingsStore.load();
          signal.throwIfAborted();
          const listed = await listAccounts();
          signal.throwIfAborted();
          const allAccounts = listed.filter(
            (account) => account.health.status === "connected",
          );
          const unhealthy = listed.filter(
            (account) => account.health.status !== "connected",
          );
          const selectedIds =
            command.accountIds !== undefined
              ? allAccounts
                  .map((account) => account.id)
                  .filter((id) => command.accountIds?.includes(id))
              : resolveSelectedAccountIds(
                  allAccounts.map((account) => account.id),
                  settings.selectedAccountIds,
                );
          const accounts = allAccounts.filter((account) =>
            selectedIds.includes(account.id),
          );
          const unmatchedSelectedIds = selectedIds.filter(
            (id) => !allAccounts.some((account) => account.id === id),
          );
          logOrganizer("info", "run.start", {
            logFile: getOrganizerLogPath(),
            trigger: command.trigger ?? "manual",
            commandAccountIds: command.accountIds,
            selectedAccountIds: settings.selectedAccountIds,
            resolvedAccountIds: selectedIds,
            connected: allAccounts.map((account) => ({
              id: account.id,
              email: account.email,
              provider: account.provider,
            })),
            skippedUnhealthy: unhealthy.map((account) => ({
              id: account.id,
              email: account.email,
              status: account.health.status,
              message: account.health.message,
            })),
            unmatchedSelectedIds,
            willProcess: accounts.map((account) => ({
              id: account.id,
              email: account.email,
              provider: account.provider,
            })),
            dryRun: settings.dryRun,
            unreadOnly: settings.unreadOnly,
            markAsRead: settings.markAsRead,
            scanLimit: settings.scanLimit,
            rootFolder: settings.rootFolder,
            folders: settings.folders,
            confidenceThreshold: settings.confidenceThreshold,
            aiProvider: settings.aiProvider,
            model: settings.model,
            ollamaUrl: settings.ollamaUrl,
            azureClientConfigured: Boolean(settings.azureClientId),
            googleClientConfigured: Boolean(settings.googleClientId),
            promptChars: settings.prompt.length,
          });
          if (unmatchedSelectedIds.length > 0) {
            logOrganizer("warn", "run.selected-ids.unmatched", {
              unmatchedSelectedIds,
              hint: "Selected account IDs do not match any connected account. Re-select inboxes in Accounts.",
            });
          }
          if (accounts.length === 0) {
            logOrganizer("warn", "run.no-target-accounts", {
              listedCount: listed.length,
              connectedCount: allAccounts.length,
              selectedIds,
              hint: "Organizer will finish without moving mail. Connect an account or clear a stale selection.",
            });
          }

          let outlook;
          if (settings.azureClientId) {
            try {
              outlook = await createOutlook();
              signal.throwIfAborted();
              logOrganizer("debug", "run.outlook.ready", {});
            } catch (reason) {
              logOrganizer("error", "run.outlook.unavailable", errorFields(reason));
              throw reason;
            }
          } else {
            logOrganizer("debug", "run.outlook.skipped", {
              hint: "No Microsoft client ID configured.",
            });
          }
          const gmail = settings.googleClientId
            ? await createGmail().catch((reason) => {
                logOrganizer("error", "run.gmail.unavailable", {
                  hint: "Gmail connector failed; Outlook (if any) will still run.",
                  ...errorFields(reason),
                });
                return undefined;
              })
            : undefined;
          signal.throwIfAborted();
          if (settings.googleClientId && gmail) {
            logOrganizer("debug", "run.gmail.ready", {});
          } else if (!settings.googleClientId) {
            logOrganizer("debug", "run.gmail.skipped", {
              hint: "No Google client ID configured.",
            });
          }
          const ollamaApiKey = await secretStore.get("ollama-api-key");
          const openrouterApiKey = await secretStore.get("openrouter-api-key");
          signal.throwIfAborted();
          logOrganizer("debug", "run.classifier.keys", {
            aiProvider: settings.aiProvider,
            ollamaKeyConfigured: Boolean(ollamaApiKey),
            openrouterKeyConfigured: Boolean(openrouterApiKey),
          });
          const outlookConnector = outlook;
          const engine = new OrganizerEngine({
            classifier: new OllamaClassifier(undefined, {
              ollama: ollamaApiKey,
              openrouter: openrouterApiKey,
            }),
            adapters: {
              outlook: outlookConnector
                ? new OutlookGraphAdapter((id) =>
                    outlookConnector.acquireMailToken(id),
                  )
                : undefined,
              gmail: gmail?.createAdapter(),
            },
            loadHistory: () => historyStore.load(),
            publish: (records, run, persistRecords) => {
              if (persistRecords) {
                return state.replaceRecords(records, run);
              }
              state.updateRun(run);
              return Promise.resolve();
            },
          });
          const result = await engine.run(accounts, settings, signal);
          latestSummary = result.summary;
          signal.throwIfAborted();
          await reports.write(result.records, result.summary);
          // Re-publish completion after the report is durable so renderers can
          // refresh archive-backed insights for automatic runs.
          state.updateRun(state.getSnapshot().run);
          signal.throwIfAborted();
          const slackWebhook = await secretStore.get("slack-webhook");
          signal.throwIfAborted();
          if (slackWebhook) {
            try {
              await reports.sendSlackSummary(slackWebhook, result.summary);
              logOrganizer("info", "run.slack.ok", {});
            } catch (reason) {
              logOrganizer("warn", "run.slack.failed", {
                hint: "Slack delivery failed; organizer result is unchanged.",
                ...errorFields(reason),
              });
            }
          }
          signal.throwIfAborted();
          logOrganizer(
            result.summary.error ? "warn" : "info",
            "run.complete",
            {
              elapsedMs: Date.now() - started,
              processedCount: result.summary.processedCount,
              counts: result.summary.counts,
              error: result.summary.error,
              dryRun: settings.dryRun,
              logFile: getOrganizerLogPath(),
            },
          );
          return { ok: true, summary: result.summary };
        } catch (reason) {
          const cancelled = signal.aborted;
          const detail =
            cancelled
              ? "Organizer run cancelled."
              : reason instanceof Error && reason.message
              ? reason.message
              : "Organizer run failed.";
          const current = state.getSnapshot();
          const activeSnapshot =
            current.run.phase === "running" || latestSummary
              ? current
              : undefined;
          state.updateRun({
            phase: cancelled ? "cancelled" : "failed",
            summary: {
              startedAt:
                latestSummary?.startedAt ??
                activeSnapshot?.run.summary?.startedAt ??
                new Date(started).toISOString(),
              finishedAt: new Date().toISOString(),
              accountCount:
                latestSummary?.accountCount ??
                activeSnapshot?.run.summary?.accountCount ??
                0,
              processedCount:
                latestSummary?.processedCount ??
                activeSnapshot?.run.summary?.processedCount ??
                0,
              counts: current.counts,
              error: cancelled ? undefined : detail,
            },
            checkpoint: {
              at: new Date().toISOString(),
              step: cancelled ? "cancelled" : "failed",
              label: detail,
              processedCount:
                latestSummary?.processedCount ??
                activeSnapshot?.run.summary?.processedCount ??
                0,
              queuedCount: activeSnapshot?.run.checkpoint?.queuedCount,
              accountEmail: activeSnapshot?.run.checkpoint?.accountEmail,
              accountIndex: activeSnapshot?.run.checkpoint?.accountIndex,
              accountCount: activeSnapshot?.run.checkpoint?.accountCount,
              messageIndex: activeSnapshot?.run.checkpoint?.messageIndex,
              messageCount: activeSnapshot?.run.checkpoint?.messageCount,
              subject: activeSnapshot?.run.checkpoint?.subject,
            },
          });
          logOrganizer(
            cancelled ? "info" : "error",
            cancelled ? "run.cancelled" : "run.failed",
            {
              elapsedMs: Date.now() - started,
              logFile: getOrganizerLogPath(),
              ...errorFields(reason),
            },
          );
          if (cancelled) {
            signal.throwIfAborted();
          }
          throw reason;
        }
      },
    );
  };
  const runManager = new OrganizerRunManager(executeOrganizer);
  const runOrganizer: RuntimeServices["runOrganizer"] = (command = {}) => {
    const coalesced =
      runManager.isRunning() &&
      (command.trigger === "push" || command.trigger === "backup");
    if (coalesced) {
      logOrganizer("info", "run.trigger.coalesced", {
        trigger: command.trigger,
        accountIds: command.accountIds,
        hint: "An organizer run is already active; this automatic trigger joined it.",
      });
    }
    return runManager.run(command);
  };

  const monitoring = new MonitoringCoordinator({
    getSettings: () => settingsStore.load(),
    listAccounts,
    getRelayApiKey: () => secretStore.get("relay-api-key"),
    establishPush: async (
      account,
      settings,
    ): Promise<RelayRegisterRequest> => {
      if (account.provider === "outlook") {
        logOrganizer("info", "push.outlook.establish", {
          accountId: account.id,
          email: account.email,
          relayBaseUrl: settings.relayBaseUrl,
        });
        const connector = await createOutlook();
        const adapter = new OutlookGraphAdapter((id) =>
          connector.acquireMailToken(id),
        );
        const stateName = `outlook-client-state-${createHash("sha256")
          .update(account.id)
          .digest("hex")}`;
        let clientState = await secretStore.get(stateName);
        if (!clientState) {
          clientState = randomBytes(32).toString("base64url");
          await secretStore.set(stateName, clientState);
        }
        const subscriptionName = subscriptionSecretName(account.id);
        const existingRaw = await secretStore.get(subscriptionName);
        let subscription: { id: string; expirationDateTime: string };
        if (existingRaw) {
          try {
            const existing = z
              .object({ id: z.string(), expirationDateTime: z.string() })
              .parse(JSON.parse(existingRaw));
            subscription = await adapter.renewSubscription(
              account.id,
              existing.id,
            );
          } catch {
            subscription = await adapter.createSubscription(
              account.id,
              settings.relayBaseUrl,
              clientState,
            );
          }
        } else {
          subscription = await adapter.createSubscription(
            account.id,
            settings.relayBaseUrl,
            clientState,
          );
        }
        await secretStore.set(subscriptionName, JSON.stringify(subscription));
        logOrganizer("info", "push.outlook.subscribed", {
          accountId: account.id,
          email: account.email,
          subscriptionId: subscription.id,
          expirationDateTime: subscription.expirationDateTime,
        });
        return createRelayRegistration(
          account,
          subscription.id,
          subscription.expirationDateTime,
          clientState,
        );
      }
      logOrganizer("info", "push.gmail.establish", {
        accountId: account.id,
        email: account.email,
        topicConfigured: Boolean(settings.googlePubSubTopic),
      });
      if (!settings.googlePubSubTopic) {
        throw new Error("Configure a Google Pub/Sub topic first.");
      }
      const watched = await (await createGmail())
        .createAdapter()
        .startWatch(account.id, settings.googlePubSubTopic);
      return createRelayRegistration(
        account,
        watched.cursor ?? "gmail-watch",
        watched.expiresAt ??
          new Date(Date.now() + 6 * 24 * 60 * 60 * 1_000).toISOString(),
      );
    },
    triggerSync: async (accountId) => {
      logOrganizer("info", "run.trigger-sync", {
        accountId: accountId ?? null,
        trigger: accountId ? "push" : "backup",
      });
      await runOrganizer({
        accountIds: accountId ? [accountId] : undefined,
        trigger: accountId ? "push" : "backup",
      });
    },
    onState: (value) => {
      for (const listener of monitoringListeners) {
        listener(value);
      }
    },
  });

  await settingsStore.load();
  await state.initialize();

  return {
    settingsStore,
    secretStore,
    state,
    monitoring,
    reports,
    listAccounts,
    connectAccount,
    disconnectAccount,
    runOrganizer,
    cancelOrganizer: () => runManager.cancel(),
    getSecretState: async () => {
      const names: OrganizerSecretName[] = [
        "relay-api-key",
        "slack-webhook",
        "ollama-api-key",
        "openrouter-api-key",
        "google-client-secret",
      ];
      const entries = await Promise.all(
        names.map(async (name) => {
          const value = (await secretStore.get(name)) ?? "";
          return [name, value] as const;
        }),
      );
      const values = Object.fromEntries(entries) as SecretState["values"];
      const configured = Object.fromEntries(
        entries.map(([name, value]) => [name, value.length > 0]),
      ) as SecretState["configured"];
      return { configured, values };
    },
    onDeviceCode: (listener) => {
      deviceCodeListeners.add(listener);
      return () => deviceCodeListeners.delete(listener);
    },
    onMonitoringState: (listener) => {
      monitoringListeners.add(listener);
      return () => monitoringListeners.delete(listener);
    },
  };
}

app.on("web-contents-created", (_event, contents) => {
  secureWebContents(contents);
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  // Stay alive in the tray until the user chooses Quit.
});

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.codeshop.emailchecker");
  }
  const userDataPath = app.getPath("userData");
  const runtime = await createRuntime(userDataPath);
  logOrganizer("info", "app.ready", {
    userDataPath,
    logFile: getOrganizerLogPath(),
    hint: "Run the organizer once, then inspect organizer-debug.log for the failure point.",
  });
  const appIcons = resolveAppIcons();
  if (process.platform === "darwin") {
    app.dock?.setIcon(appIcons.windowIcon);
  }
  const appShell = createAppShell({
    iconPath: appIcons.windowIcon,
    notificationIconPath: appIcons.notificationIcon,
    preloadPath,
    loadRenderer,
    isQuitting: () => isQuitting,
    setQuitting: (value) => {
      isQuitting = value;
    },
  });
  app.on("before-quit", () => {
    appShell.dispose();
  });
  registerIpcHandlers(runtime, appShell);
  appShell.createMainWindow();
  appShell.createFloatingWindow();
  appShell.startBackgroundUi({
    getMonitoring: () => runtime.monitoring.getState(),
    getStatus: () => runtime.state.getSnapshot(),
    startMonitoring: () => runtime.monitoring.start(),
    pauseMonitoring: () => runtime.monitoring.pause(),
    runOrganizer: () => runtime.runOrganizer({ trigger: "manual" }),
    onMonitoringState: (listener) => runtime.onMonitoringState(listener),
    onStatusSnapshot: (listener) => runtime.state.subscribe(listener),
  });

  app.on("activate", () => {
    appShell.showMainWindow();
  });
});
