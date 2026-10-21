/** Why a load runs: nothing was cached, the value had expired, or a caller forced it. */
export type LoadTrigger = "cold" | "stale" | "force";

type TtlCacheOptions = {
  // A forced refresh within this long of the last load returns that load
  // instead of starting another one, so a scripted Refresh button cannot turn
  // into one vendor sweep per click.
  minForceIntervalMs?: number;
  // Keep a background refresh alive after a Worker response is sent.
  onBackgroundRefresh?: (promise: Promise<unknown>) => void;
};

type GetOptions = {
  force?: boolean;
  // Take an expired value at once, whatever its age, while the refresh runs behind it.
  allowStale?: boolean;
  // Otherwise, wait at most this long for the refresh of an expired value, then take the value in hand.
  waitForFreshMs?: number;
};

/**
 * A single-flight cache of one value. Once there is a value, no caller is
 * ever made to wait for a whole load: an expired value is served while one
 * refresh runs behind it (a caller may wait a bounded `waitForFreshMs` for
 * that refresh). Only the very first load, with nothing in hand, and a
 * forced refresh are waited for. A failed load keeps the value there was,
 * and the next caller past the TTL starts another.
 */
export function createTtlCache<T>(
  load: (trigger: LoadTrigger) => Promise<T>,
  ttlMs: number,
  { minForceIntervalMs = 0, onBackgroundRefresh }: TtlCacheOptions = {},
) {
  let cached: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;

  function refresh(trigger: LoadTrigger): Promise<T> {
    if (inflight) return inflight;

    inflight = load(trigger)
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  }

  async function get({ force = false, allowStale = false, waitForFreshMs = 0 }: GetOptions = {}): Promise<T> {
    if (!cached) return refresh("cold");

    const age = Date.now() - cached.at;
    if (force) return age < minForceIntervalMs ? cached.value : refresh("force");
    if (age < ttlMs) return cached.value;

    const stale = cached.value;
    // A failed background refresh keeps the old value; the next caller past
    // the TTL starts another.
    const next = refresh("stale");
    const background = next.catch(() => {});
    onBackgroundRefresh?.(background);
    if (allowStale || waitForFreshMs <= 0) return stale;
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(stale), waitForFreshMs);
      next.then(resolve, () => resolve(stale)).finally(() => clearTimeout(timer));
    });
  }

  return { get };
}
