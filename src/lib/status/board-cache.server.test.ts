import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "./types";

const collectBoard = vi.hoisted(() => vi.fn());
vi.mock("./collect-board", () => ({ collectBoard }));
// A server function needs Start's request context to run. Its handler is all
// these tests are about, so let `createServerFn(...).handler(fn)` be `fn`.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ handler: (fn: () => unknown) => fn }),
}));

function board(n: number): BoardSnapshot {
  return {
    generatedAt: new Date(Date.now()).toISOString(),
    durationMs: n,
    services: [],
    counts: { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 },
  };
}

// The cache is module state: load a fresh copy of the modules per test so one
// test's cached board cannot satisfy another's.
async function load() {
  vi.resetModules();
  const cache = await import("./board-cache.server");
  const functions = await import("./board");
  return { cache, functions };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
  let calls = 0;
  collectBoard.mockReset();
  collectBoard.mockImplementation(async () => board(++calls));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the board cache", () => {
  it("serves the server routes and every page server function from one sweep", async () => {
    const { cache, functions } = await load();

    const fromRoute = await cache.getStatusBoard();
    const fromLoader = await functions.loadStatusBoardForPage();
    const fromRefetch = await functions.fetchStatusBoard();

    expect(collectBoard).toHaveBeenCalledTimes(1);
    expect(fromLoader).toEqual(fromRoute);
    expect(fromRefetch).toEqual(fromRoute);
  });

  it("lets the page's first render warm the cache for the API", async () => {
    const { cache, functions } = await load();

    await functions.loadStatusBoardForPage();
    await cache.getStatusBoard();

    expect(collectBoard).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight sweep between concurrent callers", async () => {
    const { cache, functions } = await load();

    const results = await Promise.all([
      cache.getStatusBoard(),
      functions.fetchStatusBoard(),
      functions.loadStatusBoardForPage(),
    ]);

    expect(collectBoard).toHaveBeenCalledTimes(1);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("makes the Refresh button start a new sweep that every reader then sees", async () => {
    const { cache, functions } = await load();
    await cache.getStatusBoard();

    // Past the minimum interval between forced refreshes.
    vi.advanceTimersByTime(20_000);
    const refreshed = await functions.refreshStatusBoard();

    expect(collectBoard).toHaveBeenCalledTimes(2);
    expect(await cache.getStatusBoard()).toEqual(refreshed);
    expect(await functions.fetchStatusBoard()).toEqual(refreshed);
    expect(collectBoard).toHaveBeenCalledTimes(2);
  });

  it("answers a forced refresh within the minimum interval from the cache", async () => {
    const { functions } = await load();
    await functions.fetchStatusBoard();

    vi.advanceTimersByTime(1_000);
    await functions.refreshStatusBoard();

    expect(collectBoard).toHaveBeenCalledTimes(1);
  });

  it("serves a recently expired board to routes and the loader while one shared sweep runs, but not to the refetch", async () => {
    const { cache, functions } = await load();
    const first = await cache.getStatusBoard();

    // The next sweep stays pending until the test lets it finish.
    let finish: (value: BoardSnapshot) => void = () => {};
    collectBoard.mockImplementationOnce(() => new Promise<BoardSnapshot>((resolve) => (finish = resolve)));

    // Past the TTL (45 s), inside the stale window.
    vi.advanceTimersByTime(50_000);
    expect(await cache.getStatusBoard()).toEqual(first);
    expect(await functions.loadStatusBoardForPage()).toEqual(first);
    expect(collectBoard).toHaveBeenCalledTimes(2);

    // The refetch wants a fresh board, so it waits for that same sweep.
    const refetch = functions.fetchStatusBoard();
    const second = board(99);
    finish(second);
    expect(await refetch).toEqual(second);
    expect(collectBoard).toHaveBeenCalledTimes(2);
  });
});
