import { describe, expect, it } from "vitest";
import type { PulseChange } from "./diff.ts";
import type { Pulse } from "./pulse.ts";
import { describeChange, RECENT_LIMIT, recentRows, upCaption } from "./recent.ts";
import type { Health } from "./types.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-09-30T10:00:00.000Z");

const counts = (up: number, rest: Partial<Record<Health, number>> = {}) => ({
  operational: up,
  degraded: 0,
  outage: 0,
  maintenance: 0,
  unknown: 0,
  ...rest,
});

function pulse(n: number, over: Partial<Pulse> = {}): Pulse {
  const slot = T0 + n * 2 * MINUTE;
  return {
    slot,
    at: new Date(slot).toISOString(),
    overall: "operational",
    counts: counts(14),
    changes: [],
    opening: false,
    ...over,
  };
}

const change = (over: Partial<PulseChange> = {}): PulseChange => ({
  id: "steam",
  name: "Steam",
  from: "operational",
  to: "degraded",
  summary: "Store pages are slow",
  ...over,
});

describe("describeChange", () => {
  it("says what the service is now, in the board's own words", () => {
    expect(describeChange(change())).toBe("Steam is now degraded");
    expect(describeChange(change({ to: "outage" }))).toBe("Steam is now down");
    expect(describeChange(change({ to: "maintenance" }))).toBe("Steam is now in maintenance");
    expect(describeChange(change({ from: "outage", to: "operational" }))).toBe("Steam is back");
    expect(describeChange(change({ to: "unknown" }))).toBe("Couldn't read Steam");
  });

  it("keeps a release tracker's own sentence when its health did not move", () => {
    expect(
      describeChange(change({ name: "RouterOS", from: "operational", to: "operational", summary: "7.21 stable" })),
    ).toBe("RouterOS: 7.21 stable");
  });
});

describe("upCaption", () => {
  it("counts the services up out of all of them", () => {
    expect(upCaption(counts(12, { degraded: 1, outage: 1 }))).toBe("12 of 14 up");
    expect(upCaption(counts(14))).toBe("14 of 14 up");
  });
});

describe("recentRows", () => {
  it("is empty before the first check", () => {
    expect(recentRows([])).toEqual([]);
  });

  it("names the first check", () => {
    const [row] = recentRows([pulse(0, { opening: true })]);
    expect(row).toMatchObject({ text: "First check", caption: "14 of 14 up", checks: 1, quiet: false });
  });

  it("reads one change as a sentence, with the reason after the count", () => {
    const [row] = recentRows([pulse(1, { counts: counts(13, { degraded: 1 }), changes: [change()] })]);
    expect(row.text).toBe("Steam is now degraded");
    expect(row.caption).toBe("13 of 14 up · Store pages are slow");
    expect(row.at).toBe(T0 + 2 * MINUTE);
  });

  it("does not repeat a release sentence in the caption", () => {
    const [row] = recentRows([
      pulse(1, { changes: [change({ name: "RouterOS", to: "operational", from: "operational", summary: "7.21" })] }),
    ]);
    expect(row.text).toBe("RouterOS: 7.21");
    expect(row.caption).toBe("14 of 14 up");
  });

  it("counts several changes and lists their names", () => {
    const [row] = recentRows([
      pulse(1, {
        counts: counts(12, { degraded: 2 }),
        changes: [change(), change({ id: "epic", name: "Epic Games" })],
      }),
    ]);
    expect(row.text).toBe("2 services changed");
    expect(row.caption).toBe("12 of 14 up · Steam, Epic Games");
  });

  it("collapses a run of checks with nothing changed into one row, stamped with the newest", () => {
    const rows = recentRows([pulse(6), pulse(5), pulse(4), pulse(3, { changes: [change()] }), pulse(2), pulse(1)]);
    expect(rows.map((row) => row.text)).toEqual([
      "Nothing changed · 3 checks",
      "Steam is now degraded",
      "Nothing changed · 2 checks",
    ]);
    expect(rows[0]).toMatchObject({ at: T0 + 12 * MINUTE, checks: 3, quiet: true });
    expect(rows[2].checks).toBe(2);
  });

  it("says plain Nothing changed for a single quiet check", () => {
    const [row] = recentRows([pulse(2), pulse(1, { changes: [change()] })]);
    expect(row.text).toBe("Nothing changed");
    expect(row.checks).toBe(1);
  });

  it("never lets an opening check join a quiet run", () => {
    const rows = recentRows([pulse(2), pulse(1), pulse(0, { opening: true })]);
    expect(rows.map((row) => row.text)).toEqual(["Nothing changed · 2 checks", "First check"]);
  });

  it("reads back only the last eight checks", () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      pulse(12 - n, { changes: [change({ id: "steam", name: `S${n}` })] }),
    );
    const rows = recentRows(many);
    expect(rows).toHaveLength(RECENT_LIMIT);
    expect(rows[0].text).toBe("S0 is now degraded");
    expect(recentRows(many, 3)).toHaveLength(3);
  });

  it("keys each row by its newest check", () => {
    const rows = recentRows([pulse(3), pulse(2), pulse(1, { changes: [change()] })]);
    expect(rows.map((row) => row.key)).toEqual([T0 + 6 * MINUTE, T0 + 2 * MINUTE]);
  });
});
