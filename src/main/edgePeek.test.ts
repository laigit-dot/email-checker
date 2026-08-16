import { describe, expect, it } from "vitest";

import {
  boundsChanged,
  easeOutCubic,
  interpolate,
  isAtLeftEdge,
  isPointInRect,
  peekWindowBounds,
  PEEK_HEIGHT,
  PEEK_WIDTH,
  shouldShowLeftEdgePeek,
  sidebarHiddenBounds,
  sidebarWindowBounds,
  SIDEBAR_WIDTH,
} from "./edgePeek.js";

const display = { x: 0, y: 0, width: 1920, height: 1080 };
const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

describe("isAtLeftEdge", () => {
  it("detects the left edge of the current display", () => {
    expect(isAtLeftEdge({ x: 0, y: 400 }, display)).toBe(true);
    expect(isAtLeftEdge({ x: 6, y: 400 }, display)).toBe(true);
    expect(isAtLeftEdge({ x: 24, y: 400 }, display)).toBe(false);
  });

  it("uses the display origin for a secondary monitor", () => {
    const rightDisplay = { x: 1920, y: 0, width: 1920, height: 1080 };
    expect(isAtLeftEdge({ x: 1920, y: 200 }, rightDisplay)).toBe(true);
    expect(isAtLeftEdge({ x: 0, y: 200 }, rightDisplay)).toBe(false);
  });
});

describe("isPointInRect", () => {
  const peek = { x: 0, y: 400, width: 48, height: 96 };

  it("includes padding around the peek tab", () => {
    expect(isPointInRect({ x: 60, y: 448 }, peek, 16)).toBe(true);
    expect(isPointInRect({ x: 80, y: 448 }, peek, 16)).toBe(false);
  });
});

describe("shouldShowLeftEdgePeek", () => {
  it("shows when the cursor is on the left edge", () => {
    expect(
      shouldShowLeftEdgePeek({
        cursor: { x: 2, y: 500 },
        displayBounds: display,
        peekBounds: null,
        sidebarVisible: false,
        mainWindowVisible: false,
      }),
    ).toBe(true);
  });

  it("keeps the tab visible while the cursor stays over it", () => {
    const peekBounds = peekWindowBounds(workArea);
    expect(
      shouldShowLeftEdgePeek({
        cursor: {
          x: peekBounds.x + 24,
          y: peekBounds.y + peekBounds.height / 2,
        },
        displayBounds: display,
        peekBounds,
        sidebarVisible: false,
        mainWindowVisible: false,
      }),
    ).toBe(true);
  });

  it("hides while the sidebar is already open", () => {
    expect(
      shouldShowLeftEdgePeek({
        cursor: { x: 0, y: 500 },
        displayBounds: display,
        peekBounds: null,
        sidebarVisible: true,
        mainWindowVisible: false,
      }),
    ).toBe(false);
  });

  it("hides while the main window is visible", () => {
    expect(
      shouldShowLeftEdgePeek({
        cursor: { x: 0, y: 500 },
        displayBounds: display,
        peekBounds: null,
        sidebarVisible: false,
        mainWindowVisible: true,
      }),
    ).toBe(false);
  });

  it("hides when the cursor leaves the edge and the tab", () => {
    expect(
      shouldShowLeftEdgePeek({
        cursor: { x: 240, y: 500 },
        displayBounds: display,
        peekBounds: peekWindowBounds(workArea),
        sidebarVisible: false,
        mainWindowVisible: false,
      }),
    ).toBe(false);
  });
});

describe("window bounds", () => {
  it("pins the peek icon to the vertical center of the left edge", () => {
    expect(peekWindowBounds(workArea)).toEqual({
      x: 0,
      y: Math.round((workArea.height - PEEK_HEIGHT) / 2),
      width: PEEK_WIDTH,
      height: PEEK_HEIGHT,
    });
  });

  it("does not follow the cursor vertically", () => {
    const centered = peekWindowBounds(workArea);
    expect(centered.y).not.toBe(80);
    expect(centered.y).toBe(Math.round((workArea.height - PEEK_HEIGHT) / 2));
  });

  it("clamps the peek icon inside a short work area", () => {
    expect(peekWindowBounds({ x: 0, y: 0, width: 800, height: 40 }).y).toBe(0);
  });

  it("docks the sidebar to the left work area", () => {
    expect(sidebarWindowBounds(workArea)).toEqual({
      x: 0,
      y: 0,
      width: SIDEBAR_WIDTH,
      height: workArea.height,
    });
  });

  it("starts the sidebar fully off-screen to the left", () => {
    expect(sidebarHiddenBounds(workArea)).toEqual({
      x: -SIDEBAR_WIDTH,
      y: 0,
      width: SIDEBAR_WIDTH,
      height: workArea.height,
    });
  });
});

describe("motion", () => {
  it("eases out as progress approaches one", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it("slides the sidebar x from hidden to docked", () => {
    const hidden = sidebarHiddenBounds(workArea);
    const shown = sidebarWindowBounds(workArea);
    expect(interpolate(hidden.x, shown.x, 0)).toBe(hidden.x);
    expect(interpolate(hidden.x, shown.x, 1)).toBe(shown.x);
    expect(interpolate(hidden.x, shown.x, 0.5)).toBeGreaterThan(hidden.x);
    expect(interpolate(hidden.x, shown.x, 0.5)).toBeLessThan(shown.x);
  });
});

describe("boundsChanged", () => {
  it("ignores tiny cursor jitter", () => {
    const current = { x: 0, y: 400, width: 48, height: 96 };
    expect(boundsChanged(current, { ...current, y: 402 })).toBe(false);
    expect(boundsChanged(current, { ...current, y: 410 })).toBe(true);
  });
});
