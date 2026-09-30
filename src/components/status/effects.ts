import { type RefObject, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type Box, cardMoves } from "@/lib/status/flip";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The name of a card glide, so the next one (and the tests) can find it. */
const GLIDE_ID = "card-move";
/** The values of the CSS tokens --motion-fast and --ease-smooth-out, which the cards' own motion uses. */
const GLIDE_MS = 250;
const GLIDE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/** How long to wait for a deferred update (a refresh) to reach the DOM before giving up on the glide. */
const GLIDE_WAIT_MS = 400;

function measureCards(): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const card of document.querySelectorAll<HTMLElement>('article[id^="service-"]')) {
    const { left, top, width, height } = card.getBoundingClientRect();
    boxes.set(card.id, { left, top, width, height });
  }
  return boxes;
}

/** Glides every card that moved from where it was to where it is now; true once at least one did. */
function glideCards(before: ReadonlyMap<string, Box>): boolean {
  const moves = cardMoves(before, measureCards(), window.innerHeight);
  for (const { id, dx, dy } of moves) {
    // A card that crossed sections is a new node, so look it up by id.
    const card = document.getElementById(id);
    if (!card) continue;
    // A card still fading in would fight the glide over `transform`.
    for (const animation of card.getAnimations()) {
      if ((animation as CSSAnimation).animationName === "rise-in") animation.finish();
    }
    const glide = card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: GLIDE_MS,
      easing: GLIDE_EASING,
    });
    glide.id = GLIDE_ID;
  }
  return moves.length > 0;
}

/**
 * Applies a state update that moves cards (a star, a refresh) and glides
 * them from their old place to the new one: FLIP, First-Last-Invert-Play.
 * The cards' places are measured before and after, and each one that moved
 * animates `transform` only, from the distance it moved back to nothing. The
 * update itself applies at once and touches nothing but that animation, so
 * focus and node identity are unaffected.
 *
 * Not a View Transition: naming every card makes the browser snapshot all of
 * them (and their blur) before it lets the update through, which took
 * hundreds of milliseconds, and seconds on WebKit. Nor does one see an update
 * that React defers, as a query cache write is. A glide already running is
 * cancelled after measuring, so a second press carries on from where the
 * cards are. With reduced motion, or without the Web Animations API, the
 * update simply applies.
 *
 * Not for filters: they have to feel instant, and the cards' stagger already
 * animates the board that comes back.
 */
export function withCardMotion(update: () => void): void {
  if (typeof document === "undefined" || prefersReducedMotion() || typeof Element.prototype.animate !== "function") {
    update();
    return;
  }
  // Measured before cancelling, so a glide in flight counts as where its card is.
  const before = measureCards();
  for (const animation of document.getAnimations()) {
    if (animation.id === GLIDE_ID) animation.cancel();
  }
  let timer = 0;
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
  };
  // Registered before the update: a deferred one (a query cache write reaches
  // React on a timer) lands after this function returns, and the observer sees it.
  const observer = new MutationObserver(() => {
    if (glideCards(before)) stop();
  });
  observer.observe(document.getElementById("services") ?? document.body, { childList: true, subtree: true });
  try {
    flushSync(update);
  } catch (error) {
    stop();
    throw error;
  }
  if (observer.takeRecords().length > 0 && glideCards(before)) {
    stop();
    return;
  }
  timer = window.setTimeout(stop, GLIDE_WAIT_MS);
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
