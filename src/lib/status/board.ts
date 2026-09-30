import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { findCloudflareContext } from "./cloudflare-context";
import { collectBoard } from "./collect-board";
import { CACHE_MAX_STALE_MS, CACHE_TTL_MS, MIN_FORCED_REFRESH_MS } from "./schedule";
import { createTtlCache } from "./ttl-cache";
import type { BoardSnapshot } from "./types";

const boardCache = createTtlCache(collectBoard, CACHE_TTL_MS, {
  maxStaleMs: CACHE_MAX_STALE_MS,
  minForceIntervalMs: MIN_FORCED_REFRESH_MS,
  onBackgroundRefresh: (promise) => findCloudflareContext()?.waitUntil(promise),
});

/**
 * The same cached board the page reads, for server routes (the JSON API, the
 * feed and the badges). Sharing the cache is what keeps a busy badge from
 * costing a vendor sweep per request. Server-only, so the client bundle
 * drops the cache and the collectors it would otherwise pull in.
 */
export const getStatusBoard = createServerOnlyFn((): Promise<BoardSnapshot> => boardCache.get({ allowStale: true }));

/**
 * A board no older than the cache TTL, never a stale one: the history cron
 * samples it. Server-only for the same reason as getStatusBoard.
 */
export const getFreshStatusBoard = createServerOnlyFn((): Promise<BoardSnapshot> => boardCache.get());

export const fetchStatusBoard = createServerFn({ method: "GET" }).handler(async () => {
  return boardCache.get();
});

// The route loader only: renders at once from a recently expired snapshot
// instead of blocking the first paint on a full vendor sweep.
export const loadStatusBoardForPage = createServerFn({ method: "GET" }).handler(async () => {
  return boardCache.get({ allowStale: true });
});

export const refreshStatusBoard = createServerFn({ method: "POST" }).handler(async () => {
  return boardCache.get({ force: true });
});
