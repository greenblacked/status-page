/** Why a load runs: nothing was cached, the value had expired, or a caller forced it. */
export type LoadTrigger = "cold" | "stale" | "force";

/** A value and when it was loaded (`Date.now()` in ms). */
export type Entry<T> = { at: number; value: T };

/**
 * A second level the cache shares with its peers (the other isolates of a data
 * center): read on a cold start and before a refresh of an expired value,
 * written after every load. A read may throw or reject; that is a miss.
 */
export type SharedStore<T> = {
  read(): Promise<Entry<T> | undefined>;
  write(entry: Entry<T>): void;
};

type TtlCacheOptions<T> = {
  // A forced refresh within this long of the last load returns that load
  // instead of starting another one, so a scripted Refresh button cannot turn
  // into one vendor sweep per click.
  minForceIntervalMs?: number;
  // Keep every load alive after the Worker response that began it is sent.
  // It is handed a promise that never rejects.
  onBackgroundRefresh?: (promise: Promise<unknown>) => void;
  // The shared store for this call, or none. A getter, resolved per call:
  // what it needs (a Worker's request context) belongs to one request.
  shared?: () => SharedStore<T> | undefined;
  // Told when a peer's entry is adopted in place of a load.
  onSharedHit?: (entry: Entry<T>) => void;
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
 * that refresh). Only the very first load, with nothing in hand here or in
 * the shared store, and a forced refresh are waited for. A failed load keeps
 * the value there was, and the next caller past the TTL starts another.
 */
export function createTtlCache<T>(
  load: (trigger: LoadTrigger) => Promise<T>,
  ttlMs: number,
  { minForceIntervalMs = 0, onBackgroundRefresh, shared, onSharedHit }: TtlCacheOptions<T> = {},
) {
  let cached: Entry<T> | null = null;
  let inflight: Promise<T> | null = null;
  let hydrating: Promise<void> | null = null;

  async function readShared(store = shared?.()): Promise<Entry<T> | undefined> {
    try {
      return await store?.read();
    } catch {
      return undefined;
    }
  }

  function writeShared(entry: Entry<T>): void {
    try {
      shared?.()?.write(entry);
    } catch {
      // The shared store is an optimisation; the value is cached here regardless.
    }
  }

  /** Takes a peer's entry when it is newer than what is here; true when it did. */
  function adopt(entry: Entry<T> | undefined): boolean {
    if (!entry || (cached && entry.at <= cached.at)) return false;
    cached = entry;
    onSharedHit?.(entry);
    return true;
  }

  /** A cold cache's first look at the shared store: one read, however many callers ask. */
  function hydrate(store: SharedStore<T>): Promise<void> {
    hydrating ??= readShared(store)
      .then((entry) => {
        adopt(entry);
      })
      .finally(() => {
        hydrating = null;
      });
    return hydrating;
  }

  function refresh(trigger: LoadTrigger, consultShared: boolean): Promise<T> {
    if (inflight) return inflight;

    const run = async (): Promise<T> => {
      if (consultShared) {
        // A peer may have refreshed it already: a newer entry still inside its TTL saves a load.
        const entry = await readShared();
        if (entry && Date.now() - entry.at < ttlMs && adopt(entry)) return entry.value;
      }
      const value = await load(trigger);
      cached = { at: Date.now(), value };
      writeShared(cached);
      return value;
    };
    const current = run().finally(() => {
      if (inflight === current) inflight = null;
    });
    inflight = current;
    // Every load, the cold and the forced ones too, outlives the response that
    // began it: a caller that joins it later must not find it cancelled. The
    // handler also keeps a load nobody awaits from being an unhandled rejection.
    const kept = current.catch(() => {});
    onBackgroundRefresh?.(kept);
    return current;
  }

  async function get({ force = false, allowStale = false, waitForFreshMs = 0 }: GetOptions = {}): Promise<T> {
    // A cold start has just read the shared store, so a refresh right after it does not read it again.
    let consultShared = true;
    if (!cached) {
      const store = shared?.();
      if (store) await hydrate(store);
      if (!cached) return refresh("cold", false);
      consultShared = false;
    }

    const age = Date.now() - cached.at;
    if (force) return age < minForceIntervalMs ? cached.value : refresh("force", false);
    if (age < ttlMs) return cached.value;

    const stale = cached.value;
    // A failed background refresh keeps the old value; the next caller past
    // the TTL starts another.
    const next = refresh("stale", consultShared);
    if (allowStale || waitForFreshMs <= 0) return stale;
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(stale), waitForFreshMs);
      next.then(resolve, () => resolve(stale)).finally(() => clearTimeout(timer));
    });
  }

  /**
   * Changes the value in hand in place, for what arrives after its load (the
   * release feeds and notes of a board). It keeps the entry's load time, so
   * the value expires when it would have, and shares the change. A patch that
   * returns the same value changes nothing; with no value yet there is nothing
   * to patch.
   */
  function update(patch: (value: T) => T): void {
    if (!cached) return;
    const value = patch(cached.value);
    if (value === cached.value) return;
    cached = { at: cached.at, value };
    writeShared(cached);
  }

  /** The entry in hand, if any, without loading or reading anything. */
  function peek(): Entry<T> | undefined {
    return cached ?? undefined;
  }

  return { get, update, peek };
}
