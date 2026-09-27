import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  describe("when KV itself fails", () => {
    // Boards below are stamped 00:02:00, one minute before this.
    const NOW = new Date("2026-09-27T00:03:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers({ now: NOW });
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function kvFailures(): Array<{ event: string; message: string }> {
      return vi.mocked(console.warn).mock.calls.map((call) => JSON.parse(String(call[0])));
    }

    it("read() on a cold isolate collects the board, logs kv_read_failed, and never writes to KV", async () => {
      const kv = fakeKv();
      kv.get = () => Promise.reject(new Error("KV unavailable"));
      const putSpy = vi.spyOn(kv, "put");
      vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));
      const reader = createBoardSnapshotReader(kv);
      const { waitUntil } = waitUntilSpy();

      await expect(reader.read(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
      expect(collectBoard).toHaveBeenCalledTimes(1);
      expect(waitUntil).not.toHaveBeenCalled();
      expect(putSpy).not.toHaveBeenCalled();
      expect(kvFailures()).toEqual([{ event: "kv_read_failed", message: "KV unavailable" }]);
    });

    it("read() serves the outage board for a minute, then asks KV again and keeps it while it is fresh", async () => {
      const kv = fakeKv();
      const getSpy = vi.fn(() => Promise.reject(new Error("KV unavailable")));
      kv.get = getSpy;
      vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));
      const reader = createBoardSnapshotReader(kv);
      const { waitUntil } = waitUntilSpy();

      await reader.read(waitUntil);
      vi.advanceTimersByTime(59_000);
      await reader.read(waitUntil);
      expect(getSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      await expect(reader.read(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
      expect(getSpy).toHaveBeenCalledTimes(2);
      // Two minutes old: kept, not swept again.
      expect(collectBoard).toHaveBeenCalledTimes(1);
    });

    it("read() on a warm isolate keeps its fresh board: no collect, no KV write", async () => {
      const kv = fakeKv(board("2026-09-27T00:02:00.000Z"));
      const putSpy = vi.spyOn(kv, "put");
      const reader = createBoardSnapshotReader(kv);
      const { waitUntil } = waitUntilSpy();
      await reader.read(waitUntil);

      const getSpy = vi.fn(() => Promise.reject(new Error("KV unavailable")));
      kv.get = getSpy;
      vi.advanceTimersByTime(10_000);

      await expect(reader.read(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
      expect(collectBoard).not.toHaveBeenCalled();
      expect(putSpy).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
      expect(kvFailures()).toEqual([{ event: "kv_read_failed", message: "KV unavailable" }]);

      // Held for the outage memo, not re-read every five seconds.
      vi.advanceTimersByTime(59_000);
      await reader.read(waitUntil);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it("read() on a warm isolate collects once, for every waiting request, when its board is too old to keep", async () => {
      // 9.5 minutes old: still ready, but it would go stale within the
      // outage memo, so it is not kept.
      vi.setSystemTime(new Date("2026-09-27T00:11:30.000Z"));
      const kv = fakeKv(board("2026-09-27T00:02:00.000Z"));
      const putSpy = vi.spyOn(kv, "put");
      const reader = createBoardSnapshotReader(kv);
      const { waitUntil } = waitUntilSpy();
      await reader.read(waitUntil);

      kv.get = () => Promise.reject(new Error("KV unavailable"));
      let resolveCollect!: (value: BoardSnapshot) => void;
      vi.mocked(collectBoard).mockReturnValue(
        new Promise((resolve) => {
          resolveCollect = resolve;
        }),
      );
      vi.advanceTimersByTime(10_000);

      const reads = [reader.read(waitUntil), reader.read(waitUntil), reader.read(waitUntil)];
      // Let the rejected KV read settle so the collect has started.
      await Promise.resolve();
      await Promise.resolve();
      resolveCollect(board("2026-09-27T00:11:40.000Z"));

      await expect(Promise.all(reads)).resolves.toEqual([
        board("2026-09-27T00:11:40.000Z"),
        board("2026-09-27T00:11:40.000Z"),
        board("2026-09-27T00:11:40.000Z"),
      ]);
      expect(collectBoard).toHaveBeenCalledTimes(1);
      expect(putSpy).not.toHaveBeenCalled();
    });

    it("read() goes back to KV once it answers again", async () => {
      const kv = fakeKv(board("2026-09-27T00:04:00.000Z"));
      const get = kv.get.bind(kv);
      kv.get = () => Promise.reject(new Error("KV unavailable"));
      vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));
      const reader = createBoardSnapshotReader(kv);
      const { waitUntil } = waitUntilSpy();

      await expect(reader.read(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
      kv.get = get;
      vi.advanceTimersByTime(61_000);
      await expect(reader.read(waitUntil)).resolves.toEqual(board("2026-09-27T00:04:00.000Z"));
      expect(collectBoard).toHaveBeenCalledTimes(1);
    });

    it("read() deduplicates concurrent outage collects into one", async () => {
      const kv = fakeKv();
      kv.get = () => Promise.reject(new Error("KV unavailable"));
      let resolveCollect!: (value: BoardSnapshot) => void;
      vi.mocked(collectBoard).mockReturnValue(
        new Promise((resolve) => {
          resolveCollect = resolve;
        }),
      );
      const reader = createBoardSnapshotReader(kv);
      const { waitUntil } = waitUntilSpy();

      const reads = [reader.read(waitUntil), reader.read(waitUntil), reader.read(waitUntil)];
      // Let the rejected KV read settle so the collect has started.
      await Promise.resolve();
      await Promise.resolve();
      resolveCollect(board("2026-09-27T00:02:00.000Z"));

      await expect(Promise.all(reads)).resolves.toHaveLength(3);
      expect(collectBoard).toHaveBeenCalledTimes(1);
    });

    it("read() fails only when KV and the collect both fail and nothing was shown yet", async () => {
      const kv = fakeKv();
      kv.get = () => Promise.reject(new Error("KV unavailable"));
      vi.mocked(collectBoard).mockRejectedValue(new Error("collect failed"));
      const reader = createBoardSnapshotReader(kv);

      await expect(reader.read(waitUntilSpy().waitUntil)).rejects.toThrow("collect failed");
    });

    it("refresh() serves the outage board instead of failing the click", async () => {
      const kv = fakeKv();
      kv.get = () => Promise.reject(new Error("KV unavailable"));
      vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));
      const reader = createBoardSnapshotReader(kv);
      const { waitUntil } = waitUntilSpy();

      await expect(reader.refresh(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
      await expect(reader.refresh(waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
      expect(collectBoard).toHaveBeenCalledTimes(1);
      expect(waitUntil).not.toHaveBeenCalled();
    });
  });

  it("refresh() still works when called detached from the reader", async () => {
    const kv = fakeKv();
    vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));
    const { refresh } = createBoardSnapshotReader(kv);

    await expect(refresh(waitUntilSpy().waitUntil)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
  });
});
