import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { board, service } from "../../test/fixtures.ts";
import { __resetBoardStoreForTests, cloudflareBoardStore } from "./board-store.ts";
import { type CloudflareRequestContext, runWithCloudflareContext } from "./cloudflare-context.ts";
import { SHARED_SNAPSHOT_MAX_AGE_S } from "./schedule.ts";

const ORIGIN = "https://status.example.com";
const VERSION = "0f6b5b4e-2d0c-4d38-9a6b-3c4f1e2a7b90";
const KEY = `${ORIGIN}/__status-board/snapshot?v=${VERSION}`;

/** The Workers Cache API's `caches.default`, in memory, recording each key it is asked for. */
function edgeCache() {
  const stored = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (request: Request) => stored.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      stored.set(request.url, response.clone());
    }),
  };
  vi.stubGlobal("caches", { default: cache });
  return { cache, stored };
}

/** Runs `fn` as a Worker request would, collecting what it hands to waitUntil. */
function inWorker<T>(fn: () => T, overrides: Partial<CloudflareRequestContext> = {}) {
  const waiting: Promise<unknown>[] = [];
  const context: CloudflareRequestContext = {
    env: { CF_VERSION_METADATA: { id: VERSION } },
    waitUntil: (promise) => waiting.push(promise),
    origin: ORIGIN,
    ...overrides,
  };
  return { result: runWithCloudflareContext(context, fn), settled: () => Promise.all(waiting) };
}

const snapshot = board([service("claude", { health: "degraded" })], { generatedAt: "2026-10-04T12:00:00.000Z" });

beforeEach(() => {
  __resetBoardStoreForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetBoardStoreForTests();
});

describe("cloudflareBoardStore", () => {
  it("is absent outside a Worker request, without a version id, an origin or the Cache API", () => {
    edgeCache();
    expect(cloudflareBoardStore()).toBeUndefined();
    expect(inWorker(cloudflareBoardStore, { env: {} }).result).toBeUndefined();
    expect(inWorker(cloudflareBoardStore, { origin: undefined }).result).toBeUndefined();
    expect(inWorker(cloudflareBoardStore).result).toBeDefined();

    vi.unstubAllGlobals();
    expect(inWorker(cloudflareBoardStore).result).toBeUndefined();
    vi.stubGlobal("caches", {});
    expect(inWorker(cloudflareBoardStore).result).toBeUndefined();
  });

  it("writes and reads the snapshot under a key of the origin and the Worker version", async () => {
    const { cache, stored } = edgeCache();
    const write = inWorker(() => cloudflareBoardStore()?.write({ at: 1_700_000_000_000, value: snapshot }));
    await write.settled();

    expect([...stored.keys()]).toEqual([KEY]);
    const [request, response] = cache.put.mock.calls[0];
    expect(request.method).toBe("GET");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe(`public, max-age=${SHARED_SNAPSHOT_MAX_AGE_S}`);
    expect(response.headers.get("X-Board-Collected-At")).toBe("1700000000000");

    const read = await inWorker(() => cloudflareBoardStore()?.read()).result;
    expect(read).toEqual({ at: 1_700_000_000_000, value: snapshot });
    expect(cache.match.mock.calls[0][0].url).toBe(KEY);
  });

  it("keeps the snapshots of different versions and origins apart", async () => {
    const { stored } = edgeCache();
    await inWorker(() => cloudflareBoardStore()?.write({ at: 1, value: snapshot })).settled();
    await inWorker(() => cloudflareBoardStore()?.write({ at: 2, value: snapshot }), {
      env: { CF_VERSION_METADATA: { id: "next version" } },
    }).settled();
    await inWorker(() => cloudflareBoardStore()?.write({ at: 3, value: snapshot }), {
      origin: "https://stage.example.com",
    }).settled();

    expect([...stored.keys()].sort()).toEqual(
      [
        KEY,
        `${ORIGIN}/__status-board/snapshot?v=next%20version`,
        `https://stage.example.com/__status-board/snapshot?v=${VERSION}`,
      ].sort(),
    );
  });

  it("reads nothing there, a body that is not a board, or a missing collection time as a miss", async () => {
    const { stored } = edgeCache();
    const read = () => inWorker(() => cloudflareBoardStore()?.read()).result;
    await expect(read()).resolves.toBeUndefined();

    const entry = (body: string, at: string | null = "1") =>
      new Response(body, { headers: at === null ? {} : { "X-Board-Collected-At": at } });
    for (const response of [
      entry("not json"),
      entry("null"),
      entry(JSON.stringify({ generatedAt: 1, services: [], counts: {} })),
      entry(JSON.stringify({ generatedAt: "x", services: {}, counts: {} })),
      entry(JSON.stringify({ generatedAt: "x", services: [], counts: null })),
      entry(JSON.stringify(snapshot), null),
      entry(JSON.stringify(snapshot), "soon"),
    ]) {
      stored.set(KEY, response);
      await expect(read()).resolves.toBeUndefined();
    }
    // None of these is a failure of the Cache API: the store stays on.
    expect(inWorker(cloudflareBoardStore).result).toBeDefined();
  });

  it("turns itself off for the isolate at the first Cache API failure, and says so once", async () => {
    const { cache } = edgeCache();
    cache.match.mockRejectedValueOnce(new Error("cache unavailable"));

    await expect(inWorker(() => cloudflareBoardStore()?.read()).result).resolves.toBeUndefined();
    expect(inWorker(cloudflareBoardStore).result).toBeUndefined();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(console.warn).mock.calls[0][0]))).toEqual({
      event: "board_store_disabled",
      message: "cache unavailable",
    });
  });

  it("turns itself off when a write is refused, synchronously or not", async () => {
    const { cache } = edgeCache();
    cache.put.mockRejectedValueOnce(new Error("put refused"));
    await inWorker(() => cloudflareBoardStore()?.write({ at: 1, value: snapshot })).settled();
    expect(inWorker(cloudflareBoardStore).result).toBeUndefined();

    __resetBoardStoreForTests();
    cache.put.mockImplementationOnce(() => {
      throw new Error("put threw");
    });
    expect(() => inWorker(() => cloudflareBoardStore()?.write({ at: 1, value: snapshot }))).not.toThrow();
    expect(inWorker(cloudflareBoardStore).result).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
