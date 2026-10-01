import { describe, expect, it } from "vitest";
import { FEED_BOOT_SCRIPT, FEED_ROWS_PROPERTY } from "./feed-boot";
import { PULSE_STORAGE_KEY, type Pulse } from "./pulse";
import { RECENT_LIMIT, recentRows } from "./recent";

const counts = { operational: 14, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };

function pulse(n: number, over: Partial<Pulse> = {}): Pulse {
  const slot = Date.parse("2026-09-30T10:00:00.000Z") - n * 120_000;
  return {
    slot,
    at: new Date(slot).toISOString(),
    overall: "operational",
    counts,
    changes: [],
    opening: false,
    ...over,
  };
}

const change = [
  { id: "aws" as const, name: "AWS", from: "operational" as const, to: "outage" as const, summary: "Down" },
];

/** Runs the script as text, as <head> does, against a stand-in for local storage; returns the property it set, if any. */
function rows(stored: string | null | (() => string | null)): string | null {
  let value: string | null = null;
  const localStorage = {
    getItem: (key: string) => {
      expect(key).toBe(PULSE_STORAGE_KEY);
      return typeof stored === "function" ? stored() : stored;
    },
  };
  const documentElement = {
    style: {
      setProperty: (name: string, next: string) => {
        expect(name).toBe(FEED_ROWS_PROPERTY);
        value = next;
      },
    },
  };
  new Function("localStorage", "document", FEED_BOOT_SCRIPT)(localStorage, { documentElement });
  return value;
}

const store = (pulses: unknown) => JSON.stringify({ lastSlot: null, lastBoard: null, pulses });

describe("FEED_BOOT_SCRIPT", () => {
  it("counts the rows the feed will draw, the same as recentRows does", () => {
    const cases: Pulse[][] = [
      [],
      [pulse(0, { opening: true })],
      Array.from({ length: 12 }, (_, n) => pulse(n, { changes: change })),
      // A run of quiet checks is one row.
      [pulse(0, { changes: change }), pulse(1), pulse(2), pulse(3), pulse(4, { changes: change }), pulse(5), pulse(6)],
      Array.from({ length: 20 }, (_, n) => pulse(n)),
      // The limit applies to checks, before they are merged into rows.
      [...Array.from({ length: RECENT_LIMIT }, (_, n) => pulse(n)), pulse(RECENT_LIMIT, { changes: change })],
    ];
    for (const pulses of cases) expect(rows(store(pulses))).toBe(String(recentRows(pulses).length));
  });

  it("reserves at most the feed's visible rows", () => {
    const many = Array.from({ length: 60 }, (_, n) => pulse(n, { changes: change }));
    expect(rows(store(many))).toBe(String(RECENT_LIMIT));
  });

  it("sets nothing when there is nothing readable saved", () => {
    expect(rows(null)).toBeNull();
    expect(rows("")).toBeNull();
    expect(rows("not json")).toBeNull();
    expect(rows("null")).toBeNull();
    expect(rows(store("nope"))).toBeNull();
    expect(
      rows(() => {
        throw new Error("blocked");
      }),
    ).toBeNull();
  });

  it("does not throw on a malformed check", () => {
    expect(rows(store([null, 3, {}, { changes: "x" }]))).toBe("4");
  });
});
