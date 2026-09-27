import { type RefObject, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Runs a state update inside a View Transition where the browser supports
 * one, so cards glide to their new place when a refresh moves a service
 * between sections. Elsewhere, and with reduced motion, the update simply
 * applies.
 *
 * Not for filters: the browser holds the update until it has snapshotted
 * every named card, and with the glass blur that measured 170-370 ms in
 * headless Chromium against one frame without it. A filter has to feel
 * instant; a refresh already waits on the network.
 */
export function withViewTransition(update: () => void): void {
  if (typeof document === "undefined" || !("startViewTransition" in document) || prefersReducedMotion()) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}

/**
 * Tracks the pointer over any `.spotlight` element inside `container` and
 * exposes it as --spot-x/--spot-y, which the CSS turns into a soft light.
 * One delegated listener and one frame per move, however many cards.
 */
export function useSpotlight(container: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = container.current;
    if (!root || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const paint = () => {
      frame = 0;
      const event = last;
      const target = event?.target instanceof Element ? event.target.closest<HTMLElement>(".spotlight") : null;
      if (!event || !target) return;
      const box = target.getBoundingClientRect();
      target.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
      target.style.setProperty("--spot-y", `${event.clientY - box.top}px`);
    };
    const onMove = (event: PointerEvent) => {
      last = event;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    root.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      root.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [container]);
}

/**
 * Counts from the previous value to the new one when it changes. The first
 * render shows the real value, so server and client markup agree.
 */
export function useCountUp(value: number, durationMs = 600): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || prefersReducedMotion()) {
      setShown(value);
      return;
    }
    let frame = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(start + (value - start) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return shown;
}
