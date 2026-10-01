import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_BOOT_SCRIPT, FEED_METRICS, FEED_RESERVE_PROPERTY } from "./feed-boot";
import { PULSE_STORAGE_KEY, type Pulse } from "./pulse";
import { RECENT_LIMIT, recentRows } from "./recent";
import { lastPulseAt } from "./schedule";

const NOW = Date.parse("2026-09-30T10:01:00.000Z");
const SLOT = lastPulseAt(NOW);
const counts = { operational: 14, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function pulse(n: number, over: Partial<Pulse> = {}): Pulse {
  const slot = SLOT - n * 120_000;
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

const down = { id: "aws" as const, name: "AWS", from: "operational" as const, to: "outage" as const, summary: "Down" };
const change = [down];
const long = "Increased error rates and latency for API requests in US-EAST-1 affecting several services";
const many = [
  { ...down, id: "gcp" as const, name: "Google Cloud", to: "degraded" as const, summary: "Slow" },
  { ...down, name: "Amazon Web Services", summary: long },
  { ...down, id: "play" as const, name: "Android / Play", to: "maintenance" as const, summary: "Planned" },
];
const busy = { operational: 10, degraded: 2, outage: 1, maintenance: 1, unknown: 0 };

/** The saved checks of a returning visitor: the newest one's slot is saved too, so the load adds none. */
const store = (pulses: unknown, lastSlot: number | null = SLOT) =>
  JSON.stringify({ lastSlot, lastBoard: null, pulses });

/** Runs the script as text, as <head> does, against stand-ins for the page; returns the property it set, if any. */
function run(stored: string | null | (() => string | null), width = 1440): string | null {
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
        expect(name).toBe(FEED_RESERVE_PROPERTY);
        value = next;
      },
    },
  };
  new Function("localStorage", "document", "window", FEED_BOOT_SCRIPT)(
    localStorage,
    { documentElement },
    { innerWidth: width },
  );
  return value;
}

// The estimate again, written out plainly from recentRows' own words: the script has to agree with it.
const M = FEED_METRICS;
function glyph(code: number): number {
  if (code >= 97 && code <= 122) return M.lower[code - 97];
  if (code >= 65 && code <= 90) return M.upper[code - 65];
  if ([32, 46, 44, 58, 59, 47, 124].includes(code)) return 278;
  if ([45, 40, 41, 183].includes(code)) return 333;
  return 556;
}
const textWidth = (text: string, size: number) =>
  ([...text].reduce((sum, char) => sum + glyph(char.charCodeAt(0)), 0) * size * M.scale) / 1000;

function lines(text: string, size: number, column: number): number {
  const space = textWidth(" ", size);
  let count = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    const wide = textWidth(word, size);
    if (used > 0 && used + space + wide <= column) {
      used += space + wide;
    } else {
      if (used > 0) count++;
      used = wide;
    }
    if (used > column) {
      count += Math.ceil(used / column) - 1;
      used = used % column || column;
    }
  }
  return count;
}

function column(width: number): number {
  const wide = width >= M.wide;
  const body = Math.min(width, M.maxBody) - 2 * (wide ? M.gutterWide : M.gutter);
  return Math.max(body - (wide ? M.margin + M.gap : 0) - M.beside, 60);
}

function expected(pulses: Pulse[], width: number): number {
  const across = column(width);
  return recentRows(pulses).reduce(
    (sum, row) =>
      sum +
      M.pad +
      M.titleLine * lines(row.text, M.titleSize, across) +
      M.captionLine * lines(row.caption, M.captionSize, across),
    M.border,
  );
}

const shapes: Record<string, Pulse[]> = {
  "one opening check": [pulse(0, { opening: true })],
  "short changes": Array.from({ length: 12 }, (_, n) => pulse(n, { changes: change })),
  "quiet runs between changes": [
    pulse(0, { changes: change }),
    pulse(1),
    pulse(2),
    pulse(3),
    pulse(4, { changes: change }),
    pulse(5),
    pulse(6),
  ],
  "all quiet": Array.from({ length: 20 }, (_, n) => pulse(n)),
  "the limit applies to checks, before they are merged": [
    ...Array.from({ length: RECENT_LIMIT }, (_, n) => pulse(n)),
    pulse(RECENT_LIMIT, { changes: change }),
  ],
  "realistic: several services and long summaries": [
    pulse(0, { counts: busy, changes: many }),
    pulse(1, { counts: busy, changes: [many[1]] }),
    pulse(2, { counts: busy, changes: [{ ...down, name: "MikroTik RouterOS", summary: long }] }),
    pulse(3, { counts: busy, changes: [{ ...down, to: "operational", summary: "" }] }),
    pulse(4, { counts: busy }),
    pulse(5, { counts: busy }),
    pulse(6, { counts: busy, changes: [{ ...down, from: "degraded", to: "unknown", summary: "" }] }),
    pulse(7, { counts: busy, changes: [{ ...down, from: "outage", to: "outage", summary: "Release 7.21 stable" }] }),
    pulse(8, { counts: busy, changes: many }),
  ],
};

const widths = [...Array.from({ length: 120 }, (_, n) => 280 + n * 10), 767, 768, 769, 991, 992, 993];

describe("FEED_BOOT_SCRIPT", () => {
  it("reserves the height of the rows recentRows will draw, at every width", () => {
    for (const [name, pulses] of Object.entries(shapes)) {
      for (const width of widths) {
        expect(run(store(pulses), width), `${name} at ${width}px`).toBe(`${expected(pulses, width)}px`);
      }
    }
  });

  it("reserves a one-line row's real height on a wide screen: border, padding, a body line and a caption line", () => {
    // 2 + 8 * (24 + 21 + 18): the 3.9375rem a row measures in the browser.
    expect(run(store(shapes["short changes"]))).toBe(`${2 + RECENT_LIMIT * 63}px`);
  });

  it("reserves more as the column narrows and the captions wrap", () => {
    const heights = [1440, 767, 412, 390, 360, 320].map((width) =>
      Number.parseInt(run(store(shapes["realistic: several services and long summaries"]), width) ?? "", 10),
    );
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(heights[0]).toBeLessThan(heights.at(-1) ?? 0);
  });

  it("adds the check the load makes when this slot is not saved yet, and drops the oldest", () => {
    const pulses = shapes["realistic: several services and long summaries"];
    const added = [pulse(-1, { opening: false }), ...pulses];
    for (const width of [320, 390, 412, 768, 1440]) {
      expect(run(store(pulses, SLOT - 120_000), width)).toBe(`${expected(added, width)}px`);
    }
    // A store with no slot at all is the same: the load makes the check.
    expect(run(store(pulses, null), 390)).toBe(`${expected(added, 390)}px`);
  });

  it("merges that new quiet check into a quiet newest one", () => {
    const pulses = [pulse(0), pulse(1), pulse(2, { changes: change })];
    expect(run(store(pulses, SLOT - 120_000), 390)).toBe(`${expected([pulse(-1), ...pulses], 390)}px`);
    expect(recentRows([pulse(-1), ...pulses])).toHaveLength(2);
  });

  it("sets nothing when there is nothing readable saved", () => {
    expect(run(null)).toBeNull();
    expect(run("")).toBeNull();
    expect(run("not json")).toBeNull();
    expect(run("null")).toBeNull();
    expect(run(store("nope"))).toBeNull();
    expect(
      run(() => {
        throw new Error("blocked");
      }),
    ).toBeNull();
  });

  it("reserves the one row the load will make when the saved list is empty", () => {
    expect(run(store([]))).toBe(`${2 + 63}px`);
  });

  it("does not throw on a malformed check", () => {
    // A row each, the same height as a plain one-line row.
    expect(run(store([null, 3, {}, { changes: "x" }]))).toBe(`${2 + 4 * 63}px`);
    expect(run(store([{ counts: "x", changes: [null] }, { changes: [{ summary: 1 }, {}] }]))).not.toBeNull();
  });
});
