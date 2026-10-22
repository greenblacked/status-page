import { afterEach, describe, expect, it, vi } from "vitest";
import { currentGate, defaultConnectionLimit, withConnectionGate } from "./connection-gate";

// Lets every already-settled promise callback run, so a test can tell which
// acquirers got a slot without any of them doing real work.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("withConnectionGate", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lets `limit` acquirers run and queues the rest until a slot is released", async () => {
    await withConnectionGate({ limit: 6 }, async () => {
      const gate = currentGate()!;
      const granted: number[] = [];
      const releases: Array<() => void> = [];
      for (let n = 1; n <= 8; n += 1) {
        void gate.acquire("high").then((release) => {
          granted.push(n);
          releases.push(release);
        });
      }
      await settle();
      expect(granted).toEqual([1, 2, 3, 4, 5, 6]);
      expect(gate.active).toBe(6);

      releases[0]!();
      await settle();
      expect(granted).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(gate.active).toBe(6);

      for (const release of releases) release();
      await settle();
      expect(granted).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
  });

  it("serves a high-priority waiter before a low one that queued first", async () => {
    await withConnectionGate({ limit: 1 }, async () => {
      const gate = currentGate()!;
      const release = await gate.acquire("high");
      const order: string[] = [];
      const low = gate.acquire("low").then((next) => {
        order.push("low");
        next();
      });
      const high = gate.acquire("high").then((next) => {
        order.push("high");
        next();
      });
      release();
      await Promise.all([low, high]);
      expect(order).toEqual(["high", "low"]);
    });
  });

  it("frees a slot only once, however often its release is called", async () => {
    await withConnectionGate({ limit: 2 }, async () => {
      const gate = currentGate()!;
      const first = await gate.acquire("high");
      await gate.acquire("high");
      let thirdGranted = false;
      let fourthGranted = false;
      void gate.acquire("high").then(() => {
        thirdGranted = true;
      });
      void gate.acquire("high").then(() => {
        fourthGranted = true;
      });
      first();
      first();
      first();
      await settle();
      expect(thirdGranted).toBe(true);
      expect(fourthGranted).toBe(false);
      expect(gate.active).toBe(2);
    });
  });

  it("counts down to the deadline, and has no deadline without one", async () => {
    vi.useFakeTimers();
    await withConnectionGate({ deadlineMs: 15_000 }, async () => {
      const gate = currentGate()!;
      expect(gate.remainingMs()).toBe(15_000);
      vi.advanceTimersByTime(4_000);
      expect(gate.remainingMs()).toBe(11_000);
      vi.advanceTimersByTime(20_000);
      expect(gate.remainingMs()).toBeLessThanOrEqual(0);
    });
    await withConnectionGate({}, async () => {
      expect(currentGate()!.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    });
  });

  it("counts a request when it asks for a connection, before it gets one", async () => {
    await withConnectionGate({ limit: 1 }, async () => {
      const gate = currentGate()!;
      const release = await gate.acquire();
      void gate.acquire("low");
      // One holds the slot, one waits for it: both count.
      expect(gate.issued).toBe(2);
      gate.noteRequest();
      expect(gate.issued).toBe(3);
      release();
    });
  });

  it("reserves a retry only while fewer than maxRequests requests are counted, and counts it at once", async () => {
    await withConnectionGate({ maxRequests: 3 }, async () => {
      const gate = currentGate()!;
      const release = await gate.acquire();
      expect(gate.issued).toBe(1);
      expect(gate.reserveRetry()).toBe(true);
      expect(gate.issued).toBe(2);
      gate.noteRequest();
      // Spent: the request, its reserved retry and a redirect hop.
      expect(gate.reserveRetry()).toBe(false);
      expect(gate.issued).toBe(3);
      release();
    });
    await withConnectionGate({}, async () => {
      const gate = currentGate()!;
      for (let n = 0; n < 100; n += 1) gate.noteRequest();
      expect(gate.reserveRetry()).toBe(true);
    });
  });

  it("has no gate outside withConnectionGate, and one per scope inside it", async () => {
    expect(currentGate()).toBeUndefined();
    const [a, b] = await Promise.all([
      withConnectionGate({ limit: 1 }, async () => currentGate()),
      withConnectionGate({ limit: 1 }, async () => currentGate()),
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(currentGate()).toBeUndefined();
  });

  it("defaults to 6 connections on Workers and 16 elsewhere", () => {
    expect(defaultConnectionLimit()).toBe(16);
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    expect(defaultConnectionLimit()).toBe(6);
  });
});
