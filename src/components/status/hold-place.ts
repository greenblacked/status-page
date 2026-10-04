import { type RefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { quietScroll } from "@/lib/status/dock";
import { createMotionTracker, type MotionTracker } from "@/lib/status/page-motion";
import { type Held, heldResidual } from "@/lib/status/scroll-residual";

/** How long after a finger lifts the place it last touched still says what the reader is on. */
const TOUCH_MEMORY_MS = 4_000;

/** How soon the wait looks again after it has asked for the update, in case the page moved before it rendered. */
const RECHECK_MS = 100;

/** How long a press of Refresh keeps the board's update from waiting for the page to be still. */
const HURRY_MS = 1_000;

let tracker: MotionTracker | null = null;
let watchers = 0;

/** The one tracker of the page's motion, made when the first board starts watching. */
function motion(): MotionTracker {
  tracker ??= createMotionTracker(() => performance.now());
  return tracker;
}

/**
 * Feeds the page's touch and scroll events to the tracker for as long as something watches (counted, so a second
 * board in a test or a remount does not double the listeners). Touch events, not pointer events: the browser
 * cancels the pointer events of a touch as soon as it takes the gesture for a scroll, which is when the finger is
 * most on the page.
 */
function watchMotion(): () => void {
  const track = motion();
  if (watchers++ === 0) {
    window.addEventListener("scroll", onScroll, { passive: true });
    for (const type of TOUCH_EVENTS) window.addEventListener(type, onTouch, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onHide);
  }
  return () => {
    if (--watchers > 0) return;
    window.removeEventListener("scroll", onScroll);
    for (const type of TOUCH_EVENTS) window.removeEventListener(type, onTouch, { capture: true });
    document.removeEventListener("visibilitychange", onHide);
    track.reset();
  };
}
const TOUCH_EVENTS = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
const onScroll = () => motion().scrolled();
const onTouch = (event: TouchEvent) => motion().touched(event.touches.length);
const onHide = () => {
  if (document.visibilityState === "hidden") motion().reset();
};

/** The first thing in view under the root, as scroll anchoring picks it: the first child wholly in view, else the deepest one cut by the top edge. */
export function firstInView(root: Element): Element | null {
  for (const child of root.children) {
    const { top, bottom, width, height } = child.getBoundingClientRect();
    if ((width === 0 && height === 0) || bottom <= 0 || top >= window.innerHeight) continue;
    // Safari has no overflow-anchor to read, so the feed's mark stands in for it.
    if (child.matches("[data-no-anchor]")) continue;
    const style = getComputedStyle(child);
    if (style.overflowAnchor === "none" || style.position === "fixed" || style.position === "sticky") continue;
    if (top >= 0 && bottom <= window.innerHeight) return child;
    return firstInView(child) ?? child;
  }
  return null;
}

/** Whether the element is one the board can be held by: inside it, outside the feed, and in view. */
function holds(root: HTMLElement, element: Element | null): element is Element {
  if (!element || element === root || !root.contains(element) || element.closest("[data-no-anchor]")) return false;
  const { top, bottom } = element.getBoundingClientRect();
  return bottom > 0 && top < window.innerHeight;
}

/**
 * The anchor and its ancestors up to the board, each with its top in the window. The anchor itself is what the
 * reader looks at; if the update takes it out of the page (a tag that is cleared, a row that is replaced), the
 * nearest ancestor that stays is the next best thing to hold.
 */
function holdsOf(root: Element, anchor: Element): Held[] {
  const places: Held[] = [];
  for (let element: Element | null = anchor; element && element !== root; element = element.parentElement) {
    const target = element;
    places.push({
      was: target.getBoundingClientRect().top,
      // Gone from the page, or shown with no box (display: none), it holds nothing.
      now: () => {
        if (!target.isConnected) return null;
        const { top, width, height } = target.getBoundingClientRect();
        return width === 0 && height === 0 ? null : top;
      },
    });
  }
  return places;
}

/** What the reader is on: what the pointer is over (a finger down, a mouse in the page) until a key is pressed, then the focused element; else the first thing in view. */
function pickAnchor(root: HTMLElement, pointer: { x: number; y: number } | null): Element | null {
  const under = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null;
  if (holds(root, under)) return under;
  const focused = document.activeElement;
  if (holds(root, focused)) return focused;
  // Something above the board (the hero, the search field) is in view: that is what a browser would hold, and
  // it does not move with the feed, so there is nothing to make up for.
  if (root.getBoundingClientRect().top > 0) return null;
  return firstInView(root);
}

/**
 * What the board shows, kept from changing under a reader who is scrolling, and the reader's place kept when it
 * does change.
 *
 * `latest` is the board's newest state (the snapshot and the saved checks). It is shown at once while the page is
 * still; while a finger is on it, or it scrolled a moment ago, the old state stays on screen, and the new one
 * lands about 150 ms after the page goes still. The check at the turn of a slot adds a row to Recent changes and
 * clears the "Changed" tags of the one before, in one commit, so everything under them, the card a reader is
 * looking at included, drops or rises: 63 px in one frame, with a finger on the glass. Some browsers hold the place
 * themselves (scroll anchoring), some do not, some say they do and do not in this case, and the page cannot tell
 * which before it happens. So it does not ask: right after the commit, before the next paint, it measures where the
 * anchor is in the window now against where it was, and scrolls by what is left. A browser that held the place
 * leaves nothing, so nothing is scrolled twice; one that did not, or held part of it, gets the rest.
 *
 * The anchor is picked again right before the new state is accepted, while the page still has its old layout,
 * so it is what the reader is looking at now, not what they looked at when they started to scroll. Its ancestors
 * are kept with it, in case the update takes the anchor itself out of the page.
 *
 * `hurry` lets the next update through at once, for a press of Refresh: the person asked for it.
 */
export function useHeldBoard<T>(root: RefObject<HTMLElement | null>, latest: T): { shown: T; hurry: () => void } {
  // What the reader was on when the update was accepted, and where it was in the window.
  const anchor = useRef<Held[] | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const lastTouch = useRef<{ x: number; y: number; at: number } | null>(null);
  const hurriedUntil = useRef(Number.NEGATIVE_INFINITY);
  const [shown, setShown] = useState(latest);
  const [, again] = useReducer((count: number) => count + 1, 0);

  // Derived while rendering, which is the one place the old layout is still on the page to be read.
  const waiting = latest !== shown;
  if (waiting && (performance.now() < hurriedUntil.current || !motion().moving())) {
    const element = root.current;
    const finger = lastTouch.current;
    const at = pointer.current ?? (finger && performance.now() - finger.at < TOUCH_MEMORY_MS ? finger : null);
    const picked = element ? pickAnchor(element, at) : null;
    anchor.current = element && picked ? holdsOf(element, picked) : null;
    setShown(latest);
  }

  useEffect(() => watchMotion(), []);

  // The update is waiting for the page to be still: look again when it should be, until it is.
  useEffect(() => {
    if (!waiting) return;
    let timer = 0;
    const look = () => {
      const wait = motion().restsIn();
      if (wait > 0) timer = window.setTimeout(look, wait);
      else {
        again();
        // A touch or a scroll can arrive between this and the render, which then holds the update again with no
        // timer left; looking again keeps it from waiting for some other render. Cleared once it has landed.
        timer = window.setTimeout(look, RECHECK_MS);
      }
    };
    look();
    return () => clearTimeout(timer);
  }, [waiting]);

  // Where the reader's attention is, kept for the moment the update lands: the pointer while it is in the page, the
  // last place a finger touched for a few seconds after it lifted (a touch's pointer events end as soon as the
  // browser takes the gesture for a scroll), and else the focused element or the first thing in view.
  useEffect(() => {
    const touch = (event: TouchEvent) => {
      const first = event.touches[0];
      if (first) lastTouch.current = { x: first.clientX, y: first.clientY, at: performance.now() };
    };
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    const release = (event: Event) => {
      if (event instanceof PointerEvent && event.pointerType === "mouse" && event.type === "pointerup") return;
      pointer.current = null;
      if (event.type === "keydown") lastTouch.current = null;
    };
    document.addEventListener("keydown", release, { passive: true });
    document.addEventListener("pointerdown", track, { passive: true });
    document.addEventListener("pointermove", track, { passive: true });
    document.addEventListener("pointerup", release, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    document.documentElement.addEventListener("pointerleave", release, { passive: true });
    document.addEventListener("touchstart", touch, { passive: true });
    document.addEventListener("touchmove", touch, { passive: true });
    return () => {
      document.removeEventListener("keydown", release);
      document.removeEventListener("pointerdown", track);
      document.removeEventListener("pointermove", track);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.documentElement.removeEventListener("pointerleave", release);
      document.removeEventListener("touchstart", touch);
      document.removeEventListener("touchmove", touch);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for a change of what is shown, which is what moves the board.
  useLayoutEffect(() => {
    const held = anchor.current;
    anchor.current = null;
    if (!held || window.scrollY <= 0) return;
    // A programmatic scroll would stop a flick on iOS, and a shift of the feed's size mid-flick goes unseen. The
    // update waits for the page to be still, so this only meets a page in motion when it was hurried.
    if (motion().moving()) return;
    // Measured now, after the commit has been laid out, so it includes anything the browser has already scrolled
    // by; not a row or two of the feed when it is a reorder of the board, which the reader is not owed a ride with.
    const left = heldResidual(held, { scrollY: window.scrollY, viewport: window.innerHeight });
    if (!left) return;
    quietScroll(() => window.scrollBy({ top: left, behavior: "instant" }));
  }, [shown]);

  return {
    shown,
    hurry: () => {
      hurriedUntil.current = performance.now() + HURRY_MS;
    },
  };
}
