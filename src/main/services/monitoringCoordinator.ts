import WebSocket from "ws";
import { z } from "zod";

import type {
  MonitoringState,
  OrganizerSettings,
  ProviderAccountSummary,
  RelayNegotiateResponse,
  RelayPushEvent,
  RelayRegisterRequest,
} from "../../shared/contracts.js";
import {
  isWithinActiveHours,
  nextBackupPollAt,
} from "./monitoringSchedule.js";
import { errorFields, logOrganizer } from "./debugLog.js";

const timestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
export const relayPushEventSchema: z.ZodType<RelayPushEvent> = z
  .object({
    version: z.literal(1),
    eventId: z.string().min(1).max(200),
    provider: z.enum(["outlook", "gmail"]),
    accountId: z.string().min(1).max(500),
    kind: z.enum(["mail.changed", "subscription.lifecycle"]),
    occurredAt: timestampSchema,
    cursor: z.string().max(2_000).optional(),
  })
  .strict();

const negotiateSchema: z.ZodType<RelayNegotiateResponse> = z
  .object({
    version: z.literal(1),
    webSocketUrl: z.string().url(),
    expiresAt: timestampSchema,
  })
  .strict();

export function parseRelayPushEvent(value: string): RelayPushEvent {
  return relayPushEventSchema.parse(JSON.parse(value));
}

interface WebSocketLike {
  on(event: "open", listener: () => void): this;
  on(event: "close" | "error", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  close(): void;
}

export interface MonitoringCoordinatorDependencies {
  getSettings: () => Promise<OrganizerSettings>;
  listAccounts: () => Promise<ProviderAccountSummary[]>;
  getRelayApiKey: () => Promise<string | undefined>;
  establishPush: (
    account: ProviderAccountSummary,
    settings: OrganizerSettings,
  ) => Promise<RelayRegisterRequest>;
  triggerSync: (accountId?: string) => Promise<void>;
  onState?: (state: MonitoringState) => void;
  fetch?: typeof fetch;
  createWebSocket?: (url: string) => WebSocketLike;
  now?: () => Date;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class MonitoringCoordinator {
  private state: MonitoringState = {
    phase: "stopped",
    pushConnected: false,
    backupPolling: false,
    message: "Monitoring is stopped.",
  };
  private socket?: WebSocketLike;
  private backupTimer?: ReturnType<typeof setTimeout>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private paused = false;
  private lifecycleVersion = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly setTimer: NonNullable<MonitoringCoordinatorDependencies["setTimer"]>;
  private readonly clearTimer: NonNullable<MonitoringCoordinatorDependencies["clearTimer"]>;
  private readonly createWebSocket: NonNullable<
    MonitoringCoordinatorDependencies["createWebSocket"]
  >;

  public constructor(private readonly dependencies: MonitoringCoordinatorDependencies) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.setTimer = dependencies.setTimer ?? setTimeout;
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
    this.createWebSocket =
      dependencies.createWebSocket ??
      ((url) => new WebSocket(url));
  }

  public getState(): MonitoringState {
    return structuredClone(this.state);
  }

  public async start(): Promise<MonitoringState> {
    if (this.paused && !this.stopped) {
      return this.resume();
    }
    if (!this.stopped) {
      return this.getState();
    }
    this.stopped = false;
    this.paused = false;
    const lifecycleVersion = ++this.lifecycleVersion;
    logOrganizer("info", "monitoring.start", {
      hint: "Push + backup polling are starting.",
    });
    this.update({
      phase: "starting",
      pushConnected: false,
      backupPolling: true,
      message: "Starting push monitoring and backup polling.",
      startedAt: this.now().toISOString(),
    });
    const settings = await this.dependencies.getSettings();
    if (!this.isCurrent(lifecycleVersion)) {
      return this.getState();
    }
    this.scheduleBackup(settings, lifecycleVersion);

    try {
      const [accounts, apiKey] = await Promise.all([
        this.dependencies.listAccounts(),
        this.dependencies.getRelayApiKey(),
      ]);
      if (!this.isCurrent(lifecycleVersion)) {
        return this.getState();
      }
      logOrganizer("info", "monitoring.push.setup", {
        accountCount: accounts.length,
        relayConfigured: Boolean(settings.relayBaseUrl),
        apiKeyConfigured: Boolean(apiKey),
        relayBaseUrl: settings.relayBaseUrl,
      });
      if (!settings.relayBaseUrl || !apiKey || accounts.length === 0) {
        throw new Error(
          "Push is unavailable until relay configuration and accounts are present.",
        );
      }
      const registrations = await Promise.all(
        accounts.map((account) =>
          this.dependencies.establishPush(account, settings),
        ),
      );
      if (!this.isCurrent(lifecycleVersion)) {
        return this.getState();
      }
      const negotiation = await this.post<RelayNegotiateResponse>(
        settings.relayBaseUrl,
        "/api/desktop/negotiate",
        apiKey,
        { version: 1 },
        negotiateSchema,
      );
      if (!this.isCurrent(lifecycleVersion)) {
        return this.getState();
      }
      for (const registration of registrations) {
        await this.post(
          settings.relayBaseUrl,
          "/api/desktop/register",
          apiKey,
          registration,
          z.object({ ok: z.literal(true) }).strict(),
        );
        if (!this.isCurrent(lifecycleVersion)) {
          return this.getState();
        }
      }
      this.connectSocket(negotiation, accounts, lifecycleVersion);
      this.scheduleRenewal(
        settings,
        registrations,
        accounts,
        apiKey,
        lifecycleVersion,
      );
    } catch (reason) {
      if (!this.isCurrent(lifecycleVersion)) {
        return this.getState();
      }
      logOrganizer("warn", "monitoring.push.unavailable", {
        hint: "Backup polling remains active.",
        ...errorFields(reason),
      });
      this.update({
        ...this.state,
        phase: "degraded",
        pushConnected: false,
        backupPolling: true,
        message:
          reason instanceof Error
            ? reason.message
            : "Push is unavailable; backup polling remains active.",
      });
    }
    if (this.paused) {
      return this.pause();
    }
    return this.getState();
  }

  public pause(): MonitoringState {
    if (this.stopped) {
      return this.getState();
    }
    this.paused = true;
    logOrganizer("info", "monitoring.pause", {
      hint: "Push stays connected; organizer runs are skipped until Run.",
    });
    this.update({
      ...this.state,
      phase: "paused",
      backupPolling: false,
      message: "Organizer is paused. Incoming mail will not be processed.",
    });
    return this.getState();
  }

  private resume(): MonitoringState {
    this.paused = false;
    logOrganizer("info", "monitoring.resume", {});
    this.update({
      ...this.state,
      phase: this.state.pushConnected ? "active" : "degraded",
      backupPolling: true,
      message: this.state.pushConnected
        ? "Organizer resumed. Push monitoring is connected with backup polling enabled."
        : "Organizer resumed. Backup polling is active.",
    });
    return this.getState();
  }

  public stop(): MonitoringState {
    logOrganizer("info", "monitoring.stop", {});
    this.stopped = true;
    this.paused = false;
    this.lifecycleVersion += 1;
    this.socket?.close();
    this.socket = undefined;
    if (this.backupTimer) {
      this.clearTimer(this.backupTimer);
      this.backupTimer = undefined;
    }
    if (this.renewalTimer) {
      this.clearTimer(this.renewalTimer);
      this.renewalTimer = undefined;
    }
    this.update({
      phase: "stopped",
      pushConnected: false,
      backupPolling: false,
      message: "Monitoring is stopped.",
    });
    return this.getState();
  }

  private scheduleBackup(
    settings: OrganizerSettings,
    lifecycleVersion: number,
  ): void {
    if (!this.isCurrent(lifecycleVersion)) {
      return;
    }
    const next = nextBackupPollAt(
      this.now(),
      settings.backupPollMinutes,
      settings.activeHours,
    );
    this.update({
      ...this.state,
      backupPolling: !this.paused,
      nextBackupPollAt: next.toISOString(),
    });
    this.backupTimer = this.setTimer(() => {
      void (async () => {
        if (!this.isCurrent(lifecycleVersion)) {
          return;
        }
        if (
          !this.stopped &&
          !this.paused &&
          isWithinActiveHours(this.now(), settings.activeHours)
        ) {
          logOrganizer("info", "monitoring.backup-poll", {
            nextBackupPollAt: next.toISOString(),
            hint: "Triggering organizer run from backup poll.",
          });
          try {
            await this.dependencies.triggerSync();
          } catch (reason) {
            logOrganizer(
              this.stopped ? "info" : "warn",
              this.stopped
                ? "monitoring.backup-poll.cancelled"
                : "monitoring.backup-poll.failed",
              errorFields(reason),
            );
          }
        } else if (!this.stopped && this.paused) {
          logOrganizer("info", "monitoring.backup-poll.paused", {
            hint: "Backup poll skipped because the organizer is paused.",
          });
        } else if (!this.stopped) {
          logOrganizer("info", "monitoring.backup-poll.outside-hours", {
            activeHours: settings.activeHours,
          });
        }
        if (this.isCurrent(lifecycleVersion)) {
          this.scheduleBackup(settings, lifecycleVersion);
        }
      })();
    }, Math.max(0, next.getTime() - this.now().getTime()));
  }

  private connectSocket(
    negotiation: RelayNegotiateResponse,
    accounts: readonly ProviderAccountSummary[],
    lifecycleVersion: number,
  ): void {
    const url = new URL(negotiation.webSocketUrl);
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "wss:" && !(loopback && url.protocol === "ws:")) {
      throw new Error("Relay WebSocket must use WSS unless it is loopback.");
    }
    const known = new Map(accounts.map((account) => [account.id, account.provider]));
    const socket = this.createWebSocket(url.toString());
    this.socket = socket;
    socket.on("open", () => {
      if (!this.isCurrent(lifecycleVersion)) {
        socket.close();
        return;
      }
      if (this.paused) {
        this.update({
          ...this.state,
          phase: "paused",
          pushConnected: true,
          backupPolling: false,
          message:
            "Automatic runs are paused. Push remains connected; active work can finish.",
        });
        return;
      }
      this.update({
        ...this.state,
        phase: "active",
        pushConnected: true,
        backupPolling: true,
        message: "Push monitoring is connected with backup polling enabled.",
      });
    });
    socket.on("message", (data) => {
      if (!this.isCurrent(lifecycleVersion)) {
        return;
      }
      try {
        const event = parseRelayPushEvent(
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString("utf8")
              : "",
        );
        if (known.get(event.accountId) !== event.provider) {
          logOrganizer("warn", "monitoring.push.unknown-account", {
            accountId: event.accountId,
            provider: event.provider,
            kind: event.kind,
          });
          return;
        }
        logOrganizer("info", "monitoring.push.event", {
          eventId: event.eventId,
          accountId: event.accountId,
          provider: event.provider,
          kind: event.kind,
          cursor: event.cursor,
        });
        if (this.paused) {
          logOrganizer("info", "monitoring.push.paused", {
            accountId: event.accountId,
            hint: "Push event ignored because the organizer is paused.",
          });
          return;
        }
        void this.dependencies.triggerSync(event.accountId).catch((reason) => {
          logOrganizer(
            this.stopped ? "info" : "warn",
            this.stopped
              ? "monitoring.push.cancelled"
              : "monitoring.push.failed",
            {
              accountId: event.accountId,
              ...errorFields(reason),
            },
          );
        });
      } catch {
        // Invalid relay events are ignored without logging their content.
      }
    });
    const degrade = () => {
      if (!this.isCurrent(lifecycleVersion)) {
        return;
      }
      if (this.paused) {
        this.update({
          ...this.state,
          pushConnected: false,
          backupPolling: false,
          message:
            "Organizer is paused. Push disconnected; runs stay skipped until Run.",
        });
        return;
      }
      this.update({
        ...this.state,
        phase: "degraded",
        pushConnected: false,
        backupPolling: true,
        message: "Push connection is unavailable; backup polling remains active.",
      });
    };
    socket.on("close", degrade);
    socket.on("error", degrade);
  }

  private scheduleRenewal(
    settings: OrganizerSettings,
    registrations: readonly RelayRegisterRequest[],
    accounts: readonly ProviderAccountSummary[],
    apiKey: string,
    lifecycleVersion: number,
  ): void {
    if (!this.isCurrent(lifecycleVersion)) {
      return;
    }
    const earliest = Math.min(
      ...registrations.map((item) => Date.parse(item.expiresAt)),
    );
    const delay = Math.max(60_000, earliest - this.now().getTime() - 15 * 60_000);
    this.renewalTimer = this.setTimer(() => {
      void (async () => {
        if (!this.isCurrent(lifecycleVersion)) {
          return;
        }
        try {
          const renewed = await Promise.all(
            accounts.map((account) =>
              this.dependencies.establishPush(account, settings),
            ),
          );
          for (const registration of renewed) {
            await this.post(
              settings.relayBaseUrl,
              "/api/desktop/register",
              apiKey,
              registration,
              z.object({ ok: z.literal(true) }).strict(),
            );
            if (!this.isCurrent(lifecycleVersion)) {
              return;
            }
          }
          this.scheduleRenewal(
            settings,
            renewed,
            accounts,
            apiKey,
            lifecycleVersion,
          );
        } catch {
          if (!this.isCurrent(lifecycleVersion)) {
            return;
          }
          this.update({
            ...this.state,
            phase: "degraded",
            pushConnected: false,
            backupPolling: true,
            message: "Push renewal failed; backup polling remains active.",
          });
        }
      })();
    }, delay);
  }

  private async post<T>(
    baseUrl: string,
    path: string,
    apiKey: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.fetchImpl(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logOrganizer("error", "monitoring.relay.failed", {
        path,
        status: response.status,
        body,
      });
      throw new Error(`Relay request failed (${response.status}).`);
    }
    return schema.parse(await response.json());
  }

  private update(state: MonitoringState): void {
    if (
      this.state.phase === state.phase &&
      this.state.pushConnected === state.pushConnected &&
      this.state.backupPolling === state.backupPolling &&
      this.state.message === state.message &&
      this.state.startedAt === state.startedAt &&
      this.state.nextBackupPollAt === state.nextBackupPollAt
    ) {
      return;
    }
    this.state = state;
    this.dependencies.onState?.(this.getState());
  }

  private isCurrent(lifecycleVersion: number): boolean {
    return !this.stopped && this.lifecycleVersion === lifecycleVersion;
  }
}
