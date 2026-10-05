/** A place in the window, in px from its top left. */
export type Spot = { x: number; y: number };

/**
 * Where the reader is on the page, from the last thing they did with a finger or a mouse. The two are told apart by
 * which came last: a finger down or moving takes the place of a mouse that was left somewhere (a touch screen with a
 * trackpad, or a browser that never says its mouse has gone), and a mouse that moves afterwards takes it back.
 *
 * A browser may also report a mouse again with no move of it: WebKit sends a pointermove at the mouse's old place
 * each time the page scrolls. That says nothing new, so a move to the place the mouse was last seen at is not taken
 * for the reader doing something, or a mouse left in a corner would win over the finger on every scroll.
 *
 * `memoryMs` is how long a finger that has lifted still says where the reader is (its pointer events end as soon as
 * the browser takes the gesture for a scroll, and the update comes a moment after); a mouse is where it was until it
 * leaves the page or a key is pressed, since a mouse at rest on a card is the reader being on it.
 */
export function createReaderSpot(now: () => number, memoryMs: number) {
  let mouse: Spot | null = null;
  // Where the mouse was last seen, kept when `mouse` is cleared by a finger or a key, to know a repeat of it.
  let seen: Spot | null = null;
  let finger: (Spot & { at: number }) | null = null;
  return {
    /** The mouse (or a pen above the glass) moved or pressed to here. */
    pointed(x: number, y: number, pressed = false) {
      // Within a pixel, for a browser that reports the same place with a fraction of difference.
      if (!pressed && seen && Math.abs(seen.x - x) < 1 && Math.abs(seen.y - y) < 1) return;
      seen = { x, y };
      mouse = { x, y };
    },
    /** A finger is at here (a pen on the glass sends touch events too). It takes the place of a mouse that was left behind. */
    touched(x: number, y: number) {
      finger = { x, y, at: now() };
      mouse = null;
    },
    /**
     * The mouse left the page, or a pen lifted. Where it was last seen is kept, since a browser may go on reporting
     * that place after it has said the mouse went (see above), and that is no more the mouse coming back than before.
     */
    left() {
      mouse = null;
    },
    /** A key was pressed: the reader is where the keyboard focus is, not where a pointer or a finger was. */
    keyed() {
      mouse = null;
      finger = null;
    },
    /** What the reader is on now, if the last thing they did says: the mouse, else a finger that lifted a moment ago. */
    spot(): Spot | null {
      if (mouse) return mouse;
      return finger && now() - finger.at < memoryMs ? { x: finger.x, y: finger.y } : null;
    },
  };
}
