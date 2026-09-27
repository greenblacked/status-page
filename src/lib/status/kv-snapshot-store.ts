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

export async function readSnapshot(kv: SnapshotKv): Promise<BoardSnapshot | null> {
  return kv.get<BoardSnapshot>(SNAPSHOT_KEY, "json");
}

export async function writeSnapshot(kv: SnapshotKv, snapshot: BoardSnapshot): Promise<void> {
  await kv.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
}
