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

    it("compares with the last report of the mouse, taken or not, for a browser that gives no movement", () => {
      const { spot } = reader();
      spot.pointed(790, 48, { screen: { x: 1290, y: 400 } });
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

    it("judges by movement alone once the browser has reported a movement, whatever the screen place does", () => {
      // iPadOS gives a place in the page, which follows a scroll under a mouse that has not moved.
      const { spot } = reader();
      spot.pointed(790, 48, { screen: { x: 1290, y: 400 }, movement: { x: 1, y: 1 } });
      spot.touched(417, 778);
      spot.pointed(792, 62, at(1290, 460));
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
      spot.pointed(795, 70, at(1290, 520));
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
      // And a move it says is taken, wherever the screen place is.
      spot.pointed(800, 70, { screen: { x: 1290, y: 520 }, movement: { x: 5, y: 0 } });
      expect(spot.spot()).toEqual({ x: 800, y: 70 });
    });

    it("does not take a report that says it did not move and gives no place on the screen", () => {
      const { spot } = reader();
      spot.pointed(790, 48, { movement: { x: 2, y: 2 } });
      spot.touched(417, 778);
      spot.pointed(792, 62, { movement: still });
      expect(spot.spot()).toEqual({ x: 417, y: 778 });
    });

    it("judges a first report with no place on the screen and no move by its window place, which is new", () => {
      // Before the browser has shown any movement, a report with nothing to be told by is judged by the window place.
      const fresh = reader().spot;
      fresh.touched(417, 778);
      fresh.pointed(792, 62, { movement: still });
      expect(fresh.spot()).toEqual({ x: 792, y: 62 });
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
      spot.pointed(320, 200, { screen: { x: 820, y: 300 }, movement: { x: 20, y: 0 } });
      expect(spot.spot()).toEqual({ x: 320, y: 200 });
    });
  });

  /**
   * Replays of what Playwright's WebKit reported in CI (run 37305167362 of the diagnostic branch): every move made by
   * automation has screenX = screenY = 0 and movementX = movementY = 0, whatever the mouse did; after a wheel the
   * engine's own reports carry a real screen place (screen = client). A step is a report of the
   * mouse (`move`, a `press`), a finger (`touch`) or the browser saying the mouse left; `spot` is what the reader is on
   * right after it.
   */
  describe("what WebKit under automation reports (screen 0,0 and movement 0 on every move made by automation)", () => {
    type Step =
      | {
          do: "move" | "press";
          x: number;
          y: number;
          spot: { x: number; y: number } | null;
          /** A real place on the screen, for a report that has one (the made report of the end-to-end test). */
          screen?: { x: number; y: number };
        }
      | { do: "touch"; x: number; y: number; spot: { x: number; y: number } | null };

    const zeros = { screen: { x: 0, y: 0 }, movement: { x: 0, y: 0 } };

    function replay(steps: Step[], advance = 0) {
      const { spot, advance: wait } = reader();
      steps.forEach((step, index) => {
        if (step.do === "touch") spot.touched(step.x, step.y);
        else
          spot.pointed(step.x, step.y, {
            pressed: step.do === "press",
            ...zeros,
            ...(step.screen && { screen: step.screen }),
          });
        wait(advance);
        expect(spot.spot(), `after step ${index} (${step.do} ${step.x},${step.y})`).toEqual(step.spot);
      });
    }

    it("holds the card under the mouse the Scroller moved to (iPad Pro 11 and iPhone 17 Pro, scroller)", () => {
      // iPad: 792,62 (move, then press), the same again, a move to 417,835 (the card), the page's own repeat at 417,835.8 (a pointermove
      // with trusted: false; the Scroller has no finger) and the engine's 417,835 again, both ignored.
      replay([
        { do: "move", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "press", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "move", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "move", x: 417, y: 835, spot: { x: 417, y: 835 } },
        { do: "move", x: 417, y: 835.8, spot: { x: 417, y: 835 } },
        { do: "move", x: 417, y: 835, spot: { x: 417, y: 835 } },
      ]);
      // iPhone: the same with 376,46 and 201,476.
      replay([
        { do: "move", x: 376, y: 46, spot: { x: 376, y: 46 } },
        { do: "press", x: 376, y: 46, spot: { x: 376, y: 46 } },
        { do: "move", x: 376, y: 46, spot: { x: 376, y: 46 } },
        { do: "move", x: 201, y: 476, spot: { x: 201, y: 476 } },
        { do: "move", x: 201, y: 476.7, spot: { x: 201, y: 476 } },
      ]);
    });

    it("holds the mouse piece once the mouse moves after the finger has lifted (mouse-moves)", () => {
      // iPad: the finger's glide ends, then moves 791,60 / 791,59 / 790,58 / 790,57 / 790,56 of the mouse.
      replay([
        { do: "move", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "press", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "move", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "touch", x: 417, y: 835.8, spot: { x: 417, y: 835.8 } },
        { do: "touch", x: 417, y: 775.8, spot: { x: 417, y: 775.8 } },
        { do: "move", x: 791, y: 60, spot: { x: 791, y: 60 } },
        { do: "move", x: 791, y: 59, spot: { x: 791, y: 59 } },
        { do: "move", x: 790, y: 58, spot: { x: 790, y: 58 } },
        { do: "move", x: 790, y: 57, spot: { x: 790, y: 57 } },
        { do: "move", x: 790, y: 56, spot: { x: 790, y: 56 } },
      ]);
      // iPhone: 375,46 then 374,47 then 374,48, after a finger at 201,476.7.
      replay([
        { do: "move", x: 376, y: 46, spot: { x: 376, y: 46 } },
        { do: "press", x: 376, y: 46, spot: { x: 376, y: 46 } },
        { do: "touch", x: 201, y: 476.7, spot: { x: 201, y: 476.7 } },
        { do: "move", x: 375, y: 46, spot: { x: 375, y: 46 } },
        { do: "move", x: 374, y: 47, spot: { x: 374, y: 47 } },
        { do: "move", x: 374, y: 48, spot: { x: 374, y: 48 } },
      ]);
    });

    it("keeps the finger's card when the mouse moved before the touch and is only reported again (stray-flick, fake-move-flick)", () => {
      // iPad: the engine's move to 790,56 comes before the touch and counts; the page's repeats of it while the page
      // glides (trusted: false, the same place) do not.
      replay([
        { do: "move", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "press", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "move", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "move", x: 790, y: 56, spot: { x: 790, y: 56 } },
        { do: "touch", x: 417, y: 832.8, spot: { x: 417, y: 832.8 } },
        { do: "move", x: 790, y: 56, spot: { x: 417, y: 832.8 } },
        { do: "touch", x: 417, y: 775.8, spot: { x: 417, y: 775.8 } },
        { do: "move", x: 790, y: 56, spot: { x: 417, y: 775.8 } },
        // Added, not logged: a report a fraction of a pixel from the place last seen (790,56) is no move (rule 1).
        { do: "move", x: 790.4, y: 56, spot: { x: 417, y: 775.8 } },
      ]);
      // iPhone: 376,46 pressed, a move to 374,56, then repeats of 374,56 under a finger at 201,473.7.
      replay([
        { do: "move", x: 376, y: 46, spot: { x: 376, y: 46 } },
        { do: "press", x: 376, y: 46, spot: { x: 376, y: 46 } },
        { do: "move", x: 374, y: 56, spot: { x: 374, y: 56 } },
        { do: "touch", x: 201, y: 473.7, spot: { x: 201, y: 473.7 } },
        { do: "move", x: 374, y: 56, spot: { x: 201, y: 473.7 } },
        { do: "move", x: 374, y: 56, spot: { x: 201, y: 473.7 } },
      ]);
    });

    it("keeps the finger's card against the made hover report, which has the same real screen place each time (fake-move-flick)", () => {
      // e2e/scroll-jump.spec.ts, `fake`: 100 ms after the last scroll event the page reports the mouse again at another
      // window place (788,40), with no movement and one fixed, real screen place (the engine's own has none under
      // WebKit's automation, so a made report stands for a device that has one). The first real place has nothing
      // before it and a repeat has not changed, so neither is a move; the mouse that then really moves is one.
      const fake = { screen: { x: 1788, y: 140 } };
      replay([
        { do: "move", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "press", x: 792, y: 62, spot: { x: 792, y: 62 } },
        { do: "move", x: 790, y: 56, spot: { x: 790, y: 56 } },
        { do: "touch", x: 417, y: 832.8, spot: { x: 417, y: 832.8 } },
        { do: "move", x: 790, y: 56, spot: { x: 417, y: 832.8 } },
        { do: "touch", x: 417, y: 775.8, spot: { x: 417, y: 775.8 } },
        { do: "move", x: 790, y: 56, spot: { x: 417, y: 775.8 } },
        { do: "move", x: 788, y: 40, spot: { x: 417, y: 775.8 }, ...fake },
        { do: "touch", x: 417, y: 700.8, spot: { x: 417, y: 700.8 } },
        { do: "move", x: 788, y: 20, spot: { x: 417, y: 700.8 }, ...fake },
        { do: "move", x: 791, y: 60, spot: { x: 791, y: 60 } },
      ]);
    });

    it("takes the steps of an isolated mouse and not the engine's own report at the same place after a wheel (Desktop Safari)", () => {
      const { spot } = reader();
      for (const [x, y] of [
        [100, 100],
        [120, 140],
        [140, 180],
        [160, 220],
        [180, 260],
        [200, 300],
      ] as const) {
        spot.pointed(x, y, zeros);
        expect(spot.spot()).toEqual({ x, y });
      }
      // A finger took the spot, then the engine reports the mouse where it is, with the first real screen place.
      spot.touched(50, 400);
      spot.pointed(200, 300, { screen: { x: 200, y: 300 }, movement: { x: 0, y: 0 } });
      expect(spot.spot()).toEqual({ x: 50, y: 400 });
    });

    it("does not take the engine's first report with a real screen place after a scroll, when the screen place was 0,0 before", () => {
      // The scroll moved what is under a mouse the page saw at 200,300; the report at 200,310 has the first real
      // screen place, with nothing before it to be compared with, so it says nothing.
      const { spot } = reader();
      spot.pointed(200, 300, zeros);
      spot.touched(50, 400);
      spot.pointed(200, 310, { screen: { x: 200, y: 310 }, movement: { x: 0, y: 0 } });
      expect(spot.spot()).toEqual({ x: 50, y: 400 });
    });
  });
});
