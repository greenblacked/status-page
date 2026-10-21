import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRESH_WAIT_MS } from "./schedule";
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
  vi.restoreAllMocks();
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

  it("serves an expired board of any age to routes and the loader while one shared sweep runs", async () => {
    const { cache, functions } = await load();
    const first = await cache.getStatusBoard();

    // The next sweep stays pending until the test lets it finish.
    let finish: (value: BoardSnapshot) => void = () => {};
    collectBoard.mockImplementationOnce(() => new Promise<BoardSnapshot>((resolve) => (finish = resolve)));

    // Hours past the TTL (45 s): an idle isolate still answers at once.
    vi.advanceTimersByTime(3 * 60 * 60_000);
    expect(await cache.getStatusBoard()).toEqual(first);
    expect(await functions.loadStatusBoardForPage()).toEqual(first);
    expect(collectBoard).toHaveBeenCalledTimes(2);

    // The refetch prefers a fresh board, so it waits a little for that same sweep.
    const refetch = functions.fetchStatusBoard();
    const second = board(99);
    finish(second);
    expect(await refetch).toEqual(second);
    expect(collectBoard).toHaveBeenCalledTimes(2);
  });

  it("makes the refetch wait no longer than FRESH_WAIT_MS for a slow sweep", async () => {
    const { cache, functions } = await load();
    const first = await cache.getStatusBoard();
    let finish: (value: BoardSnapshot) => void = () => {};
    collectBoard.mockImplementationOnce(() => new Promise<BoardSnapshot>((resolve) => (finish = resolve)));
    vi.advanceTimersByTime(60_000);

    let answered: BoardSnapshot | undefined;
    const refetch = functions.fetchStatusBoard().then((value) => {
      answered = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(FRESH_WAIT_MS - 1);
    expect(answered).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await refetch).toEqual(first);

    // The sweep lands behind it and the next reader has it.
    const second = board(99);
    finish(second);
    await vi.waitFor(async () => expect(await cache.getStatusBoard()).toEqual(second));
    expect(collectBoard).toHaveBeenCalledTimes(2);
  });

  it("makes the readiness probe wait for a slow sweep past FRESH_WAIT_MS", async () => {
    const { cache } = await load();
    await cache.getStatusBoard();
    let finish: (value: BoardSnapshot) => void = () => {};
    collectBoard.mockImplementationOnce(() => new Promise<BoardSnapshot>((resolve) => (finish = resolve)));
    vi.advanceTimersByTime(60_000);

    const probe = cache.getStatusBoardForProbe();
    await vi.advanceTimersByTimeAsync(FRESH_WAIT_MS + 5_000);
    const second = board(99);
    finish(second);
    expect(await probe).toEqual(second);
  });

  it("logs one line per sweep, with why it ran", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { cache, functions } = await load();
    await cache.getStatusBoard();
    vi.advanceTimersByTime(20_000);
    await functions.refreshStatusBoard();

    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toEqual([
      { event: "board_collected", trigger: "cold", durationMs: 1, services: 0, unknown: 0 },
      { event: "board_collected", trigger: "force", durationMs: 2, services: 0, unknown: 0 },
    ]);
  });
});
