import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dialTicks } from "./dial.ts";

const segments = (path: string) => path.match(/M/g)?.length ?? 0;

describe("period dial ticks", () => {
  it("draws one tick per second of a two-minute period, longer every ten and at the quarters", () => {
    const ticks = dialTicks();
    assert.equal(segments(ticks.quarter), 4);
    assert.equal(segments(ticks.major), 8);
    assert.equal(segments(ticks.minor), 108);
  });

  it("starts at twelve o'clock and runs clockwise", () => {
    const ticks = dialTicks();
    assert.ok(ticks.quarter.startsWith("M50 1L50 10.5"));
    // The second quarter is at three o'clock, on the right.
    assert.ok(ticks.quarter.includes("M99 50L89.5 50"));
    // The first minor tick sits just right of twelve.
    const first = ticks.minor.match(/^M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)/);
    assert.ok(first);
    assert.ok(Number(first[1]) > 50 && Number(first[2]) < 2);
  });

  it("keeps each length to its own path", () => {
    const ticks = dialTicks({ count: 12, majorEvery: 2, outer: 40, minorLength: 2, majorLength: 4, quarterLength: 8 });
    assert.equal(segments(ticks.quarter), 4);
    // Quarters at 0, 3, 6 and 9; majors at the other even ticks.
    assert.equal(segments(ticks.major), 4);
    assert.equal(segments(ticks.minor), 4);
    assert.ok(ticks.quarter.startsWith("M50 10L50 18"));
  });

  it("skips quarters when the count cannot be split in four", () => {
    const ticks = dialTicks({ count: 10, majorEvery: 5 });
    assert.equal(ticks.quarter, "");
    assert.equal(segments(ticks.major), 2);
    assert.equal(segments(ticks.minor), 8);
  });
});
