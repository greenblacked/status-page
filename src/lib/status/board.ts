import { createServerFn } from "@tanstack/react-start";
import { getFreshStatusBoard, getStatusBoardForPage, refreshStatusBoardNow } from "./board-cache.server";

// Thin server functions only. The cache they read is in `board-cache.server.ts`
// (see there for why it must not live in this file). Server routes import
// `getStatusBoard` from that module, not from here.

export const fetchStatusBoard = createServerFn({ method: "GET" }).handler(async () => getFreshStatusBoard());

// The route loader only: renders at once from a recently expired snapshot
// instead of blocking the first paint on a full vendor sweep.
export const loadStatusBoardForPage = createServerFn({ method: "GET" }).handler(async () => getStatusBoardForPage());

export const refreshStatusBoard = createServerFn({ method: "POST" }).handler(async () => refreshStatusBoardNow());
