import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtlCache } from "./ttl-cache";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

function counter() {
  let n = 0;
  return vi.fn(async () => `load-${++n}`);
}

describe("createTtlCache", () => {
  it("returns a cached value until its TTL expires", async () => {
    const load = counter();
    const cache = createTtlCache(load, 45_000);

    await expect(cache.get()).resolves.toBe("load-1");
    vi.setSystemTime(44_999);
    await expect(cache.get()).resolves.toBe("load-1");
    vi.setSystemTime(45_000);
    await expect(cache.get()).resolves.toBe("load-2");

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("deduplicates overlapping cached and forced refreshes", async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const cache = createTtlCache(load, 45_000);

    const first = cache.get();
    const forced = cache.get({ force: true });
    resolve("board");

    await expect(Promise.all([first, forced])).resolves.toEqual(["board", "board"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores a forced refresh that comes too soon after the last load", async () => {
    const load = counter();
    const cache = createTtlCache(load, 45_000, { minForceIntervalMs: 15_000 });

    await cache.get();
    vi.setSystemTime(14_999);
    await expect(cache.get({ force: true })).resolves.toBe("load-1");
    vi.setSystemTime(15_000);
    await expect(cache.get({ force: true })).resolves.toBe("load-2");

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("serves a stale value at once only to callers that allow it, and refreshes behind it", async () => {
    const load = counter();
    const cache = createTtlCache(load, 45_000, { maxStaleMs: 75_000 });

    await cache.get();
    vi.setSystemTime(60_000);

    await expect(cache.get({ allowStale: true })).resolves.toBe("load-1");
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect(await cache.get()).toBe("load-2"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("registers background refreshes so a Worker can keep them alive after the response", async () => {
    let resolve!: (value: string) => void;
    const load = vi
      .fn()
      .mockResolvedValueOnce("old")
      .mockImplementationOnce(
        () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      );
    const onBackgroundRefresh = vi.fn();
    const cache = createTtlCache(load, 45_000, { maxStaleMs: 75_000, onBackgroundRefresh });

    await cache.get();
    vi.setSystemTime(60_000);
    await expect(cache.get({ allowStale: true })).resolves.toBe("old");
    expect(onBackgroundRefresh).toHaveBeenCalledOnce();
    resolve("new");
    await onBackgroundRefresh.mock.calls[0][0];
    await expect(cache.get()).resolves.toBe("new");
  });

  it("waits for a fresh value once the stale window has passed", async () => {
    const load = counter();
    const cache = createTtlCache(load, 45_000, { maxStaleMs: 75_000 });

    await cache.get();
    vi.setSystemTime(120_000);

    await expect(cache.get({ allowStale: true })).resolves.toBe("load-2");
  });

  it("keeps the last value when a background refresh fails", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("vendor down"))
      .mockResolvedValue("later");
    const cache = createTtlCache(load, 45_000, { maxStaleMs: 75_000 });

    await cache.get();
    vi.setSystemTime(60_000);

    await expect(cache.get({ allowStale: true })).resolves.toBe("good");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await expect(cache.get({ allowStale: true })).resolves.toBe("good");
  });
});
