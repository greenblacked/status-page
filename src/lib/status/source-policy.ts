import type { ServiceId, ServiceSnapshot, SourceFailure } from "./types.ts";

// How often each source is really asked, across sweeps. A sweep runs every few
// minutes, but a release page or a version file changes a few times a month,
// and a vendor that is down or refusing gains nothing from being asked again at
// once. Opt-in: collectAllServices() takes a policy, and without one every
// source is fetched every sweep, as before (PASSTHROUGH_POLICY). Like
// sources.server.ts this runs under Node's own type stripping, so it uses
// relative .ts imports and erasable syntax only.

/**
 * How long a slow-moving source's raw read is reused (ttlMs), kept as a
 * fallback while it fails (keepGoodMs), and left alone after a failure while
 * that fallback stands in (retryMs).
 */
export type SourceTier = { ttlMs: number; retryMs: number; keepGoodMs: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The sources whose raw read is cached between sweeps: release pages and version files. */
export const SOURCE_TIERS = {
  mikrotik: { ttlMs: 15 * MINUTE_MS, retryMs: 5 * MINUTE_MS, keepGoodMs: 6 * HOUR_MS },
  "apple-os": { ttlMs: 15 * MINUTE_MS, retryMs: 5 * MINUTE_MS, keepGoodMs: 6 * HOUR_MS },
  windows: { ttlMs: 30 * MINUTE_MS, retryMs: 5 * MINUTE_MS, keepGoodMs: 6 * HOUR_MS },
  "android-os": { ttlMs: 30 * MINUTE_MS, retryMs: 5 * MINUTE_MS, keepGoodMs: 6 * HOUR_MS },
} as const satisfies Partial<Record<ServiceId, SourceTier>>;

/** The optional side requests: how long a value is reused, and how long a failure answers null without asking. */
export const SIDE_READS = {
  googleProducts: { ttlMs: 30 * MINUTE_MS, failTtlMs: 30 * MINUTE_MS },
  steamManagers: { ttlMs: 10 * MINUTE_MS, failTtlMs: 10 * MINUTE_MS },
  // The component list is read fresh whenever it answers; only a failure is remembered.
  grokComponents: { ttlMs: 0, failTtlMs: 10 * MINUTE_MS },
} as const satisfies Record<string, { ttlMs: number; failTtlMs: number }>;

/** Oldest last good snapshot shown in place of a transient failure, by its checkedAt. */
export const LAST_GOOD_MAX_AGE_MS = 5 * MINUTE_MS;
/** Failures in a row after which a source is not asked again until its backoff has passed. */
export const BREAKER_THRESHOLD = 3;
export const BREAKER_BASE_MS = MINUTE_MS;
export const BREAKER_MAX_MS = 10 * MINUTE_MS;
// The backoff is spread by up to this fraction either way, so sources that
// failed together are not all asked again in the same sweep.
const JITTER = 0.2;

/** What the policy did since the last stats() call: snapshots carried over, collectors skipped, reads served from memory. */
export type SweepPolicyStats = { carried: number; skipped: number; cachedReads: number };

export type SourcePolicy = {
  /**
   * Runs one collector under the source's breaker and last-good rules. The
   * collector gets `noteError`, to hand over the raw error behind a failure
   * snapshot: only the error carries a vendor's Retry-After (a duck-typed
   * `retryAfterMs`), which the snapshot's failure does not.
   */
  run(
    id: ServiceId,
    collect: (noteError: (error: unknown) => void) => Promise<ServiceSnapshot>,
  ): Promise<ServiceSnapshot>;
  /** One raw read of a slow-moving source, reused within its tier's TTL. Rejects when there is nothing to serve. */
  read<T>(
    key: string,
    tier: SourceTier,
    load: () => Promise<T>,
  ): Promise<{ value: T; fetchedAt: number; fromCache: boolean }>;
  /** One optional side request: its value, or null when it fails or failed lately. Never rejects. */
  side<T>(key: string, opts: { ttlMs: number; failTtlMs: number }, load: () => Promise<T>): Promise<T | null>;
  /** The counts since the last call (a sweep calls it at its start and its end), then zeroed. */
  stats(): SweepPolicyStats;
  /** Forgets every value, breaker and count. For tests. */
  reset(): void;
};

// A load's promise, with a synchronous throw turned into a rejection, so a
// side request that throws still answers null.
function attempt<T>(load: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(load()));
}

function zeroStats(): SweepPolicyStats {
  return { carried: 0, skipped: 0, cachedReads: 0 };
}

/** Exactly what a sweep did before there was a policy: every collector runs, every read and side request loads. */
export const PASSTHROUGH_POLICY: SourcePolicy = {
  run: (_id, collect) => collect(() => {}),
  read: async (_key, _tier, load) => {
    const value = await load();
    return { value, fetchedAt: Date.now(), fromCache: false };
  },
  side: (_key, _opts, load) => attempt(load).catch(() => null),
  stats: zeroStats,
  reset: () => {},
};

// A failure worth hiding behind a recent good reading: the vendor may well be
// fine and only this request was lost. A refusal, a 4xx or a payload that did
// not parse is shown at once.
function isTransient(failure: SourceFailure): boolean {
  return (
    failure.kind === "timeout" ||
    failure.kind === "network" ||
    (failure.kind === "http" && failure.status !== undefined && failure.status >= 500)
  );
}

function retryAfterOf(error: unknown): number {
  const value = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

type Breaker = { lastGood?: ServiceSnapshot; last?: ServiceSnapshot; failures: number; openUntil: number };
type Cached<T> = { value?: { value: T; at: number }; failedAt?: number; loading?: Promise<unknown> };

/**
 * A policy whose state (breakers, last good snapshots, cached reads) lives in
 * this instance only. `now` and `random` are injectable for tests.
 */
export function createSourcePolicy({
  now = Date.now,
  random = Math.random,
}: {
  now?: () => number;
  random?: () => number;
} = {}): SourcePolicy {
  const breakers = new Map<ServiceId, Breaker>();
  const reads = new Map<string, Cached<unknown>>();
  const sides = new Map<string, Cached<unknown>>();
  let counts = zeroStats();

  const jitter = (ms: number) => ms * (1 + (random() * 2 - 1) * JITTER);

  return {
    async run(id, collect) {
      let breaker = breakers.get(id);
      if (!breaker) {
        breaker = { failures: 0, openUntil: 0 };
        breakers.set(id, breaker);
      }
      if (now() < breaker.openUntil && breaker.last) {
        counts.skipped += 1;
        return breaker.last;
      }
      let error: unknown;
      const snapshot = await collect((noted) => {
        error = noted;
      });
      if (!snapshot.failure) {
        breaker.lastGood = snapshot;
        breaker.last = snapshot;
        breaker.failures = 0;
        breaker.openUntil = 0;
        return snapshot;
      }
      breaker.failures += 1;
      const at = now();
      if (breaker.failures >= BREAKER_THRESHOLD) {
        const backoff = Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * 2 ** (breaker.failures - BREAKER_THRESHOLD));
        breaker.openUntil = at + jitter(Math.max(retryAfterOf(error), backoff));
      }
      const { lastGood } = breaker;
      if (
        isTransient(snapshot.failure) &&
        lastGood &&
        at - Date.parse(lastGood.checkedAt) <= LAST_GOOD_MAX_AGE_MS &&
        breaker.failures < BREAKER_THRESHOLD
      ) {
        counts.carried += 1;
        breaker.last = lastGood;
        return lastGood;
      }
      breaker.last = snapshot;
      return snapshot;
    },

    async read<T>(key: string, tier: SourceTier, load: () => Promise<T>) {
      let entry = reads.get(key) as Cached<T> | undefined;
      if (!entry) {
        entry = {};
        reads.set(key, entry);
      }
      const cached = entry;
      // The last good value, while it is young enough to stand in for a failed read.
      const kept = () => {
        if (!cached.value || now() - cached.value.at >= tier.keepGoodMs) return undefined;
        counts.cachedReads += 1;
        return { value: cached.value.value, fetchedAt: cached.value.at, fromCache: true };
      };
      if (cached.value && now() - cached.value.at < tier.ttlMs) {
        counts.cachedReads += 1;
        return { value: cached.value.value, fetchedAt: cached.value.at, fromCache: true };
      }
      // After a failure the last good value stands in, without asking, until
      // retryMs has passed. With nothing kept the source is asked again:
      // replaying the old error would pass off a failure that is not new as a
      // new one (a card checked "just now", and a breaker counting requests
      // that were never made). The breaker alone holds back a source that
      // keeps failing.
      if (cached.failedAt !== undefined && now() - cached.failedAt < tier.retryMs) {
        const fallback = kept();
        if (fallback) return fallback;
      }
      if (cached.loading) return cached.loading as Promise<{ value: T; fetchedAt: number; fromCache: boolean }>;
      const loading = attempt(load)
        .then(
          (value) => {
            const at = now();
            cached.value = { value, at };
            cached.failedAt = undefined;
            return { value, fetchedAt: at, fromCache: false };
          },
          (error: unknown) => {
            cached.failedAt = now();
            const fallback = kept();
            if (fallback) return fallback;
            throw error;
          },
        )
        .finally(() => {
          cached.loading = undefined;
        });
      cached.loading = loading;
      return loading;
    },

    async side<T>(key: string, opts: { ttlMs: number; failTtlMs: number }, load: () => Promise<T>) {
      let entry = sides.get(key) as Cached<T> | undefined;
      if (!entry) {
        entry = {};
        sides.set(key, entry);
      }
      const cached = entry;
      if (cached.value && now() - cached.value.at < opts.ttlMs) {
        counts.cachedReads += 1;
        return cached.value.value;
      }
      if (cached.failedAt !== undefined && now() - cached.failedAt < opts.failTtlMs) {
        counts.cachedReads += 1;
        return null;
      }
      if (cached.loading) return cached.loading as Promise<T | null>;
      const loading = attempt(load)
        .then(
          (value) => {
            cached.value = { value, at: now() };
            cached.failedAt = undefined;
            return value;
          },
          () => {
            cached.value = undefined;
            cached.failedAt = now();
            return null;
          },
        )
        .finally(() => {
          cached.loading = undefined;
        });
      cached.loading = loading;
      return loading;
    },

    stats() {
      const taken = counts;
      counts = zeroStats();
      return taken;
    },

    reset() {
      breakers.clear();
      reads.clear();
      sides.clear();
      counts = zeroStats();
    },
  };
}

/** The policy one long-lived process shares across its sweeps. Tests make their own with createSourcePolicy(). */
export const sharedSourcePolicy = createSourcePolicy();
