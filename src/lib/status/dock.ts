import { barShownAt, dockProgress } from "./layout.ts";

/** What the search dock has reached, for the few parts of the page that change with it. */
export type DockState = {
  /** The floating bar is up (below 64rem once the hero's last line has scrolled clear, wide most of the way through the move). */
  barShown: boolean;
  /**
   * Wide only (64rem and up): the field is fully in the bar, and part way it keeps whatever it was. Always false
   * below 64rem, where the field never moves into the bar (see `revealed`).
   */
  docked: boolean;
  /**
   * Below 64rem: the bar is up and the hero's field is entirely behind it, so the bar's own copy of the field is
   * usable (it can be reached with Tab and `/`) and the hero's is not. Always false from 64rem.
   */
  heroAway: boolean;
  /**
   * Below 64rem: the bar's copy of the field is showing. It implies `heroAway`. The field shows on a scroll up
   * and hides on a scroll down (see `revealFrame`), and stays while it has focus or a search is written in it.
   */
  revealed: boolean;
};

/**
 * Where the dock keeps those discrete states. A store outside React, read
 * with useDockSelect, so that the board (which holds every card) does not
 * render when the bar comes up: only the bar, the hero's two buttons and the
 * fields do. Every change is a step, never a progress, so a scroll costs
 * React nothing between them.
 */
export type DockStore = {
  get: () => DockState;
  subscribe: (listener: () => void) => () => void;
  set: (next: DockState) => void;
};

/** The dock at the top of the page: no bar, only the field in the hero. */
export const DOCK_REST: DockState = { barShown: false, docked: false, heroAway: false, revealed: false };

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
      if (
        next.barShown === state.barShown &&
        next.docked === state.docked &&
        next.heroAway === state.heroAway &&
        next.revealed === state.revealed
      ) {
        return;
      }
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * How far above its place the hidden bar sits, in px (the translateY of .compact-header[data-shown="false"] in
 * styles.css): the bar slides down this far as it comes up. The bar's field rises by half of it (--bar-search-rise).
 */
export const BAR_RISE = 8;
/** On a wide screen: the scrolling the one move takes, and where in it (0 to 1) the bar comes up. */
export const WIDE_RANGE = 48;
export const WIDE_BAR_AT = 0.67;
/**
 * How many px of scrolling back a bar that is up stays up (barShownAt), and a bar field that is usable stays
 * usable (`heroAway`, see `revealFrame`): the page has to be this far past a threshold to cross it one way, and
 * back over the threshold itself to cross it the other, so a finger resting on it cannot flip anything.
 */
export const DOCK_HYSTERESIS = 8;
/** Below 64rem: how many px of upward scrolling, from the lowest point of the run, bring the bar's field in. */
export const REVEAL_UP_PX = 24;
/** Below 64rem: how many px of downward scrolling, from the highest point of the run, take it away again. */
export const HIDE_DOWN_PX = 12;

/** The scroll positions (px) at which the dock moves and brings the bar up, and its flicker guards. */
export type DockGeometry = {
  /** A wide screen, where the field's move follows the scroll (`start` and `range`). Below 64rem nothing does. */
  wide: boolean;
  /** Wide: where the field starts to move. */
  start: number;
  /** Wide: the scrolling the move takes. */
  range: number;
  /** Where the bar comes up. */
  barStart: number;
  /** How far above `barStart` a bar that is up stays up (and, wide, how far the Reduce Motion snap holds). */
  hysteresis: number;
  /**
   * Below 64rem: the scroll position at which the hero's field has its bottom edge level with the bar's. From
   * there on the field is behind the bar and the bar's own copy of it can show. Never reached on a wide screen.
   */
  revealFrom: number;
};

/**
 * The dock's geometry from the numbers measured off the page.
 *
 * Wide: `end` is the scroll position at which the field reaches its pin (`barTop` is the bar's `top`); the move
 * is WIDE_RANGE px of scrolling ending there, and the bar comes up 67% of the way through it (at its end under
 * Reduce Motion, where the field snaps).
 *
 * Below 64rem the field is an ordinary part of the page and the bar is fixed at the top. The bar comes up when
 * the hero's last line (`contentBottom`) has scrolled clear of the highest point the sliding bar reaches, and
 * not before. The bar's copy of the field becomes usable (`revealFrom`) when the hero's field, in the flow
 * with its bottom edge at `fieldBottom` (a page position), has risen to the bar's bottom edge, `barTop` plus
 * `barHeight`: from there the two fields are never on screen together. The page's spacing puts the field a
 * little under the live line, so the bar is up alone for a stretch of scrolling before that.
 */
export function dockGeometry({
  wide,
  reduce,
  end,
  barTop,
  barHeight,
  fieldBottom = Number.POSITIVE_INFINITY,
  contentBottom = Number.NEGATIVE_INFINITY,
}: {
  wide: boolean;
  reduce: boolean;
  end: number;
  barTop: number;
  barHeight: number;
  fieldBottom?: number;
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
      revealFrom: Number.POSITIVE_INFINITY,
    };
  }
  // A page with no hero line to wait for brings the bar up at the top.
  const barStart = Math.max(0, contentBottom - (barTop - BAR_RISE));
  return {
    wide,
    start: barStart,
    range: 1,
    barStart,
    hysteresis: 8,
    revealFrom: fieldBottom - (barTop + barHeight),
  };
}

/**
 * What the dock looks like at `scrollY` on a wide screen, or the bar's phase below 64rem: whether the bar is up,
 * whether the field is docked, and (wide only) its progress `p` into the bar.
 *
 * On a wide screen `p` goes 0 to 1 over the move, in steps of 1/500 so a scroll
 * does not rewrite a style for a change nobody can see; under Reduce Motion it
 * snaps to its two ends. The field is docked at 1 and released at 0; part way
 * it keeps whatever it was (`prev`).
 *
 * Below 64rem the field never docks (`docked` is false, `p` is 0) and only the bar follows the position, with
 * the hysteresis of barShownAt: what the bar's field does is `revealFrame`'s.
 *
 * No clamping of `scrollY`: iOS reports a rubber band's overshoot (negative above
 * the top, more than the page's end below it), but every threshold here is a
 * step, and the poses past them are the ones the page rests in, so a position
 * beyond either end reads as the end.
 */
export function dockFrame(scrollY: number, geometry: DockGeometry, reduce: boolean, prev: DockState) {
  const barShown = barShownAt(scrollY, geometry.barStart, prev.barShown, geometry.hysteresis);
  if (!geometry.wide) return { p: 0, barShown, docked: false };
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

/**
 * `scrollY` held to the page (0 to `maxScroll`): the position the direction rule reads, and so the one its baseline
 * must be taken at. iOS reports a rubber band's overshoot past either end, and a baseline taken at the raw number
 * would sit beyond the end that every later frame is clamped to, and read as travel back up.
 */
export function clampScroll(scrollY: number, maxScroll: number): number {
  return Math.min(Math.max(scrollY, 0), Math.max(maxScroll, 0));
}

/**
 * Whether the reader moved the page since the last frame, as opposed to the layout under it. Pure: the hook hands
 * it the numbers it read before any rebase touched its baseline.
 *
 * A move is the reader's unless the layout accounts for it: the page was held to a nearer end (the position it
 * left no longer exists, and it now sits at the end), a `quietScroll` is under way, or its travel is the distance
 * something else moved by, within 1.5px, which is the browser's scroll anchoring holding the reader's place: the
 * board's anchor moved by that much (`anchorMoved`), or the page's end did (`limit` against `lastLimit`: content
 * above the reader's place came or went). Travel under 1px is no move. All positions are held to the page, as
 * `revealFrame` holds its own, or an iOS overshoot would read as travel.
 *
 * A key typed into a search field changes the board, and so the page's height, and the browser then moves the page
 * by part of that change (its scroll anchoring holds a card that may be one the search has just removed, which
 * leaves `anchorMoved` nothing to read, and the content that went may lie below the reader's place as well as above
 * it, so the travel is less than the end's). While the reader is `typing`, a move in the direction the page's end
 * moved, by no more than it moved, is that change and not the reader's: a finger on the page at the same moment
 * would have to scroll the same way by less than the change to be mistaken for it.
 */
export function readerMoved({
  from,
  scrollY,
  limit,
  lastLimit,
  anchorMoved = 0,
  quiet = false,
  typing = false,
}: {
  /** The position the last frame left the page at (clamped, as the memo keeps it). */
  from: number;
  /** The raw position now. */
  scrollY: number;
  /** How far the page can scroll now, and as of the last frame. */
  limit: number;
  lastLimit: number;
  /** How far the board's anchor has moved in the document since the last frame. */
  anchorMoved?: number;
  /** A scroll the page made itself is under way. */
  quiet?: boolean;
  /** A key was typed into a search field a moment ago (`TYPING_MS`). */
  typing?: boolean;
}): boolean {
  const at = clampScroll(scrollY, limit);
  const travel = at - from;
  if (Math.abs(travel) < 1 || quiet) return false;
  if (from > limit + 0.5 && limit - at < 1.5) return false;
  if (Math.abs(anchorMoved) >= 1 && Math.abs(travel - anchorMoved) < 1.5) return false;
  const shift = limit - lastLimit;
  if (Math.abs(shift) >= 1 && Math.abs(travel - shift) < 1.5) return false;
  return !(typing && Math.abs(shift) >= 1 && travel * shift > 0 && Math.abs(travel) <= Math.abs(shift));
}

/**
 * How long after a key typed into a search field the board's change from it can still be moving the page: the key's
 * render, the layout of the next frame (where the browser moves the page) and the frame after it. Time, not frames,
 * because no frame runs while nothing changes, and a scroll a long while after the last key is the reader's.
 */
export const TYPING_MS = 400;

/** What `revealFrame` remembers from one frame to the next. */
export type RevealMemo = {
  /** The bar is up and the hero's field is behind it. */
  heroAway: boolean;
  /** The bar's field is showing. */
  revealed: boolean;
  /** The direction the page is going, as far as the thresholds have confirmed it. */
  dir: "up" | "down";
  /** The furthest point of the current run: the highest scroll position going down, the lowest going up. */
  pivot: number;
  /** The position the last frame saw. */
  lastY: number;
};

/** The memo at the top of the page. */
export const REVEAL_REST: RevealMemo = { heroAway: false, revealed: false, dir: "down", pivot: 0, lastY: 0 };

/**
 * Below 64rem: whether the bar's copy of the field shows, from the direction the page is being scrolled in.
 * Pure: the hook hands it the position and what it remembered, and keeps what it returns.
 *
 * 1. `y` is clamped to the page (0 to `maxScroll`), so an iOS rubber band, and the recoil from the bottom one,
 *    which reads as a scroll up, move nothing.
 * 2. `latched` (a field has focus, a dialog is open, the page has not armed yet) keeps the state and only moves
 *    the baseline to `y`, so what happens during it (the keyboard opening and scrolling the page) is not read
 *    as a direction afterwards. It does not outlast `heroAway` (3): once the page is back above `revealFrom`
 *    the hero's field is in view, and the latch lets go so that only one of the two fields is.
 * 3. `heroAway` turns on DOCK_HYSTERESIS px past `revealFrom` (with the bar up) and off at `revealFrom`; while it
 *    is off nothing shows, and the memory restarts from `y`.
 * 4. A frame at the same position, with nothing else changed, is `prev` itself.
 * 5. Going down, the pivot follows the page to its lowest point; REVEAL_UP_PX of travel back up from there
 *    reveals the field and turns the run round. Going up, the pivot follows it to its highest point;
 *    HIDE_DOWN_PX of travel down from there hides it. A reversal starts the count again, and jitter under a
 *    threshold changes nothing.
 *
 * `keep` (a search is written) holds the field showing for as long as `heroAway`: the field a filter was
 * typed into must not slip away on the next scroll down. The memory restarts from `y` meanwhile, so a field
 * that is then cleared goes through the same HIDE_DOWN_PX as one that was just left.
 */
export function revealFrame(
  scrollY: number,
  maxScroll: number,
  geometry: DockGeometry,
  prev: RevealMemo,
  context: { barShown: boolean; latched: boolean; keep?: boolean },
): RevealMemo {
  const y = clampScroll(scrollY, maxScroll);
  const heroAway =
    context.barShown && y >= (prev.heroAway ? geometry.revealFrom : geometry.revealFrom + DOCK_HYSTERESIS);
  // A latch keeps the state, but not past the hero's field coming back into view: the bar's copy and the hero's
  // are never on screen together, whoever has focus (the hook moves a focus the bar's copy held to the hero's).
  if (context.latched && !(prev.heroAway && !heroAway)) {
    return prev.lastY === y && prev.pivot === y ? prev : { ...prev, lastY: y, pivot: y };
  }
  if (!heroAway) {
    if (!prev.heroAway && !prev.revealed && prev.dir === "down" && prev.pivot === y && prev.lastY === y) return prev;
    return { heroAway: false, revealed: false, dir: "down", pivot: y, lastY: y };
  }
  if (context.keep) {
    if (prev.heroAway && prev.revealed && prev.dir === "up" && prev.pivot === y && prev.lastY === y) return prev;
    return { heroAway: true, revealed: true, dir: "up", pivot: y, lastY: y };
  }
  if (prev.heroAway && y === prev.lastY) return prev;
  let { revealed, dir, pivot } = prev;
  if (!prev.heroAway) {
    // Just behind the bar: hidden, and the run starts here.
    revealed = false;
    dir = "down";
    pivot = y;
  } else if (dir === "down") {
    pivot = Math.max(pivot, y);
    if (pivot - y >= REVEAL_UP_PX) {
      dir = "up";
      revealed = true;
      pivot = y;
    }
  } else {
    pivot = Math.min(pivot, y);
    if (y - pivot >= HIDE_DOWN_PX) {
      dir = "down";
      revealed = false;
      pivot = y;
    }
  }
  return { heroAway: true, revealed, dir, pivot, lastY: y };
}

/**
 * The state of the reveal once a field has the focus in the bar's copy, which shows it without a scroll: a run
 * going up from `y`. Unchanged when the hero's field is not behind the bar (the copy cannot be reached then) or the
 * copy is showing already. Pure.
 */
export function focusReveal(memo: RevealMemo, y: number): RevealMemo {
  if (!memo.heroAway || memo.revealed) return memo;
  return { ...memo, revealed: true, dir: "up", pivot: y, lastY: y };
}

/**
 * Which search field a focus carried across the 64rem line belongs in. From 64rem the hero's field is the only
 * one (docked in the bar, the bar's copy is not drawn). Below it, it is the hero's while that is in view and the
 * bar's copy once the hero's is behind the bar (`heroAway`, read from the scroll position as it is now). Pure.
 */
export function crossingTarget({ wide, heroAway }: { wide: boolean; heroAway: boolean }): "hero" | "bar" {
  return wide || !heroAway ? "hero" : "bar";
}

let quiet = false;
let quietToken = 0;

/**
 * Runs `scroll`, a scroll the page makes itself (to keep a card under the reader's finger after the board
 * reordered), and has the dock read it as no direction at all: until two frames from now the hook moves its
 * baseline to the position instead of counting travel (see `quietScrolling`). Left alone, a jump of a screenful
 * would look like a deliberate scroll up and bring the field in.
 */
export function quietScroll(scroll: () => void): void {
  quiet = true;
  const token = ++quietToken;
  scroll();
  const clear = () => {
    if (token === quietToken) quiet = false;
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(clear));
  else queueMicrotask(clear);
}

/** Whether a `quietScroll` is still within its two frames: the hook's frame rebases while this is true. */
export function quietScrolling(): boolean {
  return quiet;
}
