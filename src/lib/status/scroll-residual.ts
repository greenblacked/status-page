/**
 * How far the page has to scroll to put the place the reader is on back where it was: what is left of the
 * anchor's move once the browser has done what it does by itself.
 *
 * `was` and `now` are the anchor's top in the window before and after the board changed. They are read from the
 * page, not worked out from the scroll position, so they already include whatever the browser did: scroll
 * anchoring that held the place gives `now` equal to `was` (nothing is left to do, and nothing is done twice),
 * anchoring that held part of it leaves the rest, and a browser that does not anchor, or does not anchor in this
 * case, leaves all of it. Positive means scroll down.
 *
 * Nothing is owed (0) when:
 * - the page is at its top or pulled past it (`scrollY <= 0`): nothing above the reader moves them there;
 * - the anchor moved less than half a pixel, which is no move;
 * - it moved by more than a screen (`viewport`): a reorder of the board, which the reader is not owed a ride along with.
 */
export function scrollResidual({
  was,
  now,
  scrollY,
  viewport,
}: {
  was: number;
  now: number;
  scrollY: number;
  viewport: number;
}): number {
  if (scrollY <= 0) return 0;
  const left = now - was;
  if (!Number.isFinite(left) || Math.abs(left) < 0.5 || Math.abs(left) > viewport) return 0;
  return left;
}

/** A place the reader can be held by: where its top was in the window, and a way to read where it is now (null when it is gone). */
export type Held = { was: number; now: () => number | null };

/**
 * The residual (see `scrollResidual`) of the first place that can still be measured, from the one the reader is on
 * outwards: the update may take that one out of the page (a tag that is cleared, a row that is replaced), and the
 * element around it that stays is the next best thing to hold. Null when none can.
 */
export function heldResidual(
  places: readonly Held[],
  { scrollY, viewport }: { scrollY: number; viewport: number },
): number | null {
  for (const { was, now } of places) {
    const at = now();
    if (at !== null) return scrollResidual({ was, now: at, scrollY, viewport });
  }
  return null;
}
