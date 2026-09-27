import { describe, expect, it } from "vitest";
import type { SnapshotKv } from "./kv-snapshot-store";
import { readSnapshot, writeSnapshot } from "./kv-snapshot-store";
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

  it("reads null for a value that is not JSON, so the next sweep replaces it", async () => {
    const kv = fakeKv();
    kv.store.set("board", "{not json");

    await expect(readSnapshot(kv)).resolves.toBeNull();
  });

  it("reads null for JSON of another shape, such as an older format", async () => {
    const kv = fakeKv();
    kv.store.set("board", JSON.stringify({ version: 2, data: [] }));
    await expect(readSnapshot(kv)).resolves.toBeNull();

    kv.store.set("board", JSON.stringify(board({ generatedAt: "yesterday" })));
    await expect(readSnapshot(kv)).resolves.toBeNull();
  });

  it("still throws when KV itself fails, rather than treating it as empty", async () => {
    const failing: SnapshotKv = {
      get: () => Promise.reject(new Error("KV unavailable")),
      put: () => Promise.resolve(),
    };

    await expect(readSnapshot(failing)).rejects.toThrow("KV unavailable");
  });
});
