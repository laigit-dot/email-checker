export const EDGE_SHOW_THRESHOLD_PX = 6;
export const PEEK_KEEP_PADDING_PX = 16;
export const PEEK_SIZE = 104;
export const PEEK_WIDTH = PEEK_SIZE;
export const PEEK_HEIGHT = PEEK_SIZE;
export const PEEK_ENTER_MS = 420;
export const PEEK_EXIT_MS = 320;
export const SIDEBAR_WIDTH = 400;
export const SIDEBAR_SLIDE_MS = 360;

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isAtLeftEdge(
  point: ScreenPoint,
  displayBounds: ScreenRect,
  threshold = EDGE_SHOW_THRESHOLD_PX,
): boolean {
  return (
    point.x >= displayBounds.x &&
    point.x <= displayBounds.x + threshold &&
    point.y >= displayBounds.y &&
    point.y <= displayBounds.y + displayBounds.height
  );
}

export function isPointInRect(
  point: ScreenPoint,
  rect: ScreenRect,
  padding = 0,
): boolean {
  return (
    point.x >= rect.x - padding &&
    point.x <= rect.x + rect.width + padding &&
    point.y >= rect.y - padding &&
    point.y <= rect.y + rect.height + padding
  );
}

export function shouldShowLeftEdgePeek(options: {
  cursor: ScreenPoint;
  displayBounds: ScreenRect;
  peekBounds: ScreenRect | null;
  sidebarVisible: boolean;
  mainWindowVisible: boolean;
}): boolean {
  if (options.sidebarVisible || options.mainWindowVisible) {
    return false;
  }

  if (isAtLeftEdge(options.cursor, options.displayBounds)) {
    return true;
  }

  return Boolean(
    options.peekBounds &&
      isPointInRect(options.cursor, options.peekBounds, PEEK_KEEP_PADDING_PX),
  );
}

export function peekWindowBounds(workArea: ScreenRect): ScreenRect {
  const y = Math.round(
    workArea.y + Math.max(0, (workArea.height - PEEK_HEIGHT) / 2),
  );

  return {
    x: workArea.x,
    y,
    width: PEEK_WIDTH,
    height: PEEK_HEIGHT,
  };
}

export function sidebarWindowBounds(workArea: ScreenRect): ScreenRect {
  return {
    x: workArea.x,
    y: workArea.y,
    width: Math.min(SIDEBAR_WIDTH, workArea.width),
    height: workArea.height,
  };
}

export function sidebarHiddenBounds(workArea: ScreenRect): ScreenRect {
  const shown = sidebarWindowBounds(workArea);
  return {
    ...shown,
    x: shown.x - shown.width,
  };
}

export function easeOutCubic(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  return 1 - (1 - t) ** 3;
}

export function interpolate(from: number, to: number, progress: number): number {
  return Math.round(from + (to - from) * easeOutCubic(progress));
}

export function boundsChanged(
  current: ScreenRect,
  next: ScreenRect,
  threshold = 4,
): boolean {
  return (
    Math.abs(current.x - next.x) > threshold ||
    Math.abs(current.y - next.y) > threshold ||
    current.width !== next.width ||
    current.height !== next.height
  );
}
