type TtlCacheOptions = {
  // How long past the TTL a caller that asks for `allowStale` may still get the
  // old value immediately, while a refresh runs behind it. 0 disables it.
  maxStaleMs?: number;
  // A forced refresh within this long of the last load returns that load
  // instead of starting another one, so a scripted Refresh button cannot turn
  // into one vendor sweep per click.
  minForceIntervalMs?: number;
  // Keep a background refresh alive after a Worker response is sent.
  onBackgroundRefresh?: (promise: Promise<unknown>) => void;
};

type GetOptions = { force?: boolean; allowStale?: boolean };

export function createTtlCache<T>(
  load: () => Promise<T>,
  ttlMs: number,
  { maxStaleMs = 0, minForceIntervalMs = 0, onBackgroundRefresh }: TtlCacheOptions = {},
) {
  let cached: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;

  function refresh(): Promise<T> {
    if (inflight) return inflight;

    inflight = load()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  }

  async function get({ force = false, allowStale = false }: GetOptions = {}): Promise<T> {
    if (!cached) return refresh();

    const age = Date.now() - cached.at;
    if (force) return age < minForceIntervalMs ? cached.value : refresh();
    if (age < ttlMs) return cached.value;
    if (allowStale && age < ttlMs + maxStaleMs) {
      // A failed background refresh keeps the old value; the next caller past
      // the stale window waits for a load and sees the error itself.
      const background = refresh().catch(() => {});
      onBackgroundRefresh?.(background);
      return cached.value;
    }
    return refresh();
  }

  return { get };
}
