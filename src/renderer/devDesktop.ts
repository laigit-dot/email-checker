import type {
  DesktopApi,
  MonitoringState,
  OrganizerSettings,
  SecretState,
  StatusSnapshot,
} from "../shared/contracts";

function createEmptySnapshot(): StatusSnapshot {
  return {
    state: "idle",
    message: "Connect an account and run the organizer to build local history.",
    generatedAt: new Date().toISOString(),
    counts: {
      total: 0,
      unread: 0,
      organized: 0,
      failed: 0,
      urgent: 0,
    },
    emails: [],
    run: { phase: "idle" },
  };
}

const defaultSettings = (): OrganizerSettings => ({
  aiProvider: "ollama",
  ollamaUrl: "http://127.0.0.1:11434",
  model: "qwen3:8b",
  prompt: "Classify the email using only the supplied fields.",
  selectedAccountIds: [],
  folders: [
    "Action Required",
    "Receipts",
    "Newsletters",
    "Updates",
    "Personal",
    "Review",
  ],
  rootFolder: "AI Organized",
  confidenceThreshold: 0.65,
  scanLimit: 25,
  dryRun: true,
  markAsRead: false,
  unreadOnly: true,
  activeHours: { start: "07:30", end: "23:30" },
  backupPollMinutes: 30,
  relayBaseUrl: "",
  azureClientId: "",
  azureTenantId: "organizations",
  googleClientId: "",
  googlePubSubTopic: "",
});

/**
 * Browser-only fallback when the Electron preload bridge is absent.
 * Provides empty production-shaped state — never invents inbox datasets.
 */
export function installDevelopmentDesktopBridge(): void {
  if (window.desktop) {
    return;
  }

  if (!import.meta.env.DEV) {
    throw new Error("The secure desktop preload bridge is unavailable.");
  }

  let snapshot = createEmptySnapshot();
  let settings = defaultSettings();
  let monitoring: MonitoringState = {
    phase: "stopped",
    pushConnected: false,
    backupPolling: false,
    message: "Desktop bridge waiting for Electron runtime.",
  };

  const navigate = (route: "main" | "floating" | "sidebar" | "peek") => {
    window.location.search = `?window=${route}`;
  };

  const emptySecrets = (): SecretState => ({
    configured: {
      "relay-api-key": false,
      "slack-webhook": false,
      "ollama-api-key": false,
      "openrouter-api-key": false,
      "google-client-secret": false,
    },
    values: {
      "relay-api-key": "",
      "slack-webhook": "",
      "ollama-api-key": "",
      "openrouter-api-key": "",
      "google-client-secret": "",
    },
  });

  const api: DesktopApi = {
    window: {
      close: () => undefined,
      minimize: () => undefined,
      showFloating: () => navigate("floating"),
      restoreMain: () => navigate("main"),
      showSidebar: () => navigate("sidebar"),
      onShellMotion: () => () => undefined,
    },
    openEmail: async () => false,
    settings: {
      get: async () => ({
        settings: structuredClone(settings),
        secrets: emptySecrets(),
      }),
      save: async (next) => {
        settings = structuredClone(next);
        return structuredClone(settings);
      },
      setSecret: async () => emptySecrets(),
      deleteSecret: async () => emptySecrets(),
      listAiModels: async () => {
        throw new Error("Model listing requires the Electron desktop app.");
      },
    },
    accounts: {
      list: async () => [],
      connect: async () => {
        throw new Error(
          "Account connection requires the Electron desktop app.",
        );
      },
      disconnect: async () => true,
      onDeviceCode: () => () => undefined,
    },
    organizer: {
      runNow: async () => ({
        ok: true,
        summary: {
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          accountCount: 0,
          processedCount: 0,
          counts: snapshot.counts,
        },
      }),
    },
    monitoring: {
      getState: async () => structuredClone(monitoring),
      start: async () => {
        monitoring = {
          phase: "active",
          pushConnected: false,
          backupPolling: true,
          message: "Organizer is running in the browser preview.",
        };
        return structuredClone(monitoring);
      },
      pause: async () => {
        monitoring = {
          phase: "paused",
          pushConnected: false,
          backupPolling: false,
          message: "Organizer is paused.",
        };
        return structuredClone(monitoring);
      },
      stop: async () => {
        monitoring = {
          phase: "stopped",
          pushConnected: false,
          backupPolling: false,
          message: "Monitoring is stopped.",
        };
        return structuredClone(monitoring);
      },
      onStateUpdate: () => () => undefined,
    },
    reports: {
      list: async () => [],
      open: async () => false,
    },
    data: {
      getStatus: async () => structuredClone(snapshot),
      onStatusUpdate: () => () => undefined,
    },
  };

  Object.defineProperty(window, "desktop", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(api),
  });
}
