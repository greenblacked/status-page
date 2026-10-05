import { describe, expect, it } from "vitest";
import { heldResidual, scrollResidual } from "./scroll-residual";

const base = { scrollY: 1_800, viewport: 1_194 };

describe("scrollResidual", () => {
  it("owes nothing when the browser held the place by itself", () => {
    // The anchor's top in the window is where it was: scroll anchoring already scrolled by the row.
    expect(scrollResidual({ ...base, was: 574, now: 574 })).toBe(0);
  });

  it("owes the whole move to a browser that did not anchor", () => {
    expect(scrollResidual({ ...base, was: 574, now: 637 })).toBe(63);
    expect(scrollResidual({ ...base, was: 574, now: 511 })).toBe(-63);
  });

  it("owes only what is left when the browser held part of it", () => {
    expect(scrollResidual({ ...base, was: 574, now: 590 })).toBe(16);
  });

  it("leaves a move of less than half a pixel alone, from either side", () => {
    expect(scrollResidual({ ...base, was: 574, now: 574.4 })).toBe(0);
    expect(scrollResidual({ ...base, was: 574, now: 573.6 })).toBe(0);
    expect(scrollResidual({ ...base, was: 574, now: 574.5 })).toBe(0.5);
  });

  it("owes nothing at the top of the page or pulled past it", () => {
    expect(scrollResidual({ was: 574, now: 637, scrollY: 0, viewport: 1_194 })).toBe(0);
    expect(scrollResidual({ was: 574, now: 637, scrollY: -40, viewport: 1_194 })).toBe(0);
    expect(scrollResidual({ was: 574, now: 637, scrollY: 0.5, viewport: 1_194 })).toBe(63);
  });

  it("owes nothing for a reorder of more than a screen", () => {
    expect(scrollResidual({ ...base, was: 100, now: 100 + 1_194 })).toBe(1_194);
    expect(scrollResidual({ ...base, was: 100, now: 100 + 1_195 })).toBe(0);
    expect(scrollResidual({ ...base, was: 1_300, now: 100 })).toBe(0);
  });

  it("owes nothing for a place that cannot be measured", () => {
    expect(scrollResidual({ ...base, was: 574, now: Number.NaN })).toBe(0);
    expect(scrollResidual({ ...base, was: Number.NaN, now: 574 })).toBe(0);
    expect(scrollResidual({ ...base, was: 574, now: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

describe("heldResidual", () => {
  const view = { scrollY: 1_800, viewport: 1_194 };

  it("holds the place the reader is on", () => {
    expect(heldResidual([{ was: 574, now: () => 637 }], view)).toBe(63);
  });

  it("holds the next place out when the first is gone, by that place's own move", () => {
    const places = [
      { was: 574, now: () => null },
      { was: 520, now: () => 583 },
      { was: 400, now: () => 400 },
    ];
    expect(heldResidual(places, view)).toBe(63);
  });

  it("does not measure the places further out when the first can be", () => {
    let measured = 0;
    const places = [
      { was: 574, now: () => 574 },
      {
        was: 400,
        now: () => {
          measured++;
          return 463;
        },
      },
    ];
    expect(heldResidual(places, view)).toBe(0);
    expect(measured).toBe(0);
  });

  it("owes nothing, and says so, when nothing is left to hold", () => {
    expect(heldResidual([], view)).toBeNull();
    expect(heldResidual([{ was: 574, now: () => null }], view)).toBeNull();
  });
});
