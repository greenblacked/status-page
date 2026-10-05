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
   * movement. Exactly 0,0 is no place at all: it is what an automated browser (Playwright's WebKit) and a browser
   * that fills none put there, on every report, so it is neither kept nor compared with. (A real cursor in the
   * screen's top left pixel is then judged as a report with no screen place, which only costs it the screen test.)
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
 * left in a corner would win over the finger on every scroll. A report, other than a press, is judged in this order:
 *
 * 1. Within a pixel of where the mouse was last seen, it is a repeat of that, and not taken (a browser reports the same
 *    place with a fraction of difference). This holds whatever else the report says.
 * 2. A `movement` other than 0 is a move, and marks the browser as one that reports movement. From then on a report
 *    with no movement is not taken, and the place on the screen is not looked at (it may follow the page as it
 *    scrolls).
 * 3. A browser that has not shown movement but gives a real place on the screen is judged by it: the report is a move
 *    if that place is a pixel or more from the one of the report before, and not otherwise. The first report with a
 *    real place has none before it, so it says nothing: the engine's own report after a scroll (WebKit's first, with
 *    the screen place it has just learnt) must not win over the finger.
 * 4. A report with neither (no movement given, or 0 before any other, and no real screen place: an automated WebKit
 *    gives 0 for all of it) has only the window place to be told by. It is a move when it is a pixel or more from the
 *    last place the mouse was seen at, or when none was seen yet. This is all it can do: a mouse the page never saw
 *    (clicked before it listened, or left from an earlier page) is not a repeat of anything, and a report at the old
 *    place is rule 1's.
 *
 * "Seen" is kept when the mouse is cleared by a finger or a key, and by `left`, so the browser reporting the old place
 * again after that is still a repeat; only a mouse that moves to another place, or a press, takes the spot back.
 *
 * `memoryMs` is how long a finger that has lifted still says where the reader is (its pointer events end as soon as
 * the browser takes the gesture for a scroll, and the update comes a moment after); a mouse is where it was until it
 * leaves the page or a key is pressed, since a mouse at rest on a card is the reader being on it.
 */
export function createReaderSpot(now: () => number, memoryMs: number) {
  let mouse: Spot | null = null;
  // Where the mouse was last seen, kept when `mouse` is cleared by a finger or a key, to know a repeat of it.
  let seen: Spot | null = null;
  // Where the mouse was last on the screen (a real place, not 0,0), from the last report with one, taken or not.
  let lastScreen: Spot | null = null;
  // Whether the browser has said, on this page, that the mouse moved by a distance other than 0: it reports movement.
  let reportsMovement = false;
  let finger: (Spot & { at: number }) | null = null;
  return {
    /** The mouse (or a pen above the glass) moved or pressed to here, with what the event says of it (see above). */
    pointed(x: number, y: number, { pressed = false, screen, movement }: MouseReport = {}) {
      // Exactly 0,0 is no screen place (an automated browser, or one that gives none): not kept, not compared.
      const place = screen && (screen.x !== 0 || screen.y !== 0) ? screen : undefined;
      // The screen place is kept for every report, those that are not taken too: it is what the next is compared with.
      const before = lastScreen;
      if (place) lastScreen = place;
      const said = movement !== undefined && (movement.x !== 0 || movement.y !== 0);
      if (said) reportsMovement = true;
      if (!pressed) {
        // Within a pixel, for a browser that reports the same place with a fraction of difference.
        if (seen && !apart(seen, { x, y })) return;
        if (!said) {
          // A browser that reports movement says so when the mouse moves: a report without it is the browser's own.
          if (reportsMovement) return;
          // Otherwise a real screen place that has not changed (or the first, with nothing to compare with) is too.
          // With none of either, the window place has already been told apart from the last seen, above.
          if (place && !(before !== null && apart(before, place))) return;
        }
      }
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
