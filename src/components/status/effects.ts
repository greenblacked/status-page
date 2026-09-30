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
/** How long to wait for an update that never commits (or changes nothing in the board) before letting go. */
const GLIDE_WAIT_MS = 400;

function measureCards(): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const card of document.querySelectorAll<HTMLElement>('article[id^="service-"]')) {
    const { left, top, width, height } = card.getBoundingClientRect();
    boxes.set(card.id, { left, top, width, height });
  }
  return boxes;
}

/** A card still fading in carries a few pixels of `rise-in` offset, which would fight the glide over `transform`. */
function settleRiseIn(card: Element): void {
  for (const animation of card.getAnimations()) {
    if ((animation as CSSAnimation).animationName === "rise-in") animation.finish();
  }
}

/** Glides every card that moved from where it was to where it is now. */
function glideCards(before: ReadonlyMap<string, Box>): void {
  // Settled first, so the measurement below is where each card really is.
  for (const id of before.keys()) {
    const card = document.getElementById(id);
    if (card) settleRiseIn(card);
  }
  for (const { id, dx, dy } of cardMoves(before, measureCards(), window.innerHeight)) {
    // A card that crossed sections is a new node, so look it up by id.
    const card = document.getElementById(id);
    if (!card) continue;
    const glide = card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: GLIDE_MS,
      easing: GLIDE_EASING,
    });
    glide.id = GLIDE_ID;
  }
}

/** What the person does that moves the page or the board themselves, and so ends the wait for an update. */
const INTERACTIONS = ["scroll", "wheel", "touchstart", "pointerdown", "keydown", "input"] as const;

/** Lets go of the call in progress, if it is still waiting for its update to commit. */
let pending: (() => void) | undefined;

/**
 * Applies a state update that moves cards (a star, a refresh) and glides
 * them from their old place to the new one: FLIP, First-Last-Invert-Play.
 * The cards' places are measured before and after, and each one that moved
 * animates `transform` only, from the distance it moved back to nothing. The
 * update itself applies at once and touches nothing but that animation, so
 * focus and node identity are unaffected.
 *
 * The first change to the board after the update is its commit: the cards
 * are compared then, whether or not any moved, and the call is done. A later
 * change (a filter, a scroll) is never measured against this call's start.
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
  // A newer press supersedes one still waiting on its commit.
  pending?.();
  // Measured before cancelling, so a glide in flight counts as where its card is.
  const before = measureCards();
  for (const animation of document.getAnimations()) {
    if (animation.id === GLIDE_ID) animation.cancel();
  }
  let timer = 0;
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    for (const type of INTERACTIONS) window.removeEventListener(type, stop, true);
    if (pending === stop) pending = undefined;
  };
  // Registered before the update: a deferred one (a query cache write reaches
  // React on a timer) lands after this function returns, and the observer sees it.
  const observer = new MutationObserver(() => {
    try {
      glideCards(before);
    } finally {
      stop();
    }
  });
  observer.observe(document.getElementById("services") ?? document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  pending = stop;
  // An update that changes nothing in the board leaves the observer waiting, and whatever the person does
  // next (a scroll, a filter) would be measured against this call's start. Their input ends the wait.
  for (const type of INTERACTIONS) window.addEventListener(type, stop, { capture: true, passive: true });
  // The bound on an update that never reaches the DOM, set first so nothing below can leave the observer attached.
  timer = window.setTimeout(stop, GLIDE_WAIT_MS);
  try {
    flushSync(update);
    if (observer.takeRecords().length > 0) {
      glideCards(before);
      stop();
    }
  } catch (error) {
    stop();
    throw error;
  }
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
