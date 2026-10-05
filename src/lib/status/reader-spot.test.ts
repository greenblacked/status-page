import { describe, expect, it } from "vitest";
import { createReaderSpot } from "./reader-spot";

const MEMORY = 4_000;

function reader() {
  let at = 1_000_000;
  const spot = createReaderSpot(() => at, MEMORY);
  return {
    spot,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("createReaderSpot", () => {
  it("knows nothing before the reader does anything", () => {
    expect(reader().spot.spot()).toBeNull();
  });

  it("is where the mouse is, however long it rests", () => {
    const { spot, advance } = reader();
    spot.pointed(300, 200);
    advance(60_000);
    expect(spot.spot()).toEqual({ x: 300, y: 200 });
  });

  it("is where a finger is while it is down, and for the memory after it lifts, and not after", () => {
    const { spot, advance } = reader();
    spot.touched(100, 500);
    expect(spot.spot()).toEqual({ x: 100, y: 500 });
    advance(MEMORY - 1);
    expect(spot.spot()).toEqual({ x: 100, y: 500 });
    advance(1);
    expect(spot.spot()).toBeNull();
  });

  it("takes the finger over a mouse that was left elsewhere, even one that moved a moment before", () => {
    const { spot, advance } = reader();
    spot.pointed(792, 62);
    advance(30);
    spot.touched(417, 778);
    expect(spot.spot()).toEqual({ x: 417, y: 778 });
  });

  it("does not bring back the left mouse when the finger's memory is over", () => {
    const { spot, advance } = reader();
    spot.pointed(792, 62);
    spot.touched(417, 778);
    advance(MEMORY + 1);
    expect(spot.spot()).toBeNull();
  });

  it("does not take the browser's report of the old mouse place, as the page scrolls, for the mouse moving", () => {
    const { spot, advance } = reader();
    spot.pointed(792, 62);
    spot.touched(417, 778);
    advance(100);
    spot.pointed(792, 62);
    expect(spot.spot()).toEqual({ x: 417, y: 778 });
  });

  it("takes a report of the old mouse place that differs by a fraction of a pixel for the same place", () => {
    const { spot } = reader();
    spot.pointed(792, 62);
    spot.touched(417, 778);
    spot.pointed(792.4, 61.6);
    expect(spot.spot()).toEqual({ x: 417, y: 778 });
    spot.pointed(794, 62);
    expect(spot.spot()).toEqual({ x: 794, y: 62 });
  });

  it("takes the mouse back when it moves after the finger", () => {
    const { spot, advance } = reader();
    spot.touched(417, 778);
    advance(500);
    spot.pointed(60, 90);
    expect(spot.spot()).toEqual({ x: 60, y: 90 });
  });

  it("takes a press of the mouse for the reader even where the mouse already was", () => {
    const { spot } = reader();
    spot.pointed(792, 62);
    spot.touched(417, 778);
    spot.pointed(792, 62, true);
    expect(spot.spot()).toEqual({ x: 792, y: 62 });
  });

  it("forgets the mouse when it leaves the page, and takes it again where it comes back", () => {
    const { spot } = reader();
    spot.pointed(792, 62);
    spot.left();
    expect(spot.spot()).toBeNull();
    spot.pointed(300, 200);
    expect(spot.spot()).toEqual({ x: 300, y: 200 });
  });

  it("does not take a report of the place the mouse left from, after the browser said it left, for its coming back", () => {
    const { spot } = reader();
    spot.pointed(792, 62);
    spot.touched(417, 778);
    spot.left();
    spot.pointed(792, 62);
    expect(spot.spot()).toEqual({ x: 417, y: 778 });
    spot.pointed(792, 62, true);
    expect(spot.spot()).toEqual({ x: 792, y: 62 });
  });

  it("forgets both the mouse and the finger at a key press, and a repeat of the old mouse place does not bring it back", () => {
    const { spot } = reader();
    spot.pointed(300, 200);
    spot.touched(100, 500);
    spot.keyed();
    expect(spot.spot()).toBeNull();
    spot.pointed(300, 200);
    expect(spot.spot()).toBeNull();
    spot.pointed(301, 200);
    expect(spot.spot()).toEqual({ x: 301, y: 200 });
  });
});
