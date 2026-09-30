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
/**
 * How long to wait for an update that never commits (or moves no card) before
 * letting go. A slow phone takes a good part of a second over a frame, and a
 * deferred commit waits behind them, so this is generous: the wait ends at
 * the first glide, at the person's next input, or when a newer press replaces
 * it, and until then it only reacts to a card that has really moved.
 */
const GLIDE_WAIT_MS = 1500;

/** Where every card is in the viewport, and how far the page was scrolled when that was measured. */
interface Layout {
  boxes: Map<string, Box>;
  scrollX: number;
  scrollY: number;
}

function measureCards(): Layout {
  const boxes = new Map<string, Box>();
  for (const card of document.querySelectorAll<HTMLElement>('article[id^="service-"]')) {
    const { left, top, width, height } = card.getBoundingClientRect();
    boxes.set(card.id, { left, top, width, height });
  }
  return { boxes, scrollX: window.scrollX, scrollY: window.scrollY };
}

/**
 * The earlier layout as it would read at the current scroll position. The
 * page can scroll between the measurement and a deferred commit (a tap that
 * focuses a control does), and that shifts every card in the viewport without
 * moving any of them on the page, so it must not count as movement.
 */
function atCurrentScroll(before: Layout): Map<string, Box> {
  const shiftX = window.scrollX - before.scrollX;
  const shiftY = window.scrollY - before.scrollY;
  if (shiftX === 0 && shiftY === 0) return before.boxes;
  const shifted = new Map<string, Box>();
  for (const [id, box] of before.boxes) shifted.set(id, { ...box, left: box.left - shiftX, top: box.top - shiftY });
  return shifted;
}

/** A card still fading in carries a few pixels of `rise-in` offset, which would fight the glide over `transform`. */
function settleRiseIn(card: Element): void {
  for (const animation of card.getAnimations()) {
    if ((animation as CSSAnimation).animationName === "rise-in") animation.finish();
  }
}

/** Glides every card that moved from where it was to where it is now; false when none did. */
function glideCards(before: Layout): boolean {
  // Settled first, so the measurement below is where each card really is.
  for (const id of before.boxes.keys()) {
    const card = document.getElementById(id);
    if (card) settleRiseIn(card);
  }
  const moves = cardMoves(atCurrentScroll(before), measureCards().boxes, window.innerHeight);
  for (const { id, dx, dy } of moves) {
    // A card that crossed sections is a new node, so look it up by id.
    const card = document.getElementById(id);
    if (!card) continue;
    const glide = card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: GLIDE_MS,
      easing: GLIDE_EASING,
    });
    glide.id = GLIDE_ID;
  }
  return moves.length > 0;
}

/**
 * What the person does to the board itself, or to the window around it, which
 * ends the wait for an update: a resize or a rotation relays the cards out
 * with no DOM change, and the next unrelated change would glide them back
 * across. Not scrolling: a scroll leaves every card where it is on the page,
 * and a tap can scroll on its own before the update commits.
 */
const INTERACTIONS = ["pointerdown", "keydown", "input", "resize", "orientationchange"] as const;

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
 * An update that React defers (a query cache write) commits after this
 * returns, so the cards are compared on each change to the board until one
 * has moved, and the call is done at the first glide. It also ends, having
 * glided nothing, at the person's next input or a resize, a newer press, or
 * after a bound, so a later filter, rotation or unrelated change is never
 * measured against this call's start.
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
  // Two tiny timeline entries per press, read by the tests to say why a glide did not happen.
  performance.mark("card-motion:start");
  let timer = 0;
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    for (const type of INTERACTIONS) window.removeEventListener(type, stop, true);
    if (pending === stop) pending = undefined;
  };
  // A change that moves no card is not necessarily the update: on a slow
  // engine something unrelated (a clock-driven text, the board log, the
  // empty-board skeleton) can commit inside the board before a deferred cache
  // write does. So the wait goes on until a card has moved, and lets go on
  // the person's input or a resize.
  const glide = () => {
    if (!glideCards(before)) return false;
    performance.mark("card-motion:glide");
    stop();
    return true;
  };
  // Registered before the update: a deferred one (a query cache write reaches
  // React on a timer) lands after this function returns, and the observer sees it.
  const observer = new MutationObserver(() => {
    try {
      glide();
    } catch (error) {
      stop();
      throw error;
    }
  });
  observer.observe(document.getElementById("services") ?? document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  pending = stop;
  // An update that changes nothing in the board leaves the observer waiting, and whatever the person does
  // next (a filter, a rotation that relays the cards out with no DOM change) would be measured against
  // this call's start. Their input or a resize ends the wait.
  for (const type of INTERACTIONS) window.addEventListener(type, stop, { capture: true, passive: true });
  // The bound on an update that never reaches the DOM, set first so nothing below can leave the observer attached.
  timer = window.setTimeout(stop, GLIDE_WAIT_MS);
  try {
    flushSync(update);
    if (observer.takeRecords().length > 0) glide();
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
