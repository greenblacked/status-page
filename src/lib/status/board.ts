import { createServerFn } from "@tanstack/react-start";
import { getFreshStatusBoard, getStatusBoardForPage, refreshStatusBoardNow } from "./board-cache.server";

// Thin server functions only. The cache they read is in `board-cache.server.ts`
// (see there for why it must not live in this file). Server routes import
// `getStatusBoard` from that module, not from here.

// The page's scheduled refetch: it waits at most FRESH_WAIT_MS (schedule.ts)
// for a refresh of an expired snapshot, then takes the snapshot in hand.
export const fetchStatusBoard = createServerFn({ method: "GET" }).handler(async () => getFreshStatusBoard());

// The route loader only: renders at once from the snapshot in hand, however
// old, instead of blocking the first paint on a full vendor sweep.
export const loadStatusBoardForPage = createServerFn({ method: "GET" }).handler(async () => getStatusBoardForPage());

export const refreshStatusBoard = createServerFn({ method: "POST" }).handler(async () => refreshStatusBoardNow());
