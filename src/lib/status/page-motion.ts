/** How long the page must be still, no finger on it and no scroll event, before it counts as at rest. */
export const SETTLE_MS = 150;

/**
 * A finger that has been down this long without a single touch event is taken to have lifted: a browser that
 * lost the `touchend` (a call, the app switcher) must not leave the board frozen for good.
 */
export const TOUCH_EXPIRES_MS = 5_000;

/** How often a deferred update looks again while a finger is still down. */
export const TOUCH_POLL_MS = 50;

export type MotionTracker = {
  /** A touch event arrived, with the number of fingers still on the screen after it. */
  touched: (fingers: number) => void;
  /** The page scrolled. */
  scrolled: () => void;
  /** Everything stops counting (the tab went to the background). */
  reset: () => void;
  /** Whether a finger is down or the page scrolled within `SETTLE_MS`. */
  moving: () => boolean;
  /** How long until the page is at rest if nothing else happens: 0 when it is. */
  restsIn: () => number;
};

/**
 * What a reader is doing to the page, as far as a board update must care: scrolling it, or holding a finger on
 * it. A finger counts from the touch to the lift, scroll events and all (a finger that pauses mid-drag sends none),
 * and a scroll for `SETTLE_MS` after its last event, which also covers a flick's glide (iOS sends scroll events
 * all through it). `now` is the clock; the page passes performance.now.
 */
export function createMotionTracker(now: () => number): MotionTracker {
  let fingers = 0;
  let lastTouch = Number.NEGATIVE_INFINITY;
  let lastScroll = Number.NEGATIVE_INFINITY;
  const touching = () => {
    if (fingers > 0 && now() - lastTouch > TOUCH_EXPIRES_MS) fingers = 0;
    return fingers > 0;
  };
  return {
    touched: (count) => {
      fingers = Math.max(0, count);
      lastTouch = now();
    },
    scrolled: () => {
      lastScroll = now();
    },
    reset: () => {
      fingers = 0;
      lastScroll = Number.NEGATIVE_INFINITY;
    },
    moving: () => touching() || now() - lastScroll < SETTLE_MS,
    restsIn: () => (touching() ? TOUCH_POLL_MS : Math.max(0, SETTLE_MS - (now() - lastScroll))),
  };
}
