import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { quietScroll } from "@/lib/status/dock";
import type { Pulse } from "@/lib/status/pulse";

/** Whether the browser keeps what the reader looks at in place when the page above it changes size (scroll anchoring). */
function anchorsScroll(): boolean {
  return (
    CSS.supports("overflow-anchor", "auto") && getComputedStyle(document.documentElement).overflowAnchor !== "none"
  );
}

/** How long after the last scroll the page counts as still moving, and the wait before the anchor is picked again. */
const SETTLE_MS = 150;
const STALE_MS = 200;

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
 * Keeps the reader's place when a check changes the board above it. The check at the turn of a slot adds a
 * row to Recent changes and clears the "Changed" tags of the one before, in one commit, so everything under
 * them, a button the reader is about to press included, drops or rises. Chrome and Firefox hold the place
 * themselves; Safari has no scroll anchoring, so there the page scrolls by the distance its anchor moved.
 * The anchor and its top are kept current as the reader scrolls and the board resizes, so a resize, a
 * rotation or a late font never leaves a stale number behind.
 */
export function useHoldPlace(root: RefObject<HTMLElement | null>, pulses: Pulse[] | undefined) {
  // The anchor's place is kept as an offset in the document, so the reader's own scrolling cancels out of it.
  const anchor = useRef<{ element: Element; offset: number } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const motion = useRef({ lastScroll: Number.NEGATIVE_INFINITY, touching: false });

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0;
    let idle = 0;
    const remember = () => {
      frame = 0;
      const picked = pickAnchor(element, pointer.current);
      anchor.current = picked ? { element: picked, offset: picked.getBoundingClientRect().top + window.scrollY } : null;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(remember);
    };
    // Scrolling only stamps the time; the anchor is picked again once the page has been still for a moment.
    const scrolled = () => {
      motion.current.lastScroll = performance.now();
      clearTimeout(idle);
      idle = window.setTimeout(schedule, SETTLE_MS);
    };
    // A finger counts while it is down, a mouse while it is in the page.
    const track = (event: PointerEvent) => {
      if (event.type === "pointerdown" && event.pointerType === "touch") motion.current.touching = true;
      pointer.current = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const release = (event: Event) => {
      if (event instanceof PointerEvent && event.pointerType === "touch") motion.current.touching = false;
      if (event instanceof PointerEvent && event.pointerType === "mouse" && event.type === "pointerup") return;
      pointer.current = null;
      schedule();
    };
    document.addEventListener("keydown", release, { passive: true });
    remember();
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    observer.observe(element);
    window.addEventListener("scroll", scrolled, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("pointerdown", track, { passive: true });
    document.addEventListener("pointermove", track, { passive: true });
    document.addEventListener("pointerup", release, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    document.documentElement.addEventListener("pointerleave", release, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(idle);
      observer.disconnect();
      window.removeEventListener("scroll", scrolled);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("keydown", release);
      document.removeEventListener("pointerdown", track);
      document.removeEventListener("pointermove", track);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.documentElement.removeEventListener("pointerleave", release);
    };
  }, [root]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for a change of the pulses, which is what moves the board.
  useLayoutEffect(() => {
    const last = anchor.current;
    if (!last?.element.isConnected || window.scrollY <= 0 || anchorsScroll()) return;
    // A programmatic scroll would stop a flick on iOS, and a shift of the feed's size mid-flick goes unseen.
    const { lastScroll, touching } = motion.current;
    if (touching || performance.now() - lastScroll < STALE_MS) return;
    const moved = last.element.getBoundingClientRect().top + window.scrollY - last.offset;
    // Not a row or two of the feed: a reorder of the board, which the reader is not owed a ride along with.
    if (Math.abs(moved) < 0.5 || Math.abs(moved) > window.innerHeight) return;
    quietScroll(() => window.scrollBy({ top: moved, behavior: "instant" }));
  }, [pulses]);
}
