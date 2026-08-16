import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  screen,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";

import type {
  MonitoringState,
  StatusSnapshot,
} from "../shared/contracts.js";
import {
  createEmailNotification,
  emailIdentity,
  findNewEmails,
} from "./desktopNotifications.js";
import {
  boundsChanged,
  interpolate,
  peekWindowBounds,
  PEEK_EXIT_MS,
  PEEK_HEIGHT,
  PEEK_WIDTH,
  shouldShowLeftEdgePeek,
  sidebarHiddenBounds,
  sidebarWindowBounds,
  SIDEBAR_SLIDE_MS,
  type ScreenRect,
} from "./edgePeek.js";
import { loadWithRetry } from "./windowLoading.js";

export type ShellWindowRoute = "main" | "floating" | "sidebar" | "peek";

/** Opaque shell color — must stay non-transparent so Windows can draw DWM shadow outside the HWND. */
export const WINDOW_BACKGROUND = "#e6eee8";

const EDGE_POLL_MS = 80;

export interface AppShellOptions {
  iconPath: string;
  notificationIconPath?: string;
  preloadPath: string;
  loadRenderer: (
    window: BrowserWindow,
    route: ShellWindowRoute,
  ) => Promise<void>;
  isQuitting: () => boolean;
  setQuitting: (value: boolean) => void;
}

export interface TrayRuntime {
  getMonitoring: () => MonitoringState;
  getStatus: () => StatusSnapshot;
  startMonitoring: () => Promise<unknown> | unknown;
  pauseMonitoring: () => Promise<unknown> | unknown;
  runOrganizer: () => Promise<unknown> | unknown;
  onMonitoringState: (
    listener: (state: MonitoringState) => void,
  ) => () => void;
  onStatusSnapshot: (
    listener: (snapshot: StatusSnapshot) => void,
  ) => () => void;
}

export interface AppShell {
  getMainWindow: () => BrowserWindow | null;
  getFloatingWindow: () => BrowserWindow | null;
  getSidebarWindow: () => BrowserWindow | null;
  isOwnedWindow: (window: BrowserWindow) => boolean;
  createMainWindow: () => BrowserWindow;
  createFloatingWindow: () => BrowserWindow;
  showMainWindow: () => void;
  hideMainToTray: () => void;
  showFloatingWindow: () => void;
  restoreMainWindow: () => void;
  showSidebar: () => void;
  hideSidebar: () => void;
  hideSenderWindow: (window: BrowserWindow) => void;
  startBackgroundUi: (runtime: TrayRuntime) => void;
  dispose: () => void;
}

function withNativeWindowShadow(
  options: BrowserWindowConstructorOptions,
): BrowserWindowConstructorOptions {
  return {
    ...options,
    frame: false,
    transparent: false,
    backgroundColor: WINDOW_BACKGROUND,
    hasShadow: options.hasShadow ?? true,
    roundedCorners: options.roundedCorners ?? true,
  };
}

function enableNativeWindowShadow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  window.setBackgroundColor(WINDOW_BACKGROUND);
  window.setHasShadow(true);
}

function loadNativeIcon(path: string): NativeImage | string {
  const image = nativeImage.createFromPath(path);
  return image.isEmpty() ? path : image;
}

export function createAppShell(options: AppShellOptions): AppShell {
  const windowIcon = loadNativeIcon(options.iconPath);
  const notificationIcon = loadNativeIcon(
    options.notificationIconPath ?? options.iconPath,
  );
  const ownedWindows = new Set<BrowserWindow>();
  let mainWindow: BrowserWindow | null = null;
  let floatingWindow: BrowserWindow | null = null;
  let floatingWindowReady = false;
  let sidebarWindow: BrowserWindow | null = null;
  let sidebarWindowReady = false;
  let peekWindow: BrowserWindow | null = null;
  let peekWindowReady = false;
  let peekRevealPending = false;
  let peekOpen = false;
  let peekMotionGeneration = 0;
  let sidebarRevealPending = false;
  let sidebarOpen = false;
  let sidebarMotionGeneration = 0;
  let tray: Tray | null = null;
  let edgeTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeMonitoring: (() => void) | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  const activeNotifications = new Set<Notification>();

  const applyAppIcon = (window: BrowserWindow): void => {
    if (window.isDestroyed()) {
      return;
    }
    window.setIcon(windowIcon);
  };

  const registerOwnedWindow = (window: BrowserWindow): void => {
    ownedWindows.add(window);
    applyAppIcon(window);
    window.webContents.on("page-favicon-updated", () => applyAppIcon(window));
    window.on("ready-to-show", () => applyAppIcon(window));
    window.once("closed", () => ownedWindows.delete(window));
  };

  const loadWindowRenderer = (
    window: BrowserWindow,
    route: ShellWindowRoute,
  ): void => {
    void loadWithRetry(() => options.loadRenderer(window, route)).catch(
      (reason: unknown) => {
        console.error(`Failed to load the ${route} window after retries.`, reason);
        if (!window.isDestroyed()) {
          window.destroy();
        }
      },
    );
  };

  const preventCloseUnlessQuitting = (window: BrowserWindow): void => {
    window.on("close", (event) => {
      if (options.isQuitting()) {
        return;
      }
      event.preventDefault();
      if (window === mainWindow) {
        hideMainToTray();
        return;
      }
      if (window === sidebarWindow) {
        hideSidebar();
        return;
      }
      if (window === peekWindow) {
        hidePeek();
        return;
      }
      window.hide();
    });
  };

  const createMainWindow = (): BrowserWindow => {
    const window = new BrowserWindow(
      withNativeWindowShadow({
        width: 1240,
        height: 800,
        minWidth: 900,
        minHeight: 620,
        show: false,
        autoHideMenuBar: true,
        resizable: true,
        maximizable: true,
        minimizable: false,
        thickFrame: true,
        icon: windowIcon,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          preload: options.preloadPath,
        },
      }),
    );

    registerOwnedWindow(window);
    window.on("show", () => {
      hidePeek();
      hideSidebar();
    });
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        enableNativeWindowShadow(window);
        window.show();
      }
    });
    preventCloseUnlessQuitting(window);
    window.once("closed", () => {
      if (mainWindow === window) {
        mainWindow = null;
      }
    });
    loadWindowRenderer(window, "main");
    mainWindow = window;
    return window;
  };

  const createFloatingWindow = (): BrowserWindow => {
    const window = new BrowserWindow(
      withNativeWindowShadow({
        width: 430,
        height: 520,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        icon: windowIcon,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          preload: options.preloadPath,
        },
      }),
    );

    floatingWindowReady = false;
    registerOwnedWindow(window);
    window.once("ready-to-show", () => {
      floatingWindowReady = true;
      enableNativeWindowShadow(window);
    });
    preventCloseUnlessQuitting(window);
    window.once("closed", () => {
      if (floatingWindow === window) {
        floatingWindow = null;
        floatingWindowReady = false;
      }
    });
    loadWindowRenderer(window, "floating");
    floatingWindow = window;
    return window;
  };

  const createSidebarWindow = (): BrowserWindow => {
    const workArea = screen.getPrimaryDisplay().workArea;
    const bounds = sidebarWindowBounds(workArea);
    const window = new BrowserWindow(
      withNativeWindowShadow({
        ...bounds,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        movable: false,
        icon: windowIcon,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          preload: options.preloadPath,
        },
      }),
    );

    sidebarWindowReady = false;
    registerOwnedWindow(window);
    window.once("ready-to-show", () => {
      sidebarWindowReady = true;
      enableNativeWindowShadow(window);
    });
    preventCloseUnlessQuitting(window);
    window.once("closed", () => {
      if (sidebarWindow === window) {
        sidebarWindow = null;
        sidebarWindowReady = false;
        sidebarOpen = false;
      }
    });
    loadWindowRenderer(window, "sidebar");
    sidebarWindow = window;
    return window;
  };

  const createPeekWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: PEEK_WIDTH,
      height: PEEK_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      movable: false,
      focusable: true,
      fullscreenable: false,
      hasShadow: false,
      roundedCorners: false,
      type: "toolbar",
      icon: windowIcon,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: options.preloadPath,
      },
    });

    peekWindowReady = false;
    registerOwnedWindow(window);
    window.setAlwaysOnTop(true, "status");
    window.setBackgroundColor("#00000000");
    window.once("ready-to-show", () => {
      peekWindowReady = true;
    });
    preventCloseUnlessQuitting(window);
    window.once("closed", () => {
      if (peekWindow === window) {
        peekWindow = null;
        peekWindowReady = false;
        peekOpen = false;
      }
    });
    loadWindowRenderer(window, "peek");
    peekWindow = window;
    return window;
  };

  const sendShellMotion = (
    window: BrowserWindow | null,
    motion: "enter" | "exit",
  ): void => {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send("shell:motion", motion);
  };

  const animateWindowBounds = (
    window: BrowserWindow,
    to: ScreenRect,
    durationMs: number,
    generation: number,
    currentGeneration: () => number,
  ): Promise<void> => {
    return new Promise((resolve) => {
      if (window.isDestroyed() || generation !== currentGeneration()) {
        resolve();
        return;
      }

      const from = window.getBounds();
      const startedAt = Date.now();
      const step = (): void => {
        if (window.isDestroyed() || generation !== currentGeneration()) {
          resolve();
          return;
        }

        const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
        window.setBounds(
          {
            x: interpolate(from.x, to.x, progress),
            y: interpolate(from.y, to.y, progress),
            width: interpolate(from.width, to.width, progress),
            height: interpolate(from.height, to.height, progress),
          },
          false,
        );

        if (progress < 1) {
          setTimeout(step, 16);
          return;
        }

        resolve();
      };

      step();
    });
  };

  const hidePeek = (): void => {
    if (!peekOpen) {
      return;
    }

    peekOpen = false;
    const generation = ++peekMotionGeneration;
    sendShellMotion(peekWindow, "exit");
    setTimeout(() => {
      if (generation !== peekMotionGeneration) {
        return;
      }
      if (peekWindow && !peekWindow.isDestroyed() && peekWindow.isVisible()) {
        peekWindow.hide();
      }
    }, PEEK_EXIT_MS);
  };

  const mainIsVisible = (): boolean =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());

  const sidebarIsVisible = (): boolean =>
    Boolean(sidebarWindow && !sidebarWindow.isDestroyed() && sidebarWindow.isVisible());

  const hideSidebar = (): void => {
    if (!sidebarOpen || !sidebarWindow || sidebarWindow.isDestroyed()) {
      sidebarOpen = false;
      return;
    }

    sidebarOpen = false;
    const generation = ++sidebarMotionGeneration;
    const current = sidebarWindow.getBounds();
    const hidden = { ...current, x: current.x - current.width };
    void animateWindowBounds(
      sidebarWindow,
      hidden,
      SIDEBAR_SLIDE_MS,
      generation,
      () => sidebarMotionGeneration,
    ).then(() => {
      if (generation !== sidebarMotionGeneration) {
        return;
      }
      if (sidebarWindow && !sidebarWindow.isDestroyed()) {
        sidebarWindow.hide();
      }
    });
  };

  const showSidebar = (): void => {
    if (mainIsVisible()) {
      return;
    }

    if (!sidebarWindow || sidebarWindow.isDestroyed()) {
      sidebarWindow = createSidebarWindow();
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = sidebarWindowBounds(display.workArea);
    const hidden = sidebarHiddenBounds(display.workArea);
    hidePeek();

    if (sidebarWindow.isVisible()) {
      sidebarOpen = true;
      const generation = ++sidebarMotionGeneration;
      sidebarWindow.setAlwaysOnTop(true, "status");
      if (boundsChanged(sidebarWindow.getBounds(), bounds, 0)) {
        void animateWindowBounds(
          sidebarWindow,
          bounds,
          SIDEBAR_SLIDE_MS,
          generation,
          () => sidebarMotionGeneration,
        );
      }
      sidebarWindow.focus();
      return;
    }

    sidebarOpen = true;
    const generation = ++sidebarMotionGeneration;
    const reveal = () => {
      sidebarRevealPending = false;
      if (
        generation !== sidebarMotionGeneration ||
        !sidebarWindow ||
        sidebarWindow.isDestroyed()
      ) {
        return;
      }
      sidebarWindow.setBounds(hidden, false);
      sidebarWindow.setAlwaysOnTop(true, "status");
      sidebarWindow.show();
      sidebarWindow.focus();
      void animateWindowBounds(
        sidebarWindow,
        bounds,
        SIDEBAR_SLIDE_MS,
        generation,
        () => sidebarMotionGeneration,
      );
    };

    if (sidebarWindowReady) {
      reveal();
      return;
    }

    if (!sidebarRevealPending) {
      sidebarRevealPending = true;
      sidebarWindow.once("ready-to-show", reveal);
    }
  };

  const hideMainToTray = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.setSkipTaskbar(true);
    mainWindow.hide();
  };

  const showMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
    }

    hidePeek();
    hideSidebar();
    floatingWindow?.hide();
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
  };

  const showFloatingWindow = (): void => {
    if (!floatingWindow || floatingWindow.isDestroyed()) {
      floatingWindow = createFloatingWindow();
    }

    if (floatingWindowReady) {
      mainWindow?.hide();
      floatingWindow.show();
      floatingWindow.focus();
      return;
    }

    floatingWindow.once("ready-to-show", () => {
      mainWindow?.hide();
      floatingWindow?.show();
      floatingWindow?.focus();
    });
  };

  const restoreMainWindow = (): void => {
    floatingWindow?.hide();
    hideSidebar();
    showMainWindow();
  };

  const hideSenderWindow = (window: BrowserWindow): void => {
    if (window === mainWindow) {
      hideMainToTray();
      return;
    }
    if (window === sidebarWindow) {
      hideSidebar();
      return;
    }
    if (window === peekWindow) {
      hidePeek();
      return;
    }
    window.hide();
  };

  const showPeekAtCenter = (): void => {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const nextBounds = peekWindowBounds({
      x: display.bounds.x,
      y: display.workArea.y,
      width: display.bounds.width,
      height: display.workArea.height,
    });

    if (!peekWindow || peekWindow.isDestroyed()) {
      peekWindow = createPeekWindow();
    }

    const alreadyOpen = peekOpen && peekWindow.isVisible();
    const current = peekWindow.getBounds();
    if (boundsChanged(current, nextBounds) || !peekWindow.isVisible()) {
      peekWindow.setBounds(nextBounds, false);
    }

    if (alreadyOpen) {
      return;
    }

    peekOpen = true;
    const generation = ++peekMotionGeneration;
    const reveal = () => {
      peekRevealPending = false;
      if (
        generation !== peekMotionGeneration ||
        !peekWindow ||
        peekWindow.isDestroyed()
      ) {
        return;
      }
      peekWindow.setAlwaysOnTop(true, "status");
      peekWindow.showInactive();
      sendShellMotion(peekWindow, "enter");
    };

    if (peekWindowReady) {
      reveal();
      return;
    }

    if (!peekRevealPending) {
      peekRevealPending = true;
      peekWindow.once("ready-to-show", reveal);
    }
  };

  const pollLeftEdge = (): void => {
    if (options.isQuitting()) {
      return;
    }

    if (mainIsVisible()) {
      hidePeek();
      hideSidebar();
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const peekBounds =
      peekWindow && !peekWindow.isDestroyed() && peekWindow.isVisible()
        ? peekWindow.getBounds()
        : null;

    if (
      shouldShowLeftEdgePeek({
        cursor,
        displayBounds: display.bounds,
        peekBounds,
        sidebarVisible: sidebarIsVisible(),
        mainWindowVisible: mainIsVisible(),
      })
    ) {
      showPeekAtCenter();
      return;
    }

    hidePeek();
  };

  const startEdgePeek = (): void => {
    if (edgeTimer) {
      return;
    }
    edgeTimer = setInterval(pollLeftEdge, EDGE_POLL_MS);
    edgeTimer.unref?.();
  };

  const stopEdgePeek = (): void => {
    if (edgeTimer) {
      clearInterval(edgeTimer);
      edgeTimer = null;
    }
    hidePeek();
  };

  const buildTrayMenu = (runtime: TrayRuntime): Menu => {
    const monitoring = runtime.getMonitoring();
    const automaticOn =
      monitoring.phase === "active" ||
      monitoring.phase === "starting" ||
      monitoring.phase === "degraded";
    const template: MenuItemConstructorOptions[] = [
      {
        label: "Open Email Checker",
        click: () => showMainWindow(),
      },
      {
        label: sidebarIsVisible() ? "Hide sidebar" : "Open sidebar",
        click: () => {
          if (sidebarIsVisible()) {
            hideSidebar();
            return;
          }
          showSidebar();
        },
      },
      { type: "separator" },
      {
        label: automaticOn ? "Pause automatic" : "Start automatic",
        click: () => {
          void Promise.resolve(
            automaticOn ? runtime.pauseMonitoring() : runtime.startMonitoring(),
          ).catch(() => undefined);
        },
      },
      {
        label: "Run once",
        click: () => {
          void Promise.resolve(runtime.runOrganizer()).catch(() => undefined);
        },
      },
      { type: "separator" },
      {
        label: "Quit Email Checker",
        click: () => {
          options.setQuitting(true);
          app.quit();
        },
      },
    ];
    return Menu.buildFromTemplate(template);
  };

  const refreshTrayMenu = (runtime: TrayRuntime): void => {
    if (!tray) {
      return;
    }
    tray.setContextMenu(buildTrayMenu(runtime));
  };

  const showDesktopNotification = (content: {
    title: string;
    body: string;
  }): void => {
    if (!Notification.isSupported()) {
      return;
    }

    const notification = new Notification({
      ...content,
      icon: notificationIcon,
    });
    activeNotifications.add(notification);
    notification.once("click", () => showMainWindow());
    notification.once("close", () => activeNotifications.delete(notification));
    notification.show();
  };

  const showEmailNotification = (
    snapshot: StatusSnapshot,
    knownIds: Set<string>,
  ): void => {
    const newEmails = findNewEmails(snapshot.emails, knownIds);
    if (newEmails.length > 0) {
      showDesktopNotification(createEmailNotification(newEmails));
    }
  };

  const startBackgroundUi = (runtime: TrayRuntime): void => {
    if (!tray) {
      tray = new Tray(windowIcon);
      tray.setToolTip("Email Checker");
      tray.on("click", () => showMainWindow());
    }
    refreshTrayMenu(runtime);
    unsubscribeMonitoring?.();
    unsubscribeMonitoring = runtime.onMonitoringState(() => {
      refreshTrayMenu(runtime);
    });
    const knownEmailIds = new Set(
      runtime.getStatus().emails.map(emailIdentity),
    );
    unsubscribeStatus?.();
    unsubscribeStatus = runtime.onStatusSnapshot((snapshot) => {
      showEmailNotification(snapshot, knownEmailIds);
    });
    if (!sidebarWindow || sidebarWindow.isDestroyed()) {
      sidebarWindow = createSidebarWindow();
    }
    if (!peekWindow || peekWindow.isDestroyed()) {
      peekWindow = createPeekWindow();
    }
    startEdgePeek();
  };

  const dispose = (): void => {
    stopEdgePeek();
    unsubscribeMonitoring?.();
    unsubscribeMonitoring = null;
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    for (const notification of activeNotifications) {
      notification.close();
    }
    activeNotifications.clear();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  };

  return {
    getMainWindow: () => mainWindow,
    getFloatingWindow: () => floatingWindow,
    getSidebarWindow: () => sidebarWindow,
    isOwnedWindow: (window) => ownedWindows.has(window),
    createMainWindow,
    createFloatingWindow,
    showMainWindow,
    hideMainToTray,
    showFloatingWindow,
    restoreMainWindow,
    showSidebar,
    hideSidebar,
    hideSenderWindow,
    startBackgroundUi,
    dispose,
  };
}
