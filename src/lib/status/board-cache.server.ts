import { findCloudflareContext } from "./cloudflare-context";
import { collectBoard } from "./collect-board";
import { CACHE_MAX_STALE_MS, CACHE_TTL_MS, MIN_FORCED_REFRESH_MS } from "./schedule";
import { createTtlCache } from "./ttl-cache";
import type { BoardSnapshot } from "./types";

// The one board cache of a server process (a Worker isolate). It lives in this
// module and nowhere near a `createServerFn`: TanStack Start splits every
// module that calls it into a separate server-function chunk and copies the
// module-level state along, so a cache declared beside the server functions
// is built twice and the page's server functions (loader, refetch, Refresh)
// and the server routes (the API, feed, metrics, badges) stop sharing it (up to two vendor sweeps per isolate). Everything that needs the
// board, the server functions in `board.ts` included, goes through here.
// `scripts/ci/single-board-cache.ts` fails the build if the built server
// holds more than one.
const boardCache = createTtlCache(collectBoard, CACHE_TTL_MS, {
  maxStaleMs: CACHE_MAX_STALE_MS,
  minForceIntervalMs: MIN_FORCED_REFRESH_MS,
  onBackgroundRefresh: (promise) => findCloudflareContext()?.waitUntil(promise),
});

/**
 * The board the server routes (the JSON API, the feed, metrics and the
 * badges) serve: a recently expired snapshot at once, refreshed behind it.
 * Sharing the cache is what keeps a busy badge from costing a vendor sweep
 * per request.
 */
export function getStatusBoard(): Promise<BoardSnapshot> {
  return boardCache.get({ allowStale: true });
}

/** The page's scheduled refetch: a board no older than the cache's TTL. */
export function getFreshStatusBoard(): Promise<BoardSnapshot> {
  return boardCache.get();
}

/** The route loader: renders from a recently expired snapshot, no blocking sweep. */
export function getStatusBoardForPage(): Promise<BoardSnapshot> {
  return boardCache.get({ allowStale: true });
}

/** The Refresh button: a new sweep, unless one finished just now. */
export function refreshStatusBoardNow(): Promise<BoardSnapshot> {
  return boardCache.get({ force: true });
}
