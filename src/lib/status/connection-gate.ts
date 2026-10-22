import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which queue a request waits in when every connection is taken: the reads
 * that decide a card go first, side reads (product lists, server lists) last.
 */
export type Priority = "high" | "low";

export type GateOptions = {
  /** Connections open at once; defaultConnectionLimit() when absent. */
  limit?: number;
  /** How long the whole scope may take; no deadline when absent. */
  deadlineMs?: number;
  /** Subrequests the scope may issue before retries stop; unlimited when absent. */
  maxRequests?: number;
};

/**
 * The connections a Worker may hold open at once: Cloudflare lets one
 * invocation have six open and queues the rest inside fetch(), where a
 * queued request's own timer is already running. Node has no such
 * limit, so its number only bounds how many bodies are in memory together.
 */
export function defaultConnectionLimit(): number {
  return globalThis.navigator?.userAgent === "Cloudflare-Workers" ? 6 : 16;
}

export type Gate = {
  readonly limit: number;
  /** Slots in use. */
  readonly active: number;
  /**
   * Subrequests counted so far: one per acquire(), counted when it is asked
   * for, so a request still waiting for a connection already counts, plus
   * every redirect hop (noteRequest) and every reserved retry.
   */
  readonly issued: number;
  /**
   * Counts one request and resolves with a release function once a slot is
   * free. Calling the release more than once frees one slot.
   */
  acquire(priority?: Priority): Promise<() => void>;
  /** Milliseconds left before the deadline; Infinity without one, zero or less once it has passed. */
  remainingMs(): number;
  /** Counts one more subrequest of a request that holds a slot: a redirect hop. */
  noteRequest(): void;
  /**
   * Takes one subrequest of the budget for a retry and counts it as issued at
   * once, so failures that land together cannot all pass the check before any
   * of their retries is made. False once the budget is spent.
   */
  reserveRetry(): boolean;
};

/**
 * A counting semaphore over one sweep's vendor requests, with a deadline and
 * a subrequest count. Waiters are served first come, first served within a
 * priority, and every high-priority waiter before any low one; a low one
 * waits at least until the end of the turn it asked in, so the high requests
 * asked for in that turn go first. A slot passes straight from the request
 * that releases it to the next waiter, so a request arriving in between
 * cannot overtake the queue.
 */
function createGate({ limit = defaultConnectionLimit(), deadlineMs, maxRequests }: GateOptions): Gate {
  const slots = Math.max(1, limit);
  const deadlineAt = deadlineMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + deadlineMs;
  const budget = maxRequests ?? Number.POSITIVE_INFINITY;
  const queues: Record<Priority, Array<(release: () => void) => void>> = { high: [], low: [] };
  let active = 0;
  let issued = 0;

  // Hands free slots to waiters, high before low. A low waiter is only ever
  // served from here or by a release, never the moment it asks.
  function pump(): void {
    while (active < slots) {
      const next = queues.high.shift() ?? queues.low.shift();
      if (!next) return;
      active += 1;
      next(releaser());
    }
  }

  function releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queues.high.shift() ?? queues.low.shift();
      // The slot stays taken and moves to the waiter; only with nobody waiting is it freed.
      if (next) next(releaser());
      else active -= 1;
    };
  }

  return {
    limit: slots,
    get active() {
      return active;
    },
    get issued() {
      return issued;
    },
    acquire(priority = "high") {
      // Counted now, not once it has a slot: every sweep request is asked for
      // before the first answer lands, so a retry's budget check sees them all.
      issued += 1;
      if (priority === "high" && active < slots) {
        active += 1;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve) => {
        queues[priority].push(resolve);
        // A side read waits for the end of this turn even with a slot free: the
        // reads that decide a card are asked for in the same turn (a sweep
        // starts every collector at once), and they go first.
        if (priority === "low") queueMicrotask(pump);
      });
    },
    remainingMs: () => deadlineAt - Date.now(),
    noteRequest() {
      issued += 1;
    },
    reserveRetry() {
      if (issued >= budget) return false;
      issued += 1;
      return true;
    },
  };
}

// One gate per sweep. AsyncLocalStorage keeps it to the promises that sweep
// started, so on Workers a waiter never belongs to another request's
// invocation, and a request made outside any sweep is not gated at all.
const gates = new AsyncLocalStorage<Gate>();

/** Runs `fn` with every fetchText inside it sharing one gate. */
export function withConnectionGate<T>(options: GateOptions, fn: () => Promise<T>): Promise<T> {
  return gates.run(createGate(options), fn);
}

/** The gate of the enclosing withConnectionGate() call, or undefined outside one. */
export function currentGate(): Gate | undefined {
  return gates.getStore();
}
