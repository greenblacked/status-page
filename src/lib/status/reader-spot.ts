/** A place in the window, in px from its top left. */
export type Spot = { x: number; y: number };

/** Whether two places are a pixel or more apart, either way (less is a browser's fraction of difference). */
const apart = (a: Spot, b: Spot) => Math.abs(a.x - b.x) >= 1 || Math.abs(a.y - b.y) >= 1;

/** What a mouse report says about the mouse itself, besides where in the window it is (all read off the event). */
export type MouseReport = {
  /** A press: the reader did something, wherever the mouse is. */
  pressed?: boolean;
  /**
   * Where the mouse is on the screen (`screenX`, `screenY`), for a browser whose events say nothing of movement. Where
   * a browser gives a real place on the screen, scrolling the page under a mouse does not change it; where it does
   * not (iPadOS gives a place in the page), it may, so it is not relied on once the browser has shown it reports
   * movement.
   */
  screen?: Spot;
  /** How far the mouse moved since the last report of it (`movementX`, `movementY`): 0 for a report with no move. */
  movement?: Spot;
};

/**
 * Where the reader is on the page, from the last thing they did with a finger or a mouse. The two are told apart by
 * which came last: a finger down or moving takes the place of a mouse that was left somewhere (a touch screen with a
 * trackpad, or a browser that never says its mouse has gone), and a mouse that moves afterwards takes it back.
 *
 * A browser may also report a mouse again with no move of it: WebKit sends a pointermove and a mousemove at the
 * mouse's place each time the page scrolls or lays out again, to update what is hovered (a finger's scroll is no
 * move of a trackpad's cursor). That says nothing new, so it is not taken for the reader doing something, or a mouse
 * left in a corner would win over the finger on every scroll. What tells a move is what the event says: its
 * `movement` is not 0. A browser that has sent a movement other than 0 on this page reports movement, and is
 * judged by that alone, since its place on the screen is not always one (it may follow the page as it scrolls). Only
 * a browser that never has (it gives none, or always 0) is judged by the mouse being at another place on the screen
 * than at its last report. The window place alone is not told by: a repeat is a guess at "the same place as before,
 * give or take a fraction of a pixel" (kept for a browser that tells neither of the two above), and it is wrong
 * whenever the page did not see the place the mouse is really at (a mouse clicked before the page listened, or one
 * left from an earlier page): the browser reports the cursor where it is, not where the page last saw it.
 *
 * The first report of a mouse on a page has no earlier place to compare with, so it counts only if it says it moved
 * or is a press. A real mouse that comes in sends another report a few ms later, which does count; a lone report
 * that says nothing is the browser's own, and taking it would let a cursor that never moved win over the finger the
 * first time the page scrolls. A report with neither a movement nor a place on the screen has nothing to be told by,
 * and is judged by the window place alone, as above.
 *
 * `memoryMs` is how long a finger that has lifted still says where the reader is (its pointer events end as soon as
 * the browser takes the gesture for a scroll, and the update comes a moment after); a mouse is where it was until it
 * leaves the page or a key is pressed, since a mouse at rest on a card is the reader being on it.
 */
export function createReaderSpot(now: () => number, memoryMs: number) {
  let mouse: Spot | null = null;
  // Where the mouse was last seen, kept when `mouse` is cleared by a finger or a key, to know a repeat of it.
  let seen: Spot | null = null;
  // Where the mouse was last on the screen, from the last report of it, whatever became of that report.
  let lastScreen: Spot | null = null;
  // Whether the browser has said, on this page, that the mouse moved by a distance other than 0: it reports movement.
  let reportsMovement = false;
  let finger: (Spot & { at: number }) | null = null;
  return {
    /** The mouse (or a pen above the glass) moved or pressed to here, with what the event says of it (see above). */
    pointed(x: number, y: number, { pressed = false, screen, movement }: MouseReport = {}): boolean {
      // The screen place is kept for every report, those that are not taken too: it is what the next is compared with.
      const before = lastScreen;
      if (screen) lastScreen = screen;
      const said = movement !== undefined && (movement.x !== 0 || movement.y !== 0);
      if (said) reportsMovement = true;
      if (!pressed) {
        // Within a pixel, for a browser that reports the same place with a fraction of difference.
        if (seen && !apart(seen, { x, y })) return false;
        if (screen || movement) {
          const went = !reportsMovement && screen !== undefined && before !== null && apart(before, screen);
          if (!said && !went) return false;
        }
      }
      seen = { x, y };
      mouse = { x, y };
      return true;
    },
    /** Whether the browser has said the mouse moved by a distance other than 0 (diagnosis only). */
    reportsMovement: () => reportsMovement,
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
