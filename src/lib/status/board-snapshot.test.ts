import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardSnapshotReader } from "./board-snapshot";
import type { SnapshotKv } from "./kv-snapshot-store";
import type { BoardSnapshot } from "./types";

vi.mock("./collect-board", () => ({
  collectBoard: vi.fn(),
}));

import { collectBoard } from "./collect-board";

function fakeKv(initial?: BoardSnapshot): SnapshotKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  if (initial) store.set("board", JSON.stringify(initial));
  return {
    store,
    async get<T>(key: string): Promise<T | null> {
      const raw = store.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  };
}

function board(generatedAt: string): BoardSnapshot {
  return {
    generatedAt,
    durationMs: 10,
    services: [],
    counts: { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 },
  };
}

// Collects the promises `waitUntil` was handed, so a test can await them.
function waitUntilSpy() {
  const scheduled: Array<Promise<unknown>> = [];
  const waitUntil = vi.fn((p: Promise<unknown>) => {
    scheduled.push(p);
  });
  return { waitUntil, drain: () => Promise.all(scheduled) };
}

describe("createBoardSnapshotReader", () => {
  beforeEach(() => {
    vi.mocked(collectBoard).mockReset();
  });

  it("read() serves the stored snapshot without collecting", async () => {
    const kv = fakeKv(board("2026-09-27T00:02:00.000Z"));
    const reader = createBoardSnapshotReader(kv);
    const { waitUntil } = waitUntilSpy();

    await expect(reader.read(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
    expect(collectBoard).not.toHaveBeenCalled();
  });

  it("read() collects once and schedules the KV write in the background on a cold cache", async () => {
    const kv = fakeKv();
    vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));
    const reader = createBoardSnapshotReader(kv);
    const { waitUntil, drain } = waitUntilSpy();

    await expect(reader.read(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
    expect(collectBoard).toHaveBeenCalledTimes(1);
    // The KV write is handed to `waitUntil`, not awaited by the response.
    expect(waitUntil).toHaveBeenCalledTimes(1);

    await drain();
    expect(kv.store.get("board")).toBe(JSON.stringify(board("2026-09-27T00:02:00.000Z")));
  });

  it("read() reuses the isolate memo instead of asking KV again", async () => {
    const kv = fakeKv(board("2026-09-27T00:02:00.000Z"));
    const getSpy = vi.spyOn(kv, "get");
    const reader = createBoardSnapshotReader(kv);
    const { waitUntil } = waitUntilSpy();

    await reader.read(waitUntil);
    await reader.read(waitUntil);
    await reader.read(waitUntil);

    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("read() deduplicates concurrent cold-start collects into one", async () => {
    const kv = fakeKv();
    let resolveCollect!: (value: BoardSnapshot) => void;
    vi.mocked(collectBoard).mockReturnValue(
      new Promise((resolve) => {
        resolveCollect = resolve;
      }),
    );
    const reader = createBoardSnapshotReader(kv);
    const { waitUntil } = waitUntilSpy();

    const first = reader.read(waitUntil);
    const second = reader.read(waitUntil);
    resolveCollect(board("2026-09-27T00:02:00.000Z"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      board("2026-09-27T00:02:00.000Z"),
      board("2026-09-27T00:02:00.000Z"),
    ]);
    expect(collectBoard).toHaveBeenCalledTimes(1);
  });

  it("refresh() returns the latest KV snapshot without sweeping vendors", async () => {
    const kv = fakeKv(board("2026-09-27T00:02:00.000Z"));
    const reader = createBoardSnapshotReader(kv);
    const { waitUntil } = waitUntilSpy();

    await expect(reader.refresh(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
    expect(collectBoard).not.toHaveBeenCalled();
  });

  it("refresh() falls back to a cold-start collect when KV is still empty", async () => {
    const kv = fakeKv();
    vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));
    const reader = createBoardSnapshotReader(kv);
    const { waitUntil, drain } = waitUntilSpy();

    await expect(reader.refresh(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
    expect(collectBoard).toHaveBeenCalledTimes(1);
    await drain();
  });

  it("read() keeps serving the last board when KV fails after the memo expires", async () => {
    vi.useFakeTimers();
    try {
      const kv = fakeKv(board("2026-09-27T00:02:00.000Z"));
      const reader = createBoardSnapshotReader(kv);
      const { waitUntil } = waitUntilSpy();
      await reader.read(waitUntil);

      kv.get = () => Promise.reject(new Error("KV unavailable"));
      vi.advanceTimersByTime(10_000);

      await expect(reader.read(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
      expect(collectBoard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("read() fails when KV fails and the isolate has nothing to fall back on", async () => {
    const kv = fakeKv();
    kv.get = () => Promise.reject(new Error("KV unavailable"));
    const reader = createBoardSnapshotReader(kv);

    await expect(reader.read(waitUntilSpy().waitUntil)).rejects.toThrow("KV unavailable");
  });

  it("refresh() still works when called detached from the reader", async () => {
    const kv = fakeKv();
    vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));
    const { refresh } = createBoardSnapshotReader(kv);

    await expect(refresh(waitUntilSpy().waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
  });
});
