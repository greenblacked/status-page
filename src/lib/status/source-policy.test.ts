import { describe, expect, it } from "vitest";
import {
  BREAKER_BASE_MS,
  BREAKER_MAX_MS,
  BREAKER_THRESHOLD,
  createSourcePolicy,
  LAST_GOOD_MAX_AGE_MS,
  PASSTHROUGH_POLICY,
  type SourceTier,
} from "./source-policy.ts";
import type { ServiceSnapshot, SourceFailure } from "./types.ts";

const START = Date.parse("2026-09-20T12:00:00.000Z");
const MINUTE = 60_000;

// A fake clock and a fixed random draw (0.5 is no jitter), shared by one policy.
function harness(random = () => 0.5) {
  const clock = { now: START };
  const policy = createSourcePolicy({ now: () => clock.now, random });
  return { clock, policy };
}

function good(at: number, summary = "All good."): ServiceSnapshot {
  return {
    id: "claude",
    name: "Claude",
    shortName: "Claude",
    category: "ai",
    sourceName: "status.claude.com",
    sourceUrl: "https://status.claude.com/",
    checkedAt: new Date(at).toISOString(),
    latencyMs: 10,
    health: "operational",
    summary,
    components: [],
    incidents: [],
  } as ServiceSnapshot;
}

function bad(at: number, failure: SourceFailure): ServiceSnapshot {
  return { ...good(at, "Official source did not respond."), health: "unknown", failure };
}

const TIMEOUT: SourceFailure = { kind: "timeout", message: "Timed out" };
const NETWORK: SourceFailure = { kind: "network", message: "fetch failed" };
const HTTP_503: SourceFailure = { kind: "http", message: "503", status: 503 };
const HTTP_404: SourceFailure = { kind: "http", message: "404", status: 404 };
const HTTP_429: SourceFailure = { kind: "http", message: "429", status: 429 };
const PARSER: SourceFailure = { kind: "parser", message: "bad" };

describe("SourcePolicy.run: circuit breaker", () => {
  it("opens after three failures in a row, skips while open, then a half-open success closes it", async () => {
    const { clock, policy } = harness();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      return bad(clock.now, HTTP_404);
    };
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await policy.run("claude", failing);
    expect(calls).toBe(BREAKER_THRESHOLD);

    // Open: the stored snapshot comes back unchanged and the collector is not called.
    clock.now += BREAKER_BASE_MS - 1;
    const skipped = await policy.run("claude", failing);
    expect(calls).toBe(BREAKER_THRESHOLD);
    expect(skipped.failure).toEqual(HTTP_404);
    expect(policy.stats().skipped).toBe(1);

    // Half-open after the backoff: one call, and its success closes the breaker.
    clock.now += 1;
    const recovered = await policy.run("claude", async () => {
      calls += 1;
      return good(clock.now);
    });
    expect(calls).toBe(BREAKER_THRESHOLD + 1);
    expect(recovered.failure).toBeUndefined();
    await policy.run("claude", failing);
    expect(calls).toBe(BREAKER_THRESHOLD + 2);
  });

  it("doubles the backoff on each failure past the threshold, up to the cap", async () => {
    const { clock, policy } = harness();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      return bad(clock.now, PARSER);
    };
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await policy.run("claude", failing);
    const waits: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      // Step a second at a time until the half-open call happens.
      const before = calls;
      let waited = 0;
      while (calls === before) {
        clock.now += 1_000;
        waited += 1_000;
        await policy.run("claude", failing);
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1, 2, 4, 8, 10, 10].map((minutes) => minutes * MINUTE));
    expect(BREAKER_MAX_MS).toBe(10 * MINUTE);
  });

  it("jitters the backoff by up to a fifth either way", async () => {
    for (const [draw, expected] of [
      [0, 0.8 * BREAKER_BASE_MS],
      [0.999_999, 1.2 * BREAKER_BASE_MS],
    ] as const) {
      const { clock, policy } = harness(() => draw);
      let calls = 0;
      const failing = async () => {
        calls += 1;
        return bad(clock.now, PARSER);
      };
      for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await policy.run("claude", failing);
      clock.now += Math.floor(expected) - 1_000;
      await policy.run("claude", failing);
      expect(calls).toBe(BREAKER_THRESHOLD);
      clock.now += 1_000;
      await policy.run("claude", failing);
      expect(calls).toBe(BREAKER_THRESHOLD + 1);
    }
  });

  it("honours a longer retryAfterMs on the error the collector noted", async () => {
    const { clock, policy } = harness();
    let calls = 0;
    const refused = async (noteError: (error: unknown) => void) => {
      calls += 1;
      noteError(Object.assign(new Error("429"), { retryAfterMs: 5 * MINUTE }));
      return bad(clock.now, HTTP_429);
    };
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await policy.run("claude", refused);
    clock.now += 5 * MINUTE - 1;
    await policy.run("claude", refused);
    expect(calls).toBe(BREAKER_THRESHOLD);
    clock.now += 1;
    await policy.run("claude", refused);
    expect(calls).toBe(BREAKER_THRESHOLD + 1);
  });

  it("keeps the breaker of each source to itself", async () => {
    const { clock, policy } = harness();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await policy.run("claude", async () => bad(clock.now, PARSER));
    let called = false;
    await policy.run("chatgpt", async () => {
      called = true;
      return { ...good(clock.now), id: "chatgpt" };
    });
    expect(called).toBe(true);
  });
});

describe("SourcePolicy.run: last known good", () => {
  it.each([
    ["a timeout", TIMEOUT],
    ["a network error", NETWORK],
    ["a 5xx", HTTP_503],
  ])("carries the last good snapshot over %s, unchanged", async (_label, failure) => {
    const { clock, policy } = harness();
    const last = good(clock.now);
    await policy.run("claude", async () => last);
    clock.now += MINUTE;
    const carried = await policy.run("claude", async () => bad(clock.now, failure));
    expect(carried).toBe(last);
    expect(carried.checkedAt).toBe(new Date(START).toISOString());
    expect(policy.stats().carried).toBe(1);
  });

  it.each([
    ["a refusal", HTTP_429],
    ["a 404", HTTP_404],
    ["a parser failure", PARSER],
  ])("never carries it over %s", async (_label, failure) => {
    const { clock, policy } = harness();
    await policy.run("claude", async () => good(clock.now));
    clock.now += MINUTE;
    const shown = await policy.run("claude", async () => bad(clock.now, failure));
    expect(shown.failure).toEqual(failure);
    expect(policy.stats().carried).toBe(0);
  });

  it("never carries a snapshot older than LAST_GOOD_MAX_AGE_MS", async () => {
    const { clock, policy } = harness();
    await policy.run("claude", async () => good(clock.now));
    clock.now += LAST_GOOD_MAX_AGE_MS;
    expect((await policy.run("claude", async () => bad(clock.now, TIMEOUT))).failure).toBeUndefined();
    clock.now += 1;
    expect((await policy.run("claude", async () => bad(clock.now, TIMEOUT))).failure).toEqual(TIMEOUT);
  });

  it("never carries it once the failures reach the breaker threshold", async () => {
    const { clock, policy } = harness();
    await policy.run("claude", async () => good(clock.now));
    const shown: Array<SourceFailure | undefined> = [];
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      clock.now += 1_000;
      shown.push((await policy.run("claude", async () => bad(clock.now, TIMEOUT))).failure);
    }
    expect(shown).toEqual([undefined, undefined, TIMEOUT]);
  });

  it("counts per sweep: stats() returns the counts since the last call", async () => {
    const { clock, policy } = harness();
    await policy.run("claude", async () => good(clock.now));
    await policy.run("claude", async () => bad(clock.now, TIMEOUT));
    expect(policy.stats()).toEqual({ carried: 1, skipped: 0, cachedReads: 0 });
    expect(policy.stats()).toEqual({ carried: 0, skipped: 0, cachedReads: 0 });
  });
});

const TIER: SourceTier = { ttlMs: 15 * MINUTE, retryMs: 5 * MINUTE, keepGoodMs: 6 * 60 * MINUTE };

describe("SourcePolicy.read", () => {
  it("serves a value within its TTL, and loads again after it", async () => {
    const { clock, policy } = harness();
    let loads = 0;
    const load = async () => `v${++loads}`;
    expect(await policy.read("k", TIER, load)).toEqual({ value: "v1", fetchedAt: START, fromCache: false });
    clock.now += TIER.ttlMs - 1;
    expect(await policy.read("k", TIER, load)).toEqual({ value: "v1", fetchedAt: START, fromCache: true });
    expect(policy.stats().cachedReads).toBe(1);
    clock.now += 1;
    expect(await policy.read("k", TIER, load)).toMatchObject({ value: "v2", fromCache: false });
    expect(loads).toBe(2);
  });

  it("keeps the last good value when a load fails, while it is younger than keepGoodMs", async () => {
    const { clock, policy } = harness();
    let fail = false;
    const load = async () => {
      if (fail) throw new Error("down");
      return "good";
    };
    await policy.read("k", TIER, load);
    fail = true;
    clock.now += TIER.ttlMs;
    expect(await policy.read("k", TIER, load)).toEqual({ value: "good", fetchedAt: START, fromCache: true });
    clock.now = START + TIER.keepGoodMs;
    await expect(policy.read("k", TIER, load)).rejects.toThrow("down");
  });

  it("does not load again before retryMs after a failure", async () => {
    const { clock, policy } = harness();
    let loads = 0;
    const load = async () => {
      loads += 1;
      throw new Error(`down ${loads}`);
    };
    await expect(policy.read("k", TIER, load)).rejects.toThrow("down 1");
    clock.now += TIER.retryMs - 1;
    await expect(policy.read("k", TIER, load)).rejects.toThrow("down 1");
    expect(loads).toBe(1);
    clock.now += 1;
    await expect(policy.read("k", TIER, load)).rejects.toThrow("down 2");
    expect(loads).toBe(2);
  });

  it("serves the last good value without loading during the retry wait", async () => {
    const { clock, policy } = harness();
    let loads = 0;
    let fail = false;
    const load = async () => {
      loads += 1;
      if (fail) throw new Error("down");
      return "good";
    };
    await policy.read("k", TIER, load);
    fail = true;
    clock.now += TIER.ttlMs;
    await policy.read("k", TIER, load);
    clock.now += TIER.retryMs - 1;
    expect(await policy.read("k", TIER, load)).toMatchObject({ value: "good", fromCache: true });
    expect(loads).toBe(2);
  });

  it("coalesces concurrent loads of one key", async () => {
    const { policy } = harness();
    let loads = 0;
    let release: (value: string) => void = () => {};
    const load = () => {
      loads += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const first = policy.read("k", TIER, load);
    const second = policy.read("k", TIER, load);
    release("shared");
    expect((await first).value).toBe("shared");
    expect((await second).value).toBe("shared");
    expect(loads).toBe(1);
    // Different keys are separate.
    const other = policy.read("other", TIER, async () => "own");
    expect((await other).value).toBe("own");
  });
});

describe("SourcePolicy.side", () => {
  const SIDE = { ttlMs: 10 * MINUTE, failTtlMs: 10 * MINUTE };

  it("serves a value within its TTL", async () => {
    const { clock, policy } = harness();
    let loads = 0;
    const load = async () => ++loads;
    expect(await policy.side("s", SIDE, load)).toBe(1);
    clock.now += SIDE.ttlMs - 1;
    expect(await policy.side("s", SIDE, load)).toBe(1);
    clock.now += 1;
    expect(await policy.side("s", SIDE, load)).toBe(2);
  });

  it("answers null for failTtlMs after a failure, without loading", async () => {
    const { clock, policy } = harness();
    let loads = 0;
    const load = async () => {
      loads += 1;
      throw new Error("down");
    };
    expect(await policy.side("s", SIDE, load)).toBeNull();
    clock.now += SIDE.failTtlMs - 1;
    expect(await policy.side("s", SIDE, load)).toBeNull();
    expect(loads).toBe(1);
    clock.now += 1;
    expect(await policy.side("s", SIDE, load)).toBeNull();
    expect(loads).toBe(2);
  });

  it("with a TTL of 0 loads every time while it succeeds", async () => {
    const { policy } = harness();
    let loads = 0;
    const load = async () => ++loads;
    await policy.side("s", { ttlMs: 0, failTtlMs: SIDE.failTtlMs }, load);
    expect(await policy.side("s", { ttlMs: 0, failTtlMs: SIDE.failTtlMs }, load)).toBe(2);
  });
});

describe("SourcePolicy.reset", () => {
  it("forgets every value, breaker and count", async () => {
    const { clock, policy } = harness();
    let loads = 0;
    await policy.read("k", TIER, async () => ++loads);
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await policy.run("claude", async () => bad(clock.now, PARSER));
    policy.reset();
    expect((await policy.read("k", TIER, async () => ++loads)).value).toBe(2);
    let called = false;
    await policy.run("claude", async () => {
      called = true;
      return good(clock.now);
    });
    expect(called).toBe(true);
    expect(policy.stats()).toEqual({ carried: 0, skipped: 0, cachedReads: 0 });
  });
});

describe("PASSTHROUGH_POLICY", () => {
  it("calls every collector, loads every read and side read, and swallows a side failure", async () => {
    let calls = 0;
    for (let i = 0; i < 5; i += 1) {
      await PASSTHROUGH_POLICY.run("claude", async () => {
        calls += 1;
        return bad(START, PARSER);
      });
    }
    expect(calls).toBe(5);
    let loads = 0;
    for (let i = 0; i < 3; i += 1) {
      expect(await PASSTHROUGH_POLICY.read("k", TIER, async () => ++loads)).toMatchObject({ fromCache: false });
      await PASSTHROUGH_POLICY.side("s", { ttlMs: MINUTE, failTtlMs: MINUTE }, async () => ++loads);
    }
    expect(loads).toBe(6);
    expect(
      await PASSTHROUGH_POLICY.side("s", { ttlMs: MINUTE, failTtlMs: MINUTE }, async () => {
        throw new Error("down");
      }),
    ).toBeNull();
    await expect(
      PASSTHROUGH_POLICY.read("k", TIER, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(PASSTHROUGH_POLICY.stats()).toEqual({ carried: 0, skipped: 0, cachedReads: 0 });
  });
});
