import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The JSON lines runScheduledSweep logs, parsed, so a test can assert on
// the fields a log query would filter by.
function loggedEvents(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

describe("runScheduledSweep", () => {
  beforeEach(() => {
    vi.mocked(collectBoard).mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("replaces a stored value it cannot read instead of failing on it forever", async () => {
    const kv = fakeKv();
    kv.store.set("board", "{not json");
    vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:04:00.000Z"));

    await runScheduledSweep(kv, () => Date.parse("2026-09-27T00:04:00.000Z"));

    expect(collectBoard).toHaveBeenCalledTimes(1);
    await expect(readSnapshot(kv)).resolves.toEqual(board("2026-09-27T00:04:00.000Z"));
  });

  it("logs one sweep_completed line with the board's size and unknown count", async () => {
    const kv = fakeKv();
    const collected = {
      ...board("2026-09-27T00:02:00.000Z"),
      services: [{} as BoardSnapshot["services"][number], {} as BoardSnapshot["services"][number]],
      counts: { operational: 1, degraded: 0, outage: 0, maintenance: 0, unknown: 1 },
    };
    vi.mocked(collectBoard).mockResolvedValue(collected);

    await runScheduledSweep(kv, () => Date.parse("2026-09-27T00:02:00.000Z"));

    expect(loggedEvents(vi.mocked(console.log))).toEqual([
      {
        event: "sweep_completed",
        durationMs: 0,
        services: 2,
        unknown: 1,
        bytes: new TextEncoder().encode(JSON.stringify(collected)).byteLength,
        skipped: false,
      },
    ]);
  });

  it("logs a skipped sweep as completed with skipped: true", async () => {
    const kv = fakeKv();
    await kv.put("board", JSON.stringify(board("2026-09-27T00:02:00.000Z")));

    await runScheduledSweep(kv, () => Date.parse("2026-09-27T00:02:10.000Z"));

    expect(loggedEvents(vi.mocked(console.log))).toEqual([
      { event: "sweep_completed", durationMs: 0, services: 0, unknown: 0, bytes: 0, skipped: true },
    ]);
  });

  it("logs sweep_failed and rethrows, so the cron run shows as failed", async () => {
    const kv = fakeKv();
    kv.put = () => Promise.reject(new Error("KV write limit exceeded"));
    vi.mocked(collectBoard).mockResolvedValue(board("2026-09-27T00:04:00.000Z"));

    await expect(runScheduledSweep(kv, () => Date.parse("2026-09-27T00:04:00.000Z"))).rejects.toThrow(
      "KV write limit exceeded",
    );
    expect(loggedEvents(vi.mocked(console.error))).toEqual([
      { event: "sweep_failed", message: "KV write limit exceeded" },
    ]);
    expect(console.log).not.toHaveBeenCalled();
  });
});
