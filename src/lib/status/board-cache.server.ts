import { cloudflareBoardStore } from "./board-store";
import { findCloudflareContext } from "./cloudflare-context";
import { collectBoard } from "./collect-board";
import { CACHE_TTL_MS, FRESH_WAIT_MS, MIN_FORCED_REFRESH_MS, PROBE_WAIT_MS } from "./schedule";
import { createTtlCache, type LoadTrigger } from "./ttl-cache";
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
//
// Once the isolate holds any snapshot, nobody waits for a sweep: every reader
// gets the snapshot in hand at once and an expired one is refreshed behind it
// (the page's scheduled refetch waits at most FRESH_WAIT_MS for that refresh,
// the readiness probe PROBE_WAIT_MS). Only the first board of a cold isolate
// and the Refresh button wait for a sweep.
//
// On Workers the isolates of a data center share their newest snapshot
// through the Cache API (board-store.ts): a cold isolate starts from it, and
// an isolate whose snapshot has expired adopts a fresher one a peer wrote
// instead of sweeping again. So only a data center with no snapshot at all
// waits for a sweep. The Node server has no such level and keeps its own.
const boardCache = createTtlCache(loadBoard, CACHE_TTL_MS, {
  minForceIntervalMs: MIN_FORCED_REFRESH_MS,
  onBackgroundRefresh: (promise) => findCloudflareContext()?.waitUntil(promise),
  shared: cloudflareBoardStore,
  onSharedHit: (entry) => console.log(JSON.stringify({ event: "board_shared_hit", ageMs: Date.now() - entry.at })),
});

async function loadBoard(trigger: LoadTrigger): Promise<BoardSnapshot> {
  const board = await collectBoard();
  console.log(
    JSON.stringify({
      event: "board_collected",
      trigger,
      durationMs: board.durationMs,
      services: board.services.length,
      unknown: board.counts.unknown,
    }),
  );
  return board;
}

/**
 * The board the server routes (the JSON API, the feed, metrics and the
 * badges) serve: the snapshot in hand at once, refreshed behind it when it
 * has expired. Sharing the cache is what keeps a busy badge from costing a
 * vendor sweep per request.
 */
export function getStatusBoard(): Promise<BoardSnapshot> {
  return boardCache.get({ allowStale: true });
}

/**
 * The page's scheduled refetch: a board no older than the cache's TTL when a
 * refresh lands within FRESH_WAIT_MS, otherwise the snapshot in hand.
 */
export function getFreshStatusBoard(): Promise<BoardSnapshot> {
  return boardCache.get({ waitForFreshMs: FRESH_WAIT_MS });
}

/** The route loader: renders from the snapshot in hand, never a blocking sweep once there is one. */
export function getStatusBoardForPage(): Promise<BoardSnapshot> {
  return boardCache.get({ allowStale: true });
}

/** The Refresh button: a new sweep, unless one finished just now. */
export function refreshStatusBoardNow(): Promise<BoardSnapshot> {
  return boardCache.get({ force: true });
}

/** The readiness probe: like the refetch, but it waits up to PROBE_WAIT_MS for a refresh of an expired board. */
export function getStatusBoardForProbe(): Promise<BoardSnapshot> {
  return boardCache.get({ waitForFreshMs: PROBE_WAIT_MS });
}
