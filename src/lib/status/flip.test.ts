import { describe, expect, it } from "vitest";
import { type Box, cardMoves } from "./flip";

const box = (left: number, top: number, width = 300, height = 200): Box => ({ left, top, width, height });
const boxes = (entries: Record<string, Box>) => new Map(Object.entries(entries));
const VIEWPORT = 800;

describe("cardMoves", () => {
  it("returns nothing when nothing moved", () => {
    const layout = boxes({ a: box(0, 0), b: box(0, 220) });
    expect(cardMoves(layout, new Map(layout), VIEWPORT)).toEqual([]);
  });

  it("ignores sub-pixel movement", () => {
    const before = boxes({ a: box(0, 0), b: box(0, 220) });
    const after = boxes({ a: box(0.4, 0.9), b: box(-0.5, 220.2) });
    expect(cardMoves(before, after, VIEWPORT)).toEqual([]);
  });

  it("reports the offset from the new place back to the old one", () => {
    const before = boxes({ a: box(0, 0), b: box(0, 220) });
    const after = boxes({ a: box(320, 220), b: box(0, 0) });
    expect(cardMoves(before, after, VIEWPORT)).toEqual([
      { id: "a", dx: -320, dy: -220 },
      { id: "b", dx: 0, dy: 220 },
    ]);
  });

  it("keeps a card that moved on one axis only", () => {
    const before = boxes({ a: box(10, 0) });
    const after = boxes({ a: box(0, 0) });
    expect(cardMoves(before, after, VIEWPORT)).toEqual([{ id: "a", dx: 10, dy: 0 }]);
  });

  it("ignores ids present on one side only", () => {
    const before = boxes({ a: box(0, 0), gone: box(0, 220) });
    const after = boxes({ a: box(0, 100), fresh: box(0, 220) });
    expect(cardMoves(before, after, VIEWPORT)).toEqual([{ id: "a", dx: 0, dy: -100 }]);
  });

  it("skips a card that is outside the viewport before and after", () => {
    const before = boxes({ above: box(0, -900), below: box(0, 1200), seen: box(0, 0) });
    const after = boxes({ above: box(0, -700), below: box(0, 1500), seen: box(0, 240) });
    expect(cardMoves(before, after, VIEWPORT)).toEqual([{ id: "seen", dx: 0, dy: -240 }]);
  });

  it("keeps a card that enters or leaves the viewport", () => {
    const before = boxes({ entering: box(0, 1200), leaving: box(0, 100) });
    const after = boxes({ entering: box(0, 100), leaving: box(0, 1200) });
    expect(cardMoves(before, after, VIEWPORT)).toEqual([
      { id: "entering", dx: 0, dy: 1100 },
      { id: "leaving", dx: 0, dy: -1100 },
    ]);
  });

  it("counts a card straddling the viewport edge as on screen", () => {
    const before = boxes({ edge: box(0, -150) });
    const after = boxes({ edge: box(0, -800) });
    expect(cardMoves(before, after, VIEWPORT)).toEqual([{ id: "edge", dx: 0, dy: 650 }]);
  });

  it("caps the number of moves", () => {
    const before = new Map<string, Box>();
    const after = new Map<string, Box>();
    for (let i = 0; i < 40; i++) {
      before.set(`c${i}`, box(0, i));
      after.set(`c${i}`, box(0, i + 10));
    }
    expect(cardMoves(before, after, VIEWPORT)).toHaveLength(24);
    expect(cardMoves(before, after, VIEWPORT, { limit: 3 }).map((move) => move.id)).toEqual(["c0", "c1", "c2"]);
  });

  it("honours a custom threshold", () => {
    const before = boxes({ a: box(0, 0) });
    const after = boxes({ a: box(0, 5) });
    expect(cardMoves(before, after, VIEWPORT, { threshold: 10 })).toEqual([]);
    expect(cardMoves(before, after, VIEWPORT, { threshold: 5 })).toEqual([{ id: "a", dx: 0, dy: -5 }]);
  });
});
