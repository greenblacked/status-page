/// <reference types="@cloudflare/workers-types" />
import type { HistoryDocument } from "./history";
import { HISTORY_KEY, parseHistory, publicHistory } from "./history";
import type { BoardSnapshot } from "./types";

// A narrow view of KVNamespace's get/put, so tests can pass a plain
// in-memory object instead of the ambient Cloudflare KVNamespace type.
// The real KVNamespace satisfies this structurally.
export type SnapshotKv = {
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
};

export type CloudflareEnv = {
  STATUS_SNAPSHOT: KVNamespace;
  /** "noindex" on the staging Worker (wrangler.jsonc env.staging.vars); unset in production. */
  ROBOTS?: string;
  /**
   * The answering Worker version (wrangler.jsonc's `version_metadata`),
   * sent as X-Worker-Version. Optional so a Worker built without the
   * binding still answers, only without that header.
   */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
};

// Fixed key names only: the whole board is one JSON document, and the
// rolling uptime history is another. Cron is the only writer of both;
// requests only read.
const SNAPSHOT_KEY = "board";

function isBoardSnapshot(value: unknown): value is BoardSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BoardSnapshot>;
  return (
    typeof candidate.generatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.generatedAt)) &&
    Array.isArray(candidate.services) &&
    typeof candidate.counts === "object" &&
    candidate.counts !== null
  );
}

/**
 * The stored snapshot, or null when there is none or it cannot be used: not
 * JSON (a hand edit in the dashboard), or JSON of another shape (a format
 * change, or a rollback across one). Null makes both the cron and a cold
 * request collect again and overwrite it, so a bad value repairs itself on
 * the next tick instead of failing every request. A KV transport error still
 * throws: that is not a reason to overwrite what is stored.
 */
export async function readSnapshot(kv: SnapshotKv): Promise<BoardSnapshot | null> {
  let value: unknown;
  try {
    value = await kv.get<unknown>(SNAPSHOT_KEY, "json");
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return isBoardSnapshot(value) ? value : null;
}

/** Writes the snapshot and returns its size in bytes, for the sweep's log line. */
export async function writeSnapshot(kv: SnapshotKv, snapshot: BoardSnapshot): Promise<number> {
  const value = JSON.stringify(snapshot);
  await kv.put(SNAPSHOT_KEY, value);
  return new TextEncoder().encode(value).byteLength;
}

/**
 * The stored history document, or null when there is none or it cannot be
 * used. Same repair story as readSnapshot: a bad value becomes null so the
 * next cron merge starts fresh. KV transport errors still throw.
 */
export async function readHistory(kv: SnapshotKv): Promise<HistoryDocument | null> {
  let value: unknown;
  try {
    value = await kv.get<unknown>(HISTORY_KEY, "json");
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return parseHistory(value);
}

/**
 * Writes history:v1 after projecting through publicHistory, so KV never
 * stores fields beyond the public day shape. Returns size in bytes for the
 * sweep's console log line only (never written into the document itself).
 */
export async function writeHistory(kv: SnapshotKv, history: HistoryDocument): Promise<number> {
  const value = JSON.stringify(publicHistory(history));
  await kv.put(HISTORY_KEY, value);
  return new TextEncoder().encode(value).byteLength;
}
