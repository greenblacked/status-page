import { describe, expect, it } from "vitest";
import { readSnapshot, writeSnapshot } from "./kv-snapshot-store";
import type { SnapshotKv } from "./kv-snapshot-store";
import type { BoardSnapshot } from "./types";

// A minimal in-memory stand-in for a Cloudflare KVNamespace: only the
// get/put shape SnapshotKv actually uses.
function fakeKv(): SnapshotKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get<T>(key: string, type: "json"): Promise<T | null> {
      expect(type).toBe("json");
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  };
}

function board(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    generatedAt: "2026-09-27T00:00:00.000Z",
    durationMs: 42,
    services: [],
    counts: { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 },
    ...overrides,
  };
}

describe("kv-snapshot-store", () => {
  it("reads null when nothing has been written", async () => {
    await expect(readSnapshot(fakeKv())).resolves.toBeNull();
  });

  it("round-trips a snapshot through KV as JSON", async () => {
    const kv = fakeKv();
    const snapshot = board({ durationMs: 123 });

    await writeSnapshot(kv, snapshot);

    expect(kv.store.get("board")).toBe(JSON.stringify(snapshot));
    await expect(readSnapshot(kv)).resolves.toEqual(snapshot);
  });

  it("overwrites the previous snapshot at the same key", async () => {
    const kv = fakeKv();
    await writeSnapshot(kv, board({ durationMs: 1 }));
    await writeSnapshot(kv, board({ durationMs: 2 }));

    await expect(readSnapshot(kv)).resolves.toEqual(board({ durationMs: 2 }));
    expect(kv.store.size).toBe(1);
  });
});
