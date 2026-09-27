/// <reference types="@cloudflare/workers-types" />
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
};

// One key: the whole board is small (a few hundred services at most) and is
// always read and written as a single JSON document.
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

export async function writeSnapshot(kv: SnapshotKv, snapshot: BoardSnapshot): Promise<void> {
  await kv.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
}
