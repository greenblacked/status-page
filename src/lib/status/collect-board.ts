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

/**
 * Sweeps every vendor once, adds the release feeds and the MikroTik changelog
 * notes that are in hand, and assembles the result into a board snapshot.
 * Shared by Node and Cloudflare Workers through the in-memory cache
 * (board.ts), so there is exactly one place that calls
 * `collectAllServices()` and exactly one that starts the release feeds (the
 * JSON API, the badges and the Refresh button all reach them through this
 * function).
 *
 * The release feeds start only after the health sweep has settled, never
 * beside it. A Worker holds at most six outgoing connections at once and
 * queues the rest, while each health request's own timeout (9 s) is already
 * running; the sweep is 20 requests, so a feed started first or alongside
 * would take slots from health and could turn a slow but working status
 * source into No data. Started afterwards, a feed can never hold a slot
 * while a health request is pending or queued, and it cannot lengthen the
 * sweep or change any result. The board is never held for them either: it
 * ends when the sweep does, with the feeds the cache already holds, and
 * `durationMs` is the sweep's. Feeds that are due are read right after, in
 * the background (`waitUntil` on Workers, which is what keeps the request
 * alive for them; elsewhere the process simply carries on), and cached for
 * the next board, so a cold board shows its release lines one refresh later.
 * The MikroTik changelogs (the notes in its Details and its summary line) are
 * read the same way, right after the sweep and in the same `waitUntil`: the
 * collector reads the version channels only, so a changelog host that is
 * slow or down changes no result and no `durationMs`.
 */
export async function collectBoard(): Promise<BoardSnapshot> {
  const started = Date.now();
  const [{ collectAllServices }, { startReleaseFeeds, withReleaseFeeds }, { startMikrotikNotes, withMikrotikNotes }] =
    await Promise.all([
      import("./sources.server"),
      import("./release-feeds.server"),
      import("./mikrotik-notes.server"),
    ]);
  const services = await collectAllServices();
  const durationMs = Date.now() - started;
  // Every health request has settled: only now may a feed take a connection.
  const reading = startReleaseFeeds();
  const notes = startMikrotikNotes(services);
  findCloudflareContext()?.waitUntil(Promise.all([reading.settled, notes]).then(() => undefined));
  return assembleBoard(withMikrotikNotes(withReleaseFeeds(services, reading.ready())), durationMs);
}
