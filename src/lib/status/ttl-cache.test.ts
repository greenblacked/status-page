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

/** A load that stays pending until the test settles it. */
function held() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createTtlCache", () => {
  it("returns a cached value until its TTL expires", async () => {
    const load = counter();
    const cache = createTtlCache(load, 45_000);

    await expect(cache.get()).resolves.toBe("load-1");
    vi.setSystemTime(44_999);
    await expect(cache.get()).resolves.toBe("load-1");
    vi.setSystemTime(45_000);
    // Past the TTL the old value comes back at once and the refresh runs behind it.
    await expect(cache.get()).resolves.toBe("load-1");
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect(await cache.get()).toBe("load-2"));
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

  it("serves a value of any age at once to a caller that allows it, and refreshes behind it", async () => {
    const load = counter();
    const cache = createTtlCache(load, 45_000);

    await cache.get();
    // Far past the TTL and past the 75 s stale window there once was.
    vi.setSystemTime(6 * 60 * 60_000);

    await expect(cache.get({ allowStale: true })).resolves.toBe("load-1");
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect(await cache.get()).toBe("load-2"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives a fresh-preferring caller the new value when the refresh lands within its wait", async () => {
    const next = held();
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockImplementationOnce(() => next.promise);
    const cache = createTtlCache(load, 45_000);

    await cache.get();
    vi.setSystemTime(60_000);
    const fresh = cache.get({ waitForFreshMs: 3_000 });
    await vi.advanceTimersByTimeAsync(2_999);
    next.resolve("new");

    await expect(fresh).resolves.toBe("new");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives a fresh-preferring caller the value in hand once its wait is up, and the refresh lands later", async () => {
    const next = held();
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockImplementationOnce(() => next.promise);
    const cache = createTtlCache(load, 45_000);

    await cache.get();
    vi.setSystemTime(60_000);
    let settled: string | undefined;
    const fresh = cache.get({ waitForFreshMs: 3_000 }).then((value) => {
      settled = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(fresh).resolves.toBe("old");

    next.resolve("new");
    await vi.waitFor(async () => expect(await cache.get()).toBe("new"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives a fresh-preferring caller the value in hand at once when the refresh fails", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockRejectedValueOnce(new Error("vendor down"));
    const cache = createTtlCache(load, 45_000);

    await cache.get();
    vi.setSystemTime(60_000);

    await expect(cache.get({ waitForFreshMs: 3_000 })).resolves.toBe("old");
  });

  it("propagates a failed cold load, and the next caller loads again", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("vendor down")).mockResolvedValue("board");
    const cache = createTtlCache(load, 45_000);

    await expect(cache.get()).rejects.toThrow("vendor down");
    await expect(cache.get()).resolves.toBe("board");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the last value when a background refresh fails, and refreshes again after it", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("good")
      .mockRejectedValueOnce(new Error("vendor down"))
      .mockResolvedValue("later");
    const cache = createTtlCache(load, 45_000);

    await cache.get();
    vi.setSystemTime(60_000);

    await expect(cache.get({ allowStale: true })).resolves.toBe("good");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    // The failed refresh did not wedge the cache: the next caller gets the old value and starts another one.
    await vi.waitFor(async () => expect(await cache.get({ allowStale: true })).toBe("later"));
  });

  it("registers every load, cold, stale and forced, so a Worker can keep it alive after the response", async () => {
    const onBackgroundRefresh = vi.fn();
    const cache = createTtlCache(counter(), 45_000, { onBackgroundRefresh });

    await cache.get();
    expect(onBackgroundRefresh).toHaveBeenCalledTimes(1);
    vi.setSystemTime(60_000);
    await cache.get({ allowStale: true });
    expect(onBackgroundRefresh).toHaveBeenCalledTimes(2);
    await onBackgroundRefresh.mock.calls[1][0];
    await cache.get({ force: true });
    expect(onBackgroundRefresh).toHaveBeenCalledTimes(3);
    // A caller that joins a load in flight registers nothing new.
    vi.setSystemTime(120_000);
    await Promise.all([cache.get({ allowStale: true }), cache.get({ allowStale: true })]);
    expect(onBackgroundRefresh).toHaveBeenCalledTimes(4);
  });

  it("hands the Worker a load that never rejects, even when the load fails", async () => {
    const onBackgroundRefresh = vi.fn();
    const cache = createTtlCache(vi.fn().mockRejectedValue(new Error("vendor down")), 45_000, { onBackgroundRefresh });

    await expect(cache.get()).rejects.toThrow("vendor down");
    await expect(onBackgroundRefresh.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it("registers a background refresh and keeps serving the old value until it lands", async () => {
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
    const cache = createTtlCache(load, 45_000, { onBackgroundRefresh });

    await cache.get();
    vi.setSystemTime(60_000);
    await expect(cache.get({ allowStale: true })).resolves.toBe("old");
    expect(onBackgroundRefresh).toHaveBeenCalledTimes(2);
    resolve("new");
    await onBackgroundRefresh.mock.calls[1][0];
    await expect(cache.get()).resolves.toBe("new");
  });

  it("tells the load why it runs: cold, stale or forced", async () => {
    const load = vi.fn(async (_trigger: string) => "board");
    const cache = createTtlCache(load, 45_000);

    await cache.get();
    vi.setSystemTime(60_000);
    await cache.get({ allowStale: true });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await cache.get({ force: true });

    expect(load.mock.calls.map(([trigger]) => trigger)).toEqual(["cold", "stale", "force"]);
  });
});
