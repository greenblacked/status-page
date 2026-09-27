import { beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledSweep } from "./cron-sweep";
import { readSnapshot } from "./kv-snapshot-store";
import type { SnapshotKv } from "./kv-snapshot-store";
import type { BoardSnapshot } from "./types";

vi.mock("./collect-board", () => ({
  collectBoard: vi.fn(),
}));

import { collectBoard } from "./collect-board";

function fakeKv(): SnapshotKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
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

describe("runScheduledSweep", () => {
  beforeEach(() => {
    vi.mocked(collectBoard).mockReset();
  });

  it("collects and writes a snapshot when KV is empty", async () => {
    const kv = fakeKv();
    vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:02:00.000Z"));

    await runScheduledSweep(kv, () => Date.parse("2026-09-27T00:02:00.000Z"));

    expect(collectBoard).toHaveBeenCalledTimes(1);
    await expect(readSnapshot(kv)).resolves.toEqual(board("2026-09-27T00:02:00.000Z"));
  });

  it("skips the sweep when the last snapshot is younger than the throttle window", async () => {
    const kv = fakeKv();
    await kv.put("board", JSON.stringify(board("2026-09-27T00:02:00.000Z")));

    // 10s after the last write; MIN_FORCED_REFRESH_MS is 15s.
    await runScheduledSweep(kv, () => Date.parse("2026-09-27T00:02:10.000Z"));

    expect(collectBoard).not.toHaveBeenCalled();
  });

  it("sweeps again once the throttle window has passed", async () => {
    const kv = fakeKv();
    await kv.put("board", JSON.stringify(board("2026-09-27T00:02:00.000Z")));
    vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:04:00.000Z"));

    // 2 minutes after the last write, the normal cron cadence.
    await runScheduledSweep(kv, () => Date.parse("2026-09-27T00:04:00.000Z"));

    expect(collectBoard).toHaveBeenCalledTimes(1);
    await expect(readSnapshot(kv)).resolves.toEqual(board("2026-09-27T00:04:00.000Z"));
  });
});
