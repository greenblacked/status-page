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
    spot.pointed(792, 62, { pressed: true });
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
    spot.pointed(792, 62, { pressed: true });
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

  describe("a report that says what the mouse did", () => {
    const still = { x: 0, y: 0 };
    const at = (x: number, y: number) => ({ screen: { x, y }, movement: still });

    it("does not take a report with no move and no change of the screen place, although the window place is a new one", () => {
      // WebKit after a finger's scroll: the cursor's own place, which the page never saw (the hook saw 790,48).
      const { spot, advance } = reader();
      spot.pointed(790, 48, { screen: { x: 1290, y: 400 }, movement: { x: 5, y: 3 } });
      spot.touched(417, 778);
      advance(500);
      spot.pointed(792, 62, at(1290, 400));
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
    });

    it("takes a report that says the mouse moved, with the screen place the same or not given", () => {
      const { spot } = reader();
      spot.pointed(790, 48, { screen: { x: 1290, y: 400 }, movement: still });
      spot.touched(417, 778);
      spot.pointed(800, 60, { screen: { x: 1290, y: 400 }, movement: { x: 0, y: -2 } });
      expect(spot.spot()).toEqual({ x: 800, y: 60 });
      spot.touched(417, 778);
      spot.pointed(900, 60, { movement: { x: 4, y: 0 } });
      expect(spot.spot()).toEqual({ x: 900, y: 60 });
    });

    it("takes a report at another screen place, for a browser that gives no movement or gives 0", () => {
      const { spot } = reader();
      spot.pointed(790, 48, { screen: { x: 1290, y: 400 } });
      spot.touched(417, 778);
      spot.pointed(792, 62, { screen: { x: 1290, y: 400 } });
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
      spot.pointed(792, 62, at(1292, 414));
      expect(spot.spot()).toEqual({ x: 792, y: 62 });
    });

    it("takes a screen place a fraction of a pixel away for the same place", () => {
      const { spot } = reader();
      spot.pointed(790, 48, { screen: { x: 1290, y: 400 }, movement: { x: 1, y: 1 } });
      spot.touched(417, 778);
      spot.pointed(792, 62, at(1290.4, 400.6));
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
    });

    it("compares with the last report of the mouse, taken or not", () => {
      const { spot } = reader();
      spot.pointed(790, 48, { screen: { x: 1290, y: 400 }, movement: { x: 1, y: 1 } });
      spot.touched(417, 778);
      // A report that says nothing, at the screen place of the one before: not taken, and the screen place is kept.
      spot.pointed(792, 62, at(1290, 400));
      spot.pointed(793, 63, at(1290, 400));
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
      // The mouse goes elsewhere on the screen with no movement said: taken, and the next at that place is not new.
      spot.pointed(800, 70, at(1300, 410));
      expect(spot.spot()).toEqual({ x: 800, y: 70 });
      spot.touched(417, 778);
      spot.pointed(805, 75, at(1300, 410));
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
    });

    it("does not take the first report of the mouse on the page if it says nothing, and takes the one after that moves", () => {
      const { spot } = reader();
      spot.touched(417, 778);
      spot.pointed(792, 62, at(1290, 400));
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
      spot.pointed(795, 70, at(1293, 408));
      expect(spot.spot()).toEqual({ x: 795, y: 70 });
    });

    it("takes the first report of the mouse on the page if it says it moved", () => {
      const { spot } = reader();
      spot.touched(417, 778);
      spot.pointed(792, 62, { screen: { x: 1290, y: 400 }, movement: { x: 3, y: 3 } });
      expect(spot.spot()).toEqual({ x: 792, y: 62 });
    });

    it("takes a press whatever it says, and the mouse after a press that is still reports nothing new", () => {
      const { spot } = reader();
      spot.touched(417, 778);
      spot.pointed(792, 62, { pressed: true, ...at(1290, 400) });
      expect(spot.spot()).toEqual({ x: 792, y: 62 });
      spot.touched(417, 778);
      spot.pointed(794, 70, at(1290, 400));
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
    });

    it("still takes a move after the mouse left the page and a key was pressed", () => {
      const { spot } = reader();
      spot.pointed(300, 200, { screen: { x: 800, y: 300 }, movement: { x: 2, y: 2 } });
      spot.keyed();
      spot.pointed(300, 200, at(800, 300));
      expect(spot.spot()).toBeNull();
      spot.pointed(320, 200, at(820, 300));
      expect(spot.spot()).toEqual({ x: 320, y: 200 });
    });
  });
});
