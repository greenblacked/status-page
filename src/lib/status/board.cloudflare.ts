import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { createBoardSnapshotReader } from "./board-snapshot";
import { getCloudflareContext } from "./cloudflare-context";
import type { BoardSnapshotReader } from "./board-snapshot";
import type { BoardSnapshot } from "./types";

// vite.config.ts aliases "@/lib/status/board" to this file only when
// DEPLOY_TARGET=cloudflare, so every route keeps importing from "board" and
// gets the KV-backed board instead of board.ts's in-memory one, with no
// changes at the call sites. See that file for why.

// One reader per isolate: the KV binding is stable for the isolate's
// lifetime, so it is captured once on first use and reused, sharing its
// isolate memo across every request this isolate serves.
let reader: BoardSnapshotReader | undefined;

function boardReader(): BoardSnapshotReader {
  reader ??= createBoardSnapshotReader(getCloudflareContext().env.STATUS_SNAPSHOT);
  return reader;
}

export const getStatusBoard = createServerOnlyFn((): Promise<BoardSnapshot> => {
  const { waitUntil } = getCloudflareContext();
  return boardReader().read(waitUntil);
});

export const fetchStatusBoard = createServerFn({ method: "GET" }).handler(async () => {
  const { waitUntil } = getCloudflareContext();
  return boardReader().read(waitUntil);
});

export const loadStatusBoardForPage = createServerFn({ method: "GET" }).handler(async () => {
  const { waitUntil } = getCloudflareContext();
  return boardReader().read(waitUntil);
});

export const refreshStatusBoard = createServerFn({ method: "POST" }).handler(async () => {
  const { waitUntil } = getCloudflareContext();
  return boardReader().refresh(waitUntil);
});

// Type-checks this file against board.ts: tsc resolves "@/lib/status/board"
// to board.ts whatever DEPLOY_TARGET is, so without this a renamed export or a
// changed signature here would only show up in a Cloudflare build.
({ getStatusBoard, fetchStatusBoard, loadStatusBoardForPage, refreshStatusBoard }) satisfies typeof import("./board");
