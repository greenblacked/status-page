/** A card's rectangle in viewport coordinates, as getBoundingClientRect reports it. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far a card sits from where it now belongs: the offset it glides in from. */
export interface Move {
  id: string;
  dx: number;
  dy: number;
}

/**
 * The cards that changed place between two measurements, for a FLIP glide:
 * each starts `dx`/`dy` away from its new place and eases to it.
 *
 * Only ids on both sides count (a card that appeared or vanished has nothing
 * to glide from or to). A move under `threshold` pixels on both axes is
 * sub-pixel noise. A card fully outside the viewport both before and after is
 * skipped, since nobody sees it; one that enters or leaves the viewport is
 * kept. At most `limit` moves come back, so a large reshuffle stays cheap.
 */
export function cardMoves(
  before: ReadonlyMap<string, Box>,
  after: ReadonlyMap<string, Box>,
  viewportHeight: number,
  { threshold = 1, limit = 24 }: { threshold?: number; limit?: number } = {},
): Move[] {
  const offscreen = (box: Box) => box.top + box.height < 0 || box.top > viewportHeight;
  const moves: Move[] = [];
  for (const [id, from] of before) {
    const to = after.get(id);
    if (!to) continue;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) continue;
    if (offscreen(from) && offscreen(to)) continue;
    moves.push({ id, dx, dy });
    if (moves.length >= limit) break;
  }
  return moves;
}
