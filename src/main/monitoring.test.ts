import { describe, expect, it, vi } from "vitest";

import {
  MonitoringCoordinator,
  parseRelayPushEvent,
} from "./services/monitoringCoordinator";
import { DEFAULT_ORGANIZER_SETTINGS } from "./services/settingsStore";

describe("relay event validation", () => {
  it("accepts the versioned account-scoped relay event", () => {
    expect(
      parseRelayPushEvent(
        JSON.stringify({
          version: 1,
          eventId: "event-1",
          provider: "gmail",
          accountId: "account-1",
          kind: "mail.changed",
          occurredAt: "2026-08-11T12:00:00.000Z",
          cursor: "123",
        }),
      ),
    ).toMatchObject({ accountId: "account-1", cursor: "123" });
  });

  it("rejects unknown fields, providers, and malformed JSON", () => {
    expect(() =>
      parseRelayPushEvent('{"version":1,"provider":"imap"}'),
    ).toThrow();
    expect(() =>
      parseRelayPushEvent(
        JSON.stringify({
          version: 1,
          eventId: "event-1",
          provider: "gmail",
          accountId: "account-1",
          kind: "mail.changed",
          occurredAt: "2026-08-11T12:00:00.000Z",
          token: "must-not-be-accepted",
        }),
      ),
    ).toThrow();
    expect(() => parseRelayPushEvent("not-json")).toThrow();
  });

  it("reports degraded push while retaining scheduled backup polling", async () => {
    const timers: number[] = [];
    const coordinator = new MonitoringCoordinator({
      getSettings: async () => DEFAULT_ORGANIZER_SETTINGS,
      listAccounts: async () => [],
      getRelayApiKey: async () => undefined,
      establishPush: async () => {
        throw new Error("not expected");
      },
      triggerSync: async () => undefined,
      now: () => new Date(2026, 7, 11, 8, 0),
      setTimer: ((_callback, milliseconds) => {
        timers.push(milliseconds);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: () => undefined,
    });

    await expect(coordinator.start()).resolves.toMatchObject({
      phase: "degraded",
      pushConnected: false,
      backupPolling: true,
    });
    expect(timers).toEqual([30 * 60_000]);
  });

  it("connects directly to the signed Azure Web PubSub URL", async () => {
    const socketListeners = new Map<string, () => void>();
    const socket = {
      on: vi.fn((event: string, listener: () => void) => {
        socketListeners.set(event, listener);
        return socket;
      }),
      close: vi.fn(),
    };
    const createWebSocket = vi.fn(() => socket);
    const onState = vi.fn();
    const fetchMock = vi.fn(async (request: URL | RequestInfo) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/negotiate")) {
        return new Response(
          JSON.stringify({
            version: 1,
            webSocketUrl:
              "wss://relay.webpubsub.azure.com/client/hubs/email?access_token=signed",
            expiresAt: "2026-08-11T13:00:00.000Z",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const coordinator = new MonitoringCoordinator({
      getSettings: async () => ({
        ...DEFAULT_ORGANIZER_SETTINGS,
        relayBaseUrl: "https://relay.example/",
      }),
      listAccounts: async () => [
        {
          id: "account-1",
          provider: "gmail",
          email: "owner@example.com",
          health: { status: "connected" },
        },
      ],
      getRelayApiKey: async () => "relay-key",
      establishPush: async () => ({
        version: 1,
        provider: "gmail",
        accountId: "account-1",
        providerAddress: "owner@example.com",
        resourceId: "history-1",
        expiresAt: "2026-08-12T12:00:00.000Z",
      }),
      triggerSync: async () => undefined,
      fetch: fetchMock as typeof fetch,
      createWebSocket,
      onState,
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    await coordinator.start();
    socketListeners.get("open")?.();

    expect(createWebSocket).toHaveBeenCalledWith(
      "wss://relay.webpubsub.azure.com/client/hubs/email?access_token=signed",
    );
    expect(coordinator.getState()).toMatchObject({
      phase: "active",
      pushConnected: true,
    });

    const updatesBeforeDisconnect = onState.mock.calls.length;
    socketListeners.get("error")?.();
    socketListeners.get("close")?.();
    expect(onState).toHaveBeenCalledTimes(updatesBeforeDisconnect + 1);
  });

  it("pauses organizer runs and resumes them from start without reconnecting", async () => {
    const triggerSync = vi.fn(async () => undefined);
    const coordinator = new MonitoringCoordinator({
      getSettings: async () => DEFAULT_ORGANIZER_SETTINGS,
      listAccounts: async () => [],
      getRelayApiKey: async () => undefined,
      establishPush: async () => {
        throw new Error("not expected");
      },
      triggerSync,
      now: () => new Date(2026, 7, 11, 8, 0),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    await coordinator.start();
    expect(coordinator.pause()).toMatchObject({
      phase: "paused",
      backupPolling: false,
    });
    expect(coordinator.pause()).toMatchObject({ phase: "paused" });
    await expect(coordinator.start()).resolves.toMatchObject({
      phase: "degraded",
      backupPolling: true,
    });
    expect(triggerSync).not.toHaveBeenCalled();
  });

  it("stays stopped when asynchronous startup finishes after Stop", async () => {
    let resolveSettings!: (value: typeof DEFAULT_ORGANIZER_SETTINGS) => void;
    const settings = new Promise<typeof DEFAULT_ORGANIZER_SETTINGS>((resolve) => {
      resolveSettings = resolve;
    });
    const setTimer = vi.fn(
      () => 1 as unknown as ReturnType<typeof setTimeout>,
    );
    const coordinator = new MonitoringCoordinator({
      getSettings: () => settings,
      listAccounts: async () => [],
      getRelayApiKey: async () => undefined,
      establishPush: async () => {
        throw new Error("not expected");
      },
      triggerSync: async () => undefined,
      setTimer,
      clearTimer: vi.fn(),
    });

    const starting = coordinator.start();
    expect(coordinator.stop()).toMatchObject({ phase: "stopped" });
    resolveSettings(DEFAULT_ORGANIZER_SETTINGS);

    await expect(starting).resolves.toMatchObject({
      phase: "stopped",
      backupPolling: false,
      pushConnected: false,
    });
    expect(setTimer).not.toHaveBeenCalled();
  });
});
