import { findCloudflareContext } from "./cloudflare-context";
import type { BoardSnapshot, Health, ServiceSnapshot } from "./types";

function emptyCounts(): Record<Health, number> {
  return { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
}

export function assembleBoard(services: ServiceSnapshot[], durationMs: number): BoardSnapshot {
  const counts = emptyCounts();
  for (const service of services) counts[service.health] += 1;
  return {
    generatedAt: new Date().toISOString(),
    durationMs,
    services,
    counts,
  };
}

/** Hands the board cache a change to the board it was given, once the board has gone out. */
export type LatePatch = (board: BoardSnapshot) => BoardSnapshot;

type CollectBoardOptions = { onLate?: (patch: LatePatch) => void };

/**
 * Sweeps every vendor once, adds the release feeds and the MikroTik changelog
 * notes that are in hand, and assembles the result into a board snapshot.
 * Shared by Node and Cloudflare Workers through the board cache
 * (board-cache.server.ts), so there is exactly one place that calls
 * `collectAllServices()` and exactly one that starts the release feeds (the
 * JSON API, the badges and the Refresh button all reach them through this
 * function).
 *
 * The sweep runs under the process's shared source policy (source-policy.ts),
 * so slow-moving sources are read on their own cadence, a source that keeps
 * failing is asked less often, and a one-off failure shows the last good
 * reading for a few minutes.
 *
 * The release feeds start only after the health sweep has settled, never
 * beside it. A Worker holds at most six outgoing connections at once and
 * queues the rest inside fetch(). The sweep's own requests share a gate that
 * starts each timeout only once a connection is free, but a feed outside that
 * gate would take one of the six unseen, and a health request would then wait
 * in fetch() with its timer running; the sweep is many more requests than six
 * (the tests measure it), so a feed started first or alongside could turn a
 * slow but working status source into No data. Started
 * afterwards, a feed can never hold a slot while a health request is pending
 * or queued, and it cannot lengthen the sweep or change any result. The
 * board is never held for them either: it ends when the sweep does, with the
 * feeds the cache already holds, and `durationMs` is the sweep's. Feeds that
 * are due are read right after, in the background (`waitUntil` on Workers,
 * which is what keeps the request alive for them; elsewhere the process
 * simply carries on).
 * The MikroTik changelogs (the notes in its Details and its summary line) are
 * read the same way, in the same `waitUntil`, but only once the feeds have
 * settled: their timeout starts with the request, so beside the feeds they
 * could spend it queued for a connection and fail unread. The collector reads
 * the version channels only, so a changelog host that is slow or down changes
 * no result and no `durationMs`.
 *
 * When those reads have settled and brought anything new (a feed that was not
 * in hand, a newer one, or notes), `onLate` is handed a patch that puts them
 * on this board in place, so a cold board shows its release lines as soon as
 * they arrive rather than a whole cache lifetime later. The patch touches only
 * the feeds and the notes: `generatedAt`, `durationMs`, health and counts stay
 * as they were, and a board built by another sweep is left alone.
 */
export async function collectBoard({ onLate }: CollectBoardOptions = {}): Promise<BoardSnapshot> {
  const started = Date.now();
  const [
    { collectAllServices },
    { sharedSourcePolicy },
    { startReleaseFeeds, withReleaseFeeds },
    { startMikrotikNotes, withMikrotikNotes },
  ] = await Promise.all([
    import("./sources.server"),
    import("./source-policy"),
    import("./release-feeds.server"),
    import("./mikrotik-notes.server"),
  ]);
  const services = await collectAllServices({ policy: sharedSourcePolicy });
  const durationMs = Date.now() - started;
  // Every health request has settled: only now may a feed take a connection.
  const reading = startReleaseFeeds();
  // The notes wait for the feeds to settle: a note's own 4 s timeout starts with its request, so started beside
  // six feeds on a Worker's six connections it could time out in the queue and be failure-cached.
  const notes = reading.settled.then(() => startMikrotikNotes(services));
  const inHand = reading.ready();
  const board = assembleBoard(withMikrotikNotes(withReleaseFeeds(services, inHand)), durationMs);
  const late = Promise.all([reading.settled, notes])
    .then(([, notesRead]) => {
      const now = reading.ready();
      const newFeed = [...now].some(([id, feed]) => inHand.get(id) !== feed);
      if (!newFeed && notesRead === 0) return;
      onLate?.((current) =>
        current.generatedAt === board.generatedAt
          ? { ...current, services: withMikrotikNotes(withReleaseFeeds(current.services, now)) }
          : current,
      );
    })
    // Nothing awaits this outside a Worker: a failure here must not become an unhandled rejection.
    .catch(() => {});
  findCloudflareContext()?.waitUntil(late);
  return board;
}
