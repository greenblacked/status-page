import { barShownAt, dockProgress } from "./layout.ts";

/** What the search dock has reached, for the few parts of the page that change with it. */
export type DockState = {
  /** The floating bar is up (phase one on a phone, most of the move on a wide screen). */
  barShown: boolean;
  /** The field is fully in the bar. Part way, it keeps whatever it was. */
  docked: boolean;
};

/**
 * Where the dock keeps those two discrete states. A store outside React, read
 * with useDockState, so that the board (which holds every card) does not
 * render when the bar comes up: only the bar, the hero's two buttons and the
 * field's placeholder do.
 */
export type DockStore = {
  get: () => DockState;
  subscribe: (listener: () => void) => () => void;
  set: (next: DockState) => void;
};

/** The dock at the top of the page: no bar, the field in the hero. */
export const DOCK_REST: DockState = { barShown: false, docked: false };

export function createDockStore(): DockStore {
  let state = DOCK_REST;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      if (next.barShown === state.barShown && next.docked === state.docked) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** On a phone: the clear page, in px, between the bar's bottom edge and the field when the bar comes up, and the scrolling the merge takes. */
export const PHONE_GAP = 16;
export const PHONE_RANGE = 56;
/** How far above its place the hidden bar sits, in px (the translateY of .compact-header[data-shown="false"] in styles.css): the bar slides down this far as it comes up. */
export const BAR_RISE = 8;
/** On a wide screen: the scrolling the one move takes, and where in it (0 to 1) the bar comes up. */
export const WIDE_RANGE = 48;
export const WIDE_BAR_AT = 0.67;

/** The scroll positions (px) at which the dock moves and the bar comes up, and the bar's flicker guard. */
export type DockGeometry = {
  /** Where the field starts to move. */
  start: number;
  /** The scrolling the move takes. */
  range: number;
  /** Where the bar comes up. */
  barStart: number;
  /** How far above `barStart` a bar that is up stays up. */
  hysteresis: number;
};

/**
 * The dock's geometry from the numbers measured off the page. `end` is the
 * scroll position at which the field reaches its pin; every other offset is
 * worked out from it. `pin` and `barTop` are the field's and the bar's `top`,
 * `barHeight` the bar's height (phone only).
 *
 * `contentBottom` (phone only) is where the hero's last line ends in the page.
 * The bar is never raised over it. The page's spacing is sized so this never
 * has to act: the line is `barHeight + BAR_RISE + PHONE_GAP` px above the field
 * (see .search-dock in styles.css), which is exactly when the sliding bar's top
 * edge clears the line and the bar's bottom edge is PHONE_GAP above the field.
 * If some page ever sits the two closer (a smaller text size than the spacing
 * was drawn for), the bar waits for the line to scroll up past the highest
 * point the sliding bar reaches, and the merge starts with it, so the bar is
 * still always up before the field moves into it.
 */
export function dockGeometry({
  wide,
  reduce,
  end,
  pin,
  barTop,
  barHeight,
  contentBottom = Number.NEGATIVE_INFINITY,
}: {
  wide: boolean;
  reduce: boolean;
  end: number;
  pin: number;
  barTop: number;
  barHeight: number;
  contentBottom?: number;
}): DockGeometry {
  if (wide) {
    const range = WIDE_RANGE;
    // Snapping, the field is in the bar only at the end: the bar must not show over it before.
    return {
      start: end - range,
      range,
      barStart: reduce ? end : end - range + WIDE_BAR_AT * range,
      hysteresis: reduce ? 0 : 8,
    };
  }
  const barStart = Math.max(end - (barHeight + PHONE_GAP - (pin - barTop)), contentBottom - (barTop - BAR_RISE));
  const start = Math.max(end - PHONE_RANGE, barStart);
  return { start, range: Math.max(1, end - start), barStart, hysteresis: 8 };
}

/**
 * What the dock looks like at `scrollY`: its progress (0 to 1, in steps of
 * 1/500 so a scroll does not rewrite a style for a change nobody can see;
 * snapped to its two ends under Reduce Motion), whether the bar is up, and
 * whether the field has docked. `prev` is the state a moment ago, which the
 * bar's hysteresis and the docked latch both depend on: part way, the field
 * is still where it was.
 */
export function dockFrame(scrollY: number, geometry: DockGeometry, reduce: boolean, prev: DockState) {
  let p = dockProgress(scrollY, geometry.start, geometry.range);
  if (reduce) p = p >= 1 ? 1 : 0;
  p = Math.round(p * 500) / 500;
  const barShown = barShownAt(scrollY, geometry.barStart, prev.barShown, geometry.hysteresis);
  let docked = prev.docked;
  if (p === 1) docked = true;
  else if (p === 0) docked = false;
  return { p, barShown, docked };
}
