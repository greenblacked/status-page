import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import type { Pulse } from "@/lib/status/pulse";

/** Whether the browser keeps what the reader looks at in place when the page above it changes size (scroll anchoring). */
function anchorsScroll(): boolean {
  return (
    CSS.supports("overflow-anchor", "auto") && getComputedStyle(document.documentElement).overflowAnchor !== "none"
  );
}

/** The first thing in view under the root, as scroll anchoring picks it: the first child wholly in view, else the deepest one cut by the top edge. */
function firstInView(root: Element): Element | null {
  for (const child of root.children) {
    const { top, bottom, width, height } = child.getBoundingClientRect();
    if ((width === 0 && height === 0) || bottom <= 0 || top >= window.innerHeight) continue;
    if (getComputedStyle(child).overflowAnchor === "none") continue;
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
  const anchor = useRef<{ element: Element; top: number } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0;
    const remember = () => {
      frame = 0;
      const picked = pickAnchor(element, pointer.current);
      anchor.current = picked ? { element: picked, top: picked.getBoundingClientRect().top } : null;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(remember);
    };
    // A finger counts while it is down, a mouse while it is in the page.
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const release = (event: Event) => {
      if (event instanceof PointerEvent && event.pointerType === "mouse" && event.type === "pointerup") return;
      pointer.current = null;
      schedule();
    };
    document.addEventListener("keydown", release, { passive: true });
    remember();
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    observer.observe(element);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("pointerdown", track, { passive: true });
    document.addEventListener("pointermove", track, { passive: true });
    document.addEventListener("pointerup", release, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    document.documentElement.addEventListener("pointerleave", release, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
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
    const moved = last.element.getBoundingClientRect().top - last.top;
    if (moved !== 0) window.scrollBy({ top: moved, behavior: "instant" });
  }, [pulses]);
}
