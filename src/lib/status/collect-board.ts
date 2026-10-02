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
 * Sweeps every vendor once, adds the release feeds that are in hand, and
 * assembles the result into a board snapshot.
 * Shared by Node and Cloudflare Workers through the in-memory cache
 * (board.ts), so there is exactly one place that calls
 * `collectAllServices()`.
 *
 * The release feeds start with the sweep but are never waited for: the board
 * ends when the health sweep does, with the feeds that are cached or have
 * arrived by then, and `durationMs` is the sweep's. A feed still on its way is
 * finished in the background (`waitUntil` on Workers, which is what keeps the
 * request alive for it) and is cached for the next board, a refresh away.
 */
export async function collectBoard(): Promise<BoardSnapshot> {
  const started = Date.now();
  const [{ collectAllServices }, { startReleaseFeeds, withReleaseFeeds }] = await Promise.all([
    import("./sources.server"),
    import("./release-feeds.server"),
  ]);
  const reading = startReleaseFeeds();
  const services = await collectAllServices();
  const durationMs = Date.now() - started;
  findCloudflareContext()?.waitUntil(reading.settled);
  return assembleBoard(withReleaseFeeds(services, reading.ready()), durationMs);
}
