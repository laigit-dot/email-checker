export type Provider = "outlook" | "gmail";

export type ProviderHealthStatus =
  | "connected"
  | "degraded"
  | "disconnected"
  | "error";

export interface ProviderHealth {
  status: ProviderHealthStatus;
  message?: string;
  lastCheckedAt?: string;
}

export interface ProviderAccountSummary {
  id: string;
  provider: Provider;
  email: string;
  displayName?: string;
  health: ProviderHealth;
}

export interface ActiveHours {
  start: string;
  end: string;
}

export interface EmailStatus {
  unread: boolean;
  organized: boolean;
  failed: boolean;
  urgent: boolean;
}

export interface ProcessingFailure {
  operation: "classify" | "organize" | "mark-read" | "unknown";
  detail: string;
  occurredAt: string;
}

export interface EmailRecord {
  id: string;
  provider: Provider;
  accountId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  processedAt: string;
  webUrl: string;
  status: EmailStatus;
  destinationFolder?: string;
  summary?: string;
  reason?: string;
  confidence?: number;
  failure?: ProcessingFailure;
}

export interface StatusCounts {
  total: number;
  unread: number;
  organized: number;
  failed: number;
  urgent: number;
}

export interface FolderRule {
  name: string;
  prompt: string;
}

export interface OrganizerSettings {
  aiProvider: AiProvider;
  ollamaUrl: string;
  model: string;
  selectedAccountIds: string[];
  folders: FolderRule[];
  rootFolder: string;
  confidenceThreshold: number;
  scanLimit: number;
  dryRun: boolean;
  markAsRead: boolean;
  unreadOnly: boolean;
  activeHours: ActiveHours;
  backupPollMinutes: number;
  relayBaseUrl: string;
  azureClientId: string;
  azureTenantId: string;
  googleClientId: string;
  googlePubSubTopic: string;
}

export type AiProvider = "ollama" | "openrouter";

export type OrganizerSecretName =
  | "relay-api-key"
  | "slack-webhook"
  | "ollama-api-key"
  | "openrouter-api-key"
  | "google-client-secret";

export interface AiModelOption {
  id: string;
  label: string;
}

export interface ListAiModelsRequest {
  provider: AiProvider;
  endpoint?: string;
  apiKey?: string;
}

export interface ListAiModelsResult {
  models: AiModelOption[];
}

export interface SetSecretCommand {
  name: OrganizerSecretName;
  value: string;
}

export interface SecretState {
  configured: Record<OrganizerSecretName, boolean>;
  values: Record<OrganizerSecretName, string>;
}

export interface Classification {
  folder: string;
  summary: string;
  reason: string;
  confidence: number;
  urgent: boolean;
}

export type OrganizerRunPhase =
  | "idle"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export type RunCheckpointStep =
  | "starting"
  | "fetching"
  | "classifying"
  | "filing"
  | "completing"
  | "cancelled"
  | "failed";

export interface RunCheckpoint {
  at: string;
  step: RunCheckpointStep;
  label: string;
  processedCount: number;
  queuedCount?: number;
  accountEmail?: string;
  accountIndex?: number;
  accountCount?: number;
  messageIndex?: number;
  messageCount?: number;
  subject?: string;
}

export interface RunSummary {
  startedAt: string;
  finishedAt?: string;
  accountCount: number;
  processedCount: number;
  counts: StatusCounts;
  error?: string;
}

export interface RunState {
  phase: OrganizerRunPhase;
  summary?: RunSummary;
  checkpoint?: RunCheckpoint;
}

export interface OrganizerRunCommand {
  accountIds?: string[];
  trigger?: "manual" | "push" | "backup";
}

export interface OrganizerRunResult {
  ok: boolean;
  summary: RunSummary;
}

export interface DeviceCodeNotice {
  provider: "outlook";
  userCode: string;
  verificationUri: string;
  message: string;
  expiresAt: string;
}

export type MonitoringPhase =
  | "stopped"
  | "starting"
  | "active"
  | "paused"
  | "degraded";

export interface MonitoringState {
  phase: MonitoringPhase;
  pushConnected: boolean;
  backupPolling: boolean;
  message: string;
  startedAt?: string;
  nextBackupPollAt?: string;
}

export interface ReportInsights {
  generatedAt?: string;
  run?: RunSummary;
  emails: EmailRecord[];
}

export interface ReportSummary {
  name: string;
  format: "json" | "csv";
  createdAt: string;
  size: number;
  insights?: ReportInsights;
}

export interface RelayRegisterRequest {
  version: 1;
  accountId: string;
  provider: Provider;
  providerAddress: string;
  resourceId: string;
  expiresAt: string;
  verificationSecret?: string;
}

export interface RelayNegotiateResponse {
  version: 1;
  webSocketUrl: string;
  expiresAt: string;
}

export interface RelayPushEvent {
  version: 1;
  eventId: string;
  provider: Provider;
  accountId: string;
  kind: "mail.changed" | "subscription.lifecycle";
  occurredAt: string;
  cursor?: string;
}

export interface StatusSnapshot {
  state: OrganizerRunPhase;
  message: string;
  generatedAt: string;
  counts: StatusCounts;
  emails: EmailRecord[];
  run: RunState;
}

export type StatusSnapshotListener = (snapshot: StatusSnapshot) => void;
export type DeviceCodeNoticeListener = (notice: DeviceCodeNotice) => void;
export type MonitoringStateListener = (state: MonitoringState) => void;
export type ShellMotion = "enter" | "exit";
export type ShellMotionListener = (motion: ShellMotion) => void;

export interface DesktopApi {
  window: {
    close: () => void;
    minimize: () => void;
    showFloating: () => void;
    restoreMain: () => void;
    showSidebar: () => void;
    onShellMotion: (listener: ShellMotionListener) => () => void;
  };
  openEmail: (url: string) => Promise<boolean>;
  settings: {
    get: () => Promise<{
      settings: OrganizerSettings;
      secrets: SecretState;
    }>;
    save: (settings: OrganizerSettings) => Promise<OrganizerSettings>;
    setSecret: (command: SetSecretCommand) => Promise<SecretState>;
    deleteSecret: (name: OrganizerSecretName) => Promise<SecretState>;
    listAiModels: (
      request: ListAiModelsRequest,
    ) => Promise<ListAiModelsResult>;
  };
  accounts: {
    list: () => Promise<ProviderAccountSummary[]>;
    connect: (provider: Provider) => Promise<ProviderAccountSummary>;
    disconnect: (provider: Provider, accountId: string) => Promise<boolean>;
    onDeviceCode: (listener: DeviceCodeNoticeListener) => () => void;
  };
  organizer: {
    runNow: (command?: OrganizerRunCommand) => Promise<OrganizerRunResult>;
  };
  monitoring: {
    getState: () => Promise<MonitoringState>;
    start: () => Promise<MonitoringState>;
    pause: () => Promise<MonitoringState>;
    stop: () => Promise<MonitoringState>;
    onStateUpdate: (listener: MonitoringStateListener) => () => void;
  };
  reports: {
    list: () => Promise<ReportSummary[]>;
    open: (name: string) => Promise<boolean>;
  };
  data: {
    getStatus: () => Promise<StatusSnapshot>;
    onStatusUpdate: (listener: StatusSnapshotListener) => () => void;
  };
}
