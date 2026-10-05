import { type RefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { quietScroll } from "@/lib/status/dock";
import { createMotionTracker, type MotionTracker } from "@/lib/status/page-motion";
import { createReaderSpot, type Spot } from "@/lib/status/reader-spot";
import { type Held, heldResidual } from "@/lib/status/scroll-residual";

/** How long after a finger lifts the place it last touched still says what the reader is on (see `createReaderSpot`). */
const TOUCH_MEMORY_MS = 4_000;

/** How soon the wait looks again after it has asked for the update, in case the page moved before it rendered. */
const RECHECK_MS = 100;

/** How long a press of Refresh keeps the board's update from waiting for the page to be still. */
const HURRY_MS = 1_000;

// DIAGNOSTIC (throwaway): every decision of the held board is recorded in window.__holdLog.
type HoldLogWindow = Window & { __holdLog?: unknown[]; __holdLogEnv?: boolean };
const round = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
function holdLog(entry: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    const w = window as HoldLogWindow;
    if (!w.__holdLog) w.__holdLog = [];
    const log = w.__holdLog;
    if (!w.__holdLogEnv) {
      w.__holdLogEnv = true;
      log.push({
        what: "env",
        overflowAnchor: getComputedStyle(document.documentElement).overflowAnchor,
        supports: typeof CSS !== "undefined" && CSS.supports("overflow-anchor", "auto"),
        scrollBehavior: document.scrollingElement ? getComputedStyle(document.scrollingElement).scrollBehavior : null,
      });
    }
    const now = round(performance.now());
    // Runs of the same thing (a touchmove and a mouse replay on every frame) are folded into one entry with a count.
    const key = typeof entry.key === "string" ? `${entry.key}/${liftEpoch}` : null;
    if (key) {
      for (let i = log.length - 1; i >= Math.max(0, log.length - 14); i--) {
        const old = log[i] as { key?: string; at?: number; n?: number; to?: number; x1?: number; y1?: number };
        if (old.key === key && (now as number) - (old.to ?? old.at ?? 0) < 150) {
          old.n = (old.n ?? 1) + 1;
          old.to = now as number;
          old.x1 = entry.x as number;
          old.y1 = entry.y as number;
          return;
        }
      }
    }
    if (log.length >= 300) log.shift();
    log.push({ at: now, n: 1, ...entry, key });
  } catch {}
}
function describe(element: Element | null | undefined) {
  if (!element) return null;
  const data = Array.from(element.attributes)
    .filter((attribute) => attribute.name.startsWith("data-"))
    .map((attribute) => `${attribute.name}=${attribute.value.slice(0, 20)}`);
  return {
    tag: element.tagName,
    cls: (element.getAttribute("class") ?? "").split(/\s+/)[0] ?? "",
    id: element.id,
    data,
    text: (element.textContent ?? "").trim().slice(0, 30),
    top: round(element.getBoundingClientRect().top),
  };
}
/** The elements of the last held list, anchor first, for the log. */
let heldEls: Element[] = [];
/** The event being handled, for the decision reader-spot reports about it. */
let currentEvent: Record<string, unknown> = {};
/** Bumped at each touchend, so that runs are folded only within one side of a lift. */
let liftEpoch = 0;
/** Whether `below()` picked the element of the last pickAnchor. */
let usedBelow = false;

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
  heldEls = [];
  for (let element: Element | null = anchor; element && element !== root; element = element.parentElement) {
    const target = element;
    heldEls.push(target);
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

/**
 * What a finger in a gap between cards is on: the element that holds the feed is under it, and it stays where it is
 * when a row comes in, so it holds nothing. The first thing below the finger is what the reader is about to read.
 * When that is the feed itself (the gap above Recent changes), there is no card to hold: the container is returned
 * and holds nothing, as it did before, and the section after the feed, which is further down, is not taken for it.
 */
export function below(container: Element, y: number): Element | null {
  for (const child of container.children) {
    const { top, height } = child.getBoundingClientRect();
    if (height <= 0 || top < y) continue;
    const style = getComputedStyle(child);
    if (style.position === "fixed" || style.position === "sticky") continue;
    return child.matches("[data-no-anchor]") || child.querySelector("[data-no-anchor]") ? container : child;
  }
  return null;
}

/** What the reader is on: what the pointer is over (a finger down, a mouse in the page) until a key is pressed, then the focused element; else the first thing in view. */
function pickAnchor(root: HTMLElement, pointer: Spot | null): Element | null {
  const at = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null;
  const useBelow = Boolean(pointer && at && root.contains(at) && at.querySelector("[data-no-anchor]"));
  usedBelow = useBelow;
  const under = useBelow && pointer && at ? below(at, pointer.y) : at;
  holdLog({ what: "pick", from: describe(at), under: describe(under), usedBelow: useBelow, holds: holds(root, under) });
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
  const [input] = useState(() =>
    createReaderSpot(
      () => performance.now(),
      TOUCH_MEMORY_MS,
      (decision, state) =>
        holdLog({
          what: "spot",
          key: `${String(currentEvent.type)}/${String(currentEvent.pt)}/${decision}`,
          ...currentEvent,
          decision,
          ...state,
        }),
    ),
  );
  const hurriedUntil = useRef(Number.NEGATIVE_INFINITY);
  const [shown, setShown] = useState(latest);
  const [, again] = useReducer((count: number) => count + 1, 0);

  // Derived while rendering, which is the one place the old layout is still on the page to be read.
  const waiting = latest !== shown;
  if (waiting && (performance.now() < hurriedUntil.current || !motion().moving())) {
    const element = root.current;
    const picked = element ? pickAnchor(element, input.spot()) : null;
    anchor.current = element && picked ? holdsOf(element, picked) : null;
    holdLog({
      what: "accept",
      branch: performance.now() < hurriedUntil.current ? "hurried" : "still",
      latest: input.peek(),
      used: input.spot(),
      usedBelow,
      anchor: describe(picked),
      rootTop: round(element?.getBoundingClientRect().top),
      places: anchor.current?.length ?? 0,
      scrollY: window.scrollY,
    });
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

  // Where the reader's attention is, kept for the moment the update lands: whichever of the mouse and the finger was
  // the last to act (see `createReaderSpot`), and else the focused element or the first thing in view. A finger is
  // heard from its touch events, and from the pointer events of a touch, which describe the same finger, until the
  // browser takes the gesture for a scroll and ends them. A pen's pointer events go with the mouse's; on a touch
  // screen its touch events tell of it as a finger.
  useEffect(() => {
    const note = (event: Event, x?: number, y?: number) => {
      if (event.type === "touchend" || event.type === "touchcancel") liftEpoch++;
      currentEvent = {
        type: event.type,
        pt: "pointerType" in event ? (event as PointerEvent).pointerType : "touch-ev",
        x: round(x),
        y: round(y),
        ts: round(event.timeStamp),
        trusted: event.isTrusted,
      };
    };
    const touch = (event: TouchEvent) => {
      // A finger that lifts is heard of too, so its memory runs from the lift, not from the touch of a long press.
      const first = event.touches[0] ?? event.changedTouches[0];
      note(event, first?.clientX, first?.clientY);
      if (first) input.touched(first.clientX, first.clientY);
      else holdLog({ what: "spot", ...currentEvent, decision: "no touch point" });
    };
    const track = (event: PointerEvent) => {
      note(event, event.clientX, event.clientY);
      if (event.pointerType === "touch") input.touched(event.clientX, event.clientY);
      else input.pointed(event.clientX, event.clientY, event.type === "pointerdown");
    };
    const release = (event: Event) => {
      note(event, (event as PointerEvent).clientX, (event as PointerEvent).clientY);
      if (event.type === "keydown") return input.keyed();
      // A mouse that is lifted is still over the page, and a finger that is lifted is remembered for a while.
      const type = "pointerType" in event ? event.pointerType : "";
      if (type === "touch" || (type === "mouse" && event.type === "pointerup")) {
        holdLog({
          what: "spot",
          key: `${event.type}/${type}/ignored-release`,
          ...currentEvent,
          decision: "release ignored",
        });
        return;
      }
      input.left();
    };
    document.addEventListener("keydown", release, { passive: true });
    document.addEventListener("pointerdown", track, { passive: true });
    document.addEventListener("pointermove", track, { passive: true });
    document.addEventListener("pointerup", release, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    document.documentElement.addEventListener("pointerleave", release, { passive: true });
    document.addEventListener("touchstart", touch, { passive: true });
    document.addEventListener("touchmove", touch, { passive: true });
    document.addEventListener("touchend", touch, { passive: true });
    document.addEventListener("touchcancel", touch, { passive: true });
    return () => {
      document.removeEventListener("keydown", release);
      document.removeEventListener("pointerdown", track);
      document.removeEventListener("pointermove", track);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.documentElement.removeEventListener("pointerleave", release);
      document.removeEventListener("touchstart", touch);
      document.removeEventListener("touchmove", touch);
      document.removeEventListener("touchend", touch);
      document.removeEventListener("touchcancel", touch);
    };
  }, [input]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for a change of what is shown, which is what moves the board.
  useLayoutEffect(() => {
    const held = anchor.current;
    anchor.current = null;
    const moving = motion().moving();
    const entry: Record<string, unknown> = {
      what: "layout",
      held: held === null ? null : held.length,
      scrollY: window.scrollY,
      moving,
    };
    if (held) {
      const measured = held.map((place, index) => ({
        i: index,
        was: round(place.was),
        now: round(place.now()),
        el: describe(heldEls[index])?.tag,
      }));
      entry.measured = measured.slice(0, 4);
    }
    if (!held || window.scrollY <= 0) {
      holdLog({ ...entry, exit: "no held or scrollY<=0" });
      return;
    }
    // A programmatic scroll would stop a flick on iOS, and a shift of the feed's size mid-flick goes unseen. The
    // update waits for the page to be still, so this only meets a page in motion when it was hurried.
    if (moving) {
      holdLog({ ...entry, exit: "moving" });
      return;
    }
    // Measured now, after the commit has been laid out, so it includes anything the browser has already scrolled
    // by; not a row or two of the feed when it is a reorder of the board, which the reader is not owed a ride with.
    const left = heldResidual(held, { scrollY: window.scrollY, viewport: window.innerHeight });
    entry.residual = left;
    if (!left) {
      holdLog({ ...entry, exit: "no residual" });
      return;
    }
    const watched = heldEls.find((element) => element.isConnected) ?? null;
    const topBefore = round(watched?.getBoundingClientRect().top);
    quietScroll(() => window.scrollBy({ top: left, behavior: "instant" }));
    const slot: Record<string, unknown> = {
      ...entry,
      exit: "scrolled",
      ranQuietScroll: true,
      topBefore,
      topAfter: round(watched?.getBoundingClientRect().top),
      scrollYAfter: window.scrollY,
    };
    holdLog(slot);
    requestAnimationFrame(() => {
      holdLog({ what: "next-frame", top: round(watched?.getBoundingClientRect().top), scrollY: window.scrollY });
      requestAnimationFrame(() =>
        holdLog({ what: "frame+2", top: round(watched?.getBoundingClientRect().top), scrollY: window.scrollY }),
      );
    });
  }, [shown]);

  return {
    shown,
    hurry: () => {
      hurriedUntil.current = performance.now() + HURRY_MS;
    },
  };
}
