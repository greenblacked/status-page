import { barShownAt, dockProgress } from "./layout.ts";

/** What the search dock has reached, for the few parts of the page that change with it. */
export type DockState = {
  /** The floating bar is up (phase one on a phone, most of the move on a wide screen). */
  barShown: boolean;
  /**
   * The field is in the bar. On a phone this is a threshold on the scroll position, not a progress: the move is
   * then a short transition (see `settled`). On a wide screen it is fully in, and part way it keeps whatever it was.
   */
  docked: boolean;
  /**
   * The field has finished moving to the pose `docked` names: the same as `docked` at once when nothing moves
   * (a wide screen, Reduce Motion), and `DOCK_MS` after it on a phone, when the transition has ended. The
   * placeholder leaves the bar's short text only on this, so it never changes under a field that is still moving
   * out; going in, it follows `docked` itself.
   */
  settled: boolean;
};

/**
 * Where the dock keeps those two discrete states. A store outside React, read
 * with useDockSelect, so that the board (which holds every card) does not
 * render when the bar comes up: only the bar, the hero's two buttons and the
 * field's placeholder do. Every change is a step, never a progress, so a scroll
 * costs React nothing between them.
 */
export type DockStore = {
  get: () => DockState;
  subscribe: (listener: () => void) => () => void;
  set: (next: DockState) => void;
};

/** The dock at the top of the page: no bar, the field in the hero. */
export const DOCK_REST: DockState = { barShown: false, docked: false, settled: false };

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
      if (next.barShown === state.barShown && next.docked === state.docked && next.settled === state.settled) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * On a phone: the clear page, in px, between the bar's bottom edge and the field when the bar comes up. It is
 * also the scrolling the bar has to itself: the field merges only once it has risen to the bar's bottom edge.
 */
export const PHONE_GAP = 24;
/** How far above its place the hidden bar sits, in px (the translateY of .compact-header[data-shown="false"] in styles.css): the bar slides down this far as it comes up. */
export const BAR_RISE = 8;
/** On a wide screen: the scrolling the one move takes, and where in it (0 to 1) the bar comes up. */
export const WIDE_RANGE = 48;
export const WIDE_BAR_AT = 0.67;
/**
 * On a phone: how long the field takes to merge into the bar, or to leave it, in ms. It is `--t-dock` in
 * styles.css, which has to say the same; a test reads both. The merge is this much time, whatever the scrolling.
 */
export const DOCK_MS = 180;
/**
 * On a phone: the pause before the merge starts to move, in ms (three frames at 60Hz). It is `--t-dock-lead` in
 * styles.css, which has to say the same. A transition shows its start value for its delay, and WebKit counts the
 * time its compositor animation misses at the start (the commit of the new pose to the UI process, tens of ms on
 * an iPhone) out of the delay, not out of the motion, so the first frame drawn is still the rest box.
 */
export const DOCK_LEAD_MS = 50;
/** On a phone: how many px of scrolling back the field stays docked after the point where it docks. */
export const DOCK_HYSTERESIS = 8;

/** The scroll positions (px) at which the dock moves, docks and brings the bar up, and its flicker guards. */
export type DockGeometry = {
  /** A wide screen, where the move follows the scroll (`start` and `range`); on a phone it is a threshold (`dockAt`). */
  wide: boolean;
  /** Where the field starts to move (wide), or reaches the bar's bottom edge (phone). */
  start: number;
  /** The scrolling the wide move takes. */
  range: number;
  /** Where the bar comes up. */
  barStart: number;
  /** How far above `barStart` a bar that is up stays up (and, wide, how far the Reduce Motion snap holds). */
  hysteresis: number;
  /** Phone only: the scroll position from which the field is docked. */
  dockAt: number;
  /** Phone only: the position below which a docked field is released. Never above `dockAt`. */
  undockAt: number;
};

/**
 * The dock's geometry from the numbers measured off the page. `end` is the
 * scroll position at which the field reaches its pin; every other offset is
 * worked out from it. `pin` and `barTop` are the field's and the bar's `top`,
 * `barHeight` and `fieldHeight` their heights (phone only).
 *
 * On a phone the bar is fixed and comes up first, alone: PHONE_GAP px above
 * where the field's top would meet its bottom edge. The field merges only when
 * it has risen to that edge, so it never sits over the bar before it merges,
 * whatever the bar's height (a larger text size makes it taller). At a 16px
 * root that is a bar alone for 24px of scrolling, then the field, which has 46px
 * left to rise to its pin.
 *
 * The merge itself is not spread over that scrolling: the field docks at
 * `dockAt`, the point where it meets the bar, and a transition in time moves it
 * into the slot. A docked field stays docked until the page is DOCK_HYSTERESIS
 * px back above that, so a finger resting on the boundary cannot restart the
 * move. Under Reduce Motion nothing moves in time: the field docks where it
 * reaches its pin (`end`), after rising under the bar, and stays docked until
 * it has left the pin by more than the room the bar has around the docked
 * field, `barHeight - fieldHeight - (pin - barTop)` (2px at a 16px root); any
 * further down, the narrow field would be poking out of the bar's bottom edge.
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
  fieldHeight = 44,
  contentBottom = Number.NEGATIVE_INFINITY,
}: {
  wide: boolean;
  reduce: boolean;
  end: number;
  pin: number;
  barTop: number;
  barHeight: number;
  fieldHeight?: number;
  contentBottom?: number;
}): DockGeometry {
  if (wide) {
    const range = WIDE_RANGE;
    // Snapping, the field is in the bar only at the end: the bar must not show over it before.
    return {
      wide,
      start: end - range,
      range,
      barStart: reduce ? end : end - range + WIDE_BAR_AT * range,
      hysteresis: reduce ? 0 : 8,
      dockAt: end,
      undockAt: end,
    };
  }
  const barStart = Math.max(end - (barHeight + PHONE_GAP - (pin - barTop)), contentBottom - (barTop - BAR_RISE));
  const start = Math.max(end - (barHeight - (pin - barTop)), barStart);
  const snapHold = Math.max(0, barHeight - fieldHeight - (pin - barTop));
  return {
    wide,
    start,
    range: Math.max(1, end - start),
    barStart,
    hysteresis: 8,
    dockAt: reduce ? end : start,
    undockAt: reduce ? end - snapHold : start - DOCK_HYSTERESIS,
  };
}

/**
 * The longest of the durations in a CSS `transition-duration` value ("0.18s", "180ms", "0s, 0.25s"), in ms. 0 for
 * none, which is how the dock tells that nothing will move and the field can be called settled at once.
 */
export function transitionMs(value: string): number {
  let longest = 0;
  for (const part of value.split(",")) {
    const time = Number.parseFloat(part);
    if (!(time > 0)) continue;
    longest = Math.max(longest, part.trim().endsWith("ms") ? time : time * 1000);
  }
  return longest;
}

/**
 * What the dock looks like at `scrollY`: whether the bar is up, whether the
 * field is docked, and (wide only) its progress `p` into the bar.
 *
 * On a wide screen `p` goes 0 to 1 over the move, in steps of 1/500 so a scroll
 * does not rewrite a style for a change nobody can see; under Reduce Motion it
 * snaps to its two ends. The field is docked at 1 and released at 0; part way
 * it keeps whatever it was (`prev`).
 *
 * On a phone nothing follows the scroll position: the field is docked from
 * `dockAt` and released below `undockAt` (see dockGeometry), and `p` is just
 * 0 or 1 for it. `prev` is the state a moment ago, which both the bar's
 * hysteresis and the docked latch depend on.
 *
 * No clamping of `scrollY`: iOS reports a rubber band's overshoot (negative above
 * the top, more than the page's end below it), but every threshold here is a
 * step, and the poses past them are the ones the page rests in, so a position
 * beyond either end reads as the end.
 */
export function dockFrame(scrollY: number, geometry: DockGeometry, reduce: boolean, prev: DockState) {
  const barShown = barShownAt(scrollY, geometry.barStart, prev.barShown, geometry.hysteresis);
  if (!geometry.wide) {
    const docked = scrollY >= (prev.docked ? geometry.undockAt : geometry.dockAt);
    return { p: docked ? 1 : 0, barShown, docked };
  }
  let p = dockProgress(scrollY, geometry.start, geometry.range);
  if (reduce) {
    const end = geometry.start + geometry.range;
    p = scrollY >= (prev.docked ? end - geometry.hysteresis : end) ? 1 : 0;
  }
  p = Math.round(p * 500) / 500;
  let docked = prev.docked;
  if (p === 1) docked = true;
  else if (p === 0) docked = false;
  return { p, barShown, docked };
}
