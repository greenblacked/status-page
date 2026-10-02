import type { BoardSnapshot, Health, ReleaseFeed, ServiceId, ServiceSnapshot } from "./types";

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
 * Sweeps every vendor once, adds the vendors' release feeds, and assembles the
 * result into a board snapshot.
 * Shared by Node and Cloudflare Workers through the in-memory cache
 * (board.ts), so there is exactly one place that calls
 * `collectAllServices()`.
 */
export async function collectBoard(): Promise<BoardSnapshot> {
  const started = Date.now();
  const [{ collectAllServices }, { releaseFeedsForBoard, withReleaseFeeds }] = await Promise.all([
    import("./sources.server"),
    import("./release-feeds.server"),
  ]);
  // The vendors' release feeds are read beside the health sweep and cached for half an hour per isolate; they
  // are advisory, never reject, and only ever add a card's `releaseFeed`.
  const [services, feeds] = await Promise.all([
    collectAllServices(),
    releaseFeedsForBoard().catch(() => new Map<ServiceId, ReleaseFeed>()),
  ]);
  return assembleBoard(withReleaseFeeds(services, feeds), Date.now() - started);
}
