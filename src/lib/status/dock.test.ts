import { describe, expect, it, vi } from "vitest";
import {
  BAR_RISE,
  clampScroll,
  createDockStore,
  DOCK_REST,
  type DockGeometry,
  dockFrame,
  dockGeometry,
  PHONE_GAP,
  resizeMovesDock,
  WIDE_BAR_AT,
  WIDE_RANGE,
} from "./dock";

describe("createDockStore", () => {
  it("starts at rest: no bar, the field still in the hero", () => {
    expect(createDockStore().get()).toEqual({ barShown: false, docked: false });
    expect(DOCK_REST).toEqual({ barShown: false, docked: false });
  });

  it("returns what was set and tells its listeners once per change", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ barShown: true, docked: false });
    expect(store.get()).toEqual({ barShown: true, docked: false });
    expect(listener).toHaveBeenCalledTimes(1);
    store.set({ barShown: true, docked: true });
    expect(store.get()).toEqual({ barShown: true, docked: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stays silent, and keeps the same state object, when nothing changed", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const rest = store.get();
    store.set({ barShown: false, docked: false });
    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(rest);
    store.set({ barShown: true, docked: true });
    const shown = store.get();
    store.set({ barShown: true, docked: true });
    expect(store.get()).toBe(shown);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops telling a listener that unsubscribed, and only that one", () => {
    const store = createDockStore();
    const kept = vi.fn();
    const dropped = vi.fn();
    store.subscribe(kept);
    const unsubscribe = store.subscribe(dropped);
    store.set({ barShown: true, docked: false });
    unsubscribe();
    store.set({ barShown: false, docked: false });
    expect(kept).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it("lets a listener unsubscribe itself while being told", () => {
    const store = createDockStore();
    const later = vi.fn();
    const unsubscribe = store.subscribe(() => unsubscribe());
    store.subscribe(later);
    store.set({ barShown: true, docked: false });
    store.set({ barShown: false, docked: false });
    expect(later).toHaveBeenCalledTimes(2);
  });

  it("keeps separate stores independent", () => {
    const a = createDockStore();
    const b = createDockStore();
    a.set({ barShown: true, docked: true });
    expect(b.get()).toEqual({ barShown: false, docked: false });
  });
});

describe("dockGeometry", () => {
  const measured = { end: 1000, pin: 10, barTop: 8, barHeight: 48 };

  it("on a wide screen, makes one move of WIDE_RANGE that ends at `end`", () => {
    const g = dockGeometry({ ...measured, wide: true, reduce: false });
    expect(g.range).toBe(48);
    expect(g.start).toBe(952);
    expect(g.hysteresis).toBe(8);
  });

  it("on a wide screen, brings the bar up 67% of the way through the move", () => {
    const g = dockGeometry({ ...measured, wide: true, reduce: false });
    expect(g.barStart).toBeCloseTo(984.16, 5);
    expect(WIDE_RANGE).toBe(48);
    expect(WIDE_BAR_AT).toBe(0.67);
  });

  it("on a wide screen under Reduce Motion, holds the bar until the field has snapped, with no hysteresis", () => {
    const g = dockGeometry({ ...measured, wide: true, reduce: true });
    expect(g).toEqual({ start: 952, range: 48, barStart: 1000, hysteresis: 0 });
  });

  it("on a phone, raises the bar early and alone, then merges once the field reaches the bar's bottom edge", () => {
    const g = dockGeometry({ ...measured, wide: false, reduce: false });
    // The bar at 1000 - (48 + 24 - 2); the merge when the field's top (pin + end - y) meets the bar's bottom (56): y = 954.
    expect(g).toEqual({ start: 954, range: 46, barStart: 930, hysteresis: 8 });
    expect(PHONE_GAP).toBe(24);
    // Alone for PHONE_GAP px of scrolling, then a merge of at least 46.
    expect(g.start - g.barStart).toBe(PHONE_GAP);
    expect(g.range).toBeGreaterThanOrEqual(46);
  });

  it("on a phone, the bar comes up earlier the taller it is", () => {
    const short = dockGeometry({ ...measured, wide: false, reduce: false, barHeight: 40 });
    const tall = dockGeometry({ ...measured, wide: false, reduce: false, barHeight: 64 });
    expect(short.barStart).toBe(938);
    expect(tall.barStart).toBe(914);
  });

  it("on a phone, the gap counts from where the field pins relative to the bar's own top", () => {
    const g = dockGeometry({ end: 500, wide: false, reduce: false, pin: 16, barTop: 4, barHeight: 48 });
    // 500 - (48 + 24 - (16 - 4))
    expect(g.barStart).toBe(440);
  });

  it("on a phone, keeps the usual moment while the hero's last line ends well above the field", () => {
    // The line clears the bar (top 8, less the 8 it slides down) at 920 - 0 = 920, before the usual 930.
    const roomy = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 920 });
    expect(roomy).toEqual({ start: 954, range: 46, barStart: 930, hysteresis: 8 });
  });

  it("on a phone, holds the bar back until the hero's last line has scrolled clear of where it slides in", () => {
    // The line ends at 986, so it is clear of the bar (top 8, less the 8 it slides down) at 986, after the usual 930.
    const g = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 986 });
    expect(BAR_RISE).toBe(8);
    expect(g.barStart).toBe(986);
    // The merge starts with the bar, over the scrolling that is left.
    expect(g.start).toBe(986);
    expect(g.range).toBe(14);
    expect(g.hysteresis).toBe(8);
  });

  it("on a phone, with the spacing the page gives it, the bar and the merge each get their own stretch", () => {
    // The live line ends barHeight + BAR_RISE + PHONE_GAP above the field (its top is end + pin), on a phone
    // 375, 390, 412 or 430 wide alike: the geometry depends on none of the width.
    const fieldTop = measured.end + measured.pin;
    const contentBottom = fieldTop - (measured.barHeight + BAR_RISE + PHONE_GAP);
    const g = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom });
    // The line clears the bar exactly when the field is PHONE_GAP under the bar's bottom edge: nothing waits.
    expect(g.barStart).toBe(measured.end - (measured.barHeight + PHONE_GAP - (measured.pin - measured.barTop)));
    expect(g).toEqual(dockGeometry({ ...measured, wide: false, reduce: false }));
    // The bar is up alone for PHONE_GAP px of scrolling, then the field merges over the rest of its way to the bar.
    expect(g.start - g.barStart).toBe(PHONE_GAP);
    expect(g.start).toBe(measured.end - (measured.barHeight - (measured.pin - measured.barTop)));
    expect(g.range).toBe(46);
    // On an iPhone with a notch, the bar and the pin both move down by the safe area, and nothing changes.
    const notch = { ...measured, pin: measured.pin + 47, barTop: measured.barTop + 47 };
    const withNotch = dockGeometry({
      ...notch,
      wide: false,
      reduce: false,
      contentBottom: notch.end + notch.pin - (notch.barHeight + BAR_RISE + PHONE_GAP),
    });
    expect(withNotch).toEqual(g);
  });

  it("on a phone, the field is a clear PHONE_GAP under the bar's bottom edge where the bar comes up, and level with the page until then", () => {
    const g = dockGeometry({ ...measured, wide: false, reduce: false });
    // The field's top in the viewport at scroll y is (end + pin) - y until it pins.
    const fieldTopAt = (y: number) => measured.end + measured.pin - y;
    const barBottom = measured.barTop + measured.barHeight;
    expect(fieldTopAt(g.barStart) - barBottom).toBe(PHONE_GAP);
    // The merge starts with the field's top just at the bar's bottom edge, and ends with it at its pin.
    expect(fieldTopAt(g.start)).toBe(barBottom);
    expect(fieldTopAt(g.start + g.range)).toBe(measured.pin);
    // Bar first: at every scroll before the merge the frame has the bar up (past barStart) and the field not moving.
    for (let y = g.barStart; y <= g.start; y += 1) {
      const frame = dockFrame(y, g, false, { barShown: false, docked: false });
      expect(frame.barShown).toBe(true);
      expect(frame.p).toBe(0);
    }
    expect(dockFrame(g.barStart - 1, g, false, { barShown: false, docked: false }).barShown).toBe(false);
  });

  it("on a phone at a larger text size, the merge still starts below the bar, and the bar still has PHONE_GAP px to itself", () => {
    // A 32px root: the bar is 96px tall and 16px from the top, the field pins 2px under that.
    const big = { end: 1000, pin: 18, barTop: 16, barHeight: 96 };
    const g = dockGeometry({ ...big, wide: false, reduce: false });
    expect(g.start - g.barStart).toBe(PHONE_GAP);
    const fieldTopAt = (y: number) => big.end + big.pin - y;
    expect(fieldTopAt(g.barStart) - (big.barTop + big.barHeight)).toBe(PHONE_GAP);
    expect(fieldTopAt(g.start)).toBe(big.barTop + big.barHeight);
    expect(g.range).toBe(94);
  });

  it("on a phone, never starts the merge before the bar is up, nor lets its range reach zero", () => {
    const late = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 1100 });
    expect(late.start).toBe(late.barStart);
    expect(late.range).toBe(1);
  });

  it("on a wide screen, ignores the hero's last line", () => {
    expect(dockGeometry({ ...measured, wide: true, reduce: false, contentBottom: 990 })).toEqual(
      dockGeometry({ ...measured, wide: true, reduce: false }),
    );
  });

  it("on a phone, Reduce Motion changes nothing: the bar is already clear of the field", () => {
    expect(dockGeometry({ ...measured, wide: false, reduce: true })).toEqual(
      dockGeometry({ ...measured, wide: false, reduce: false }),
    );
  });
});

describe("dockFrame", () => {
  const geometry: DockGeometry = { start: 400, range: 48, barStart: 420, hysteresis: 8 };
  const rest = { barShown: false, docked: false };

  it("rests at the top of the page: p 0, no bar, not docked", () => {
    expect(dockFrame(0, geometry, false, rest)).toEqual({ p: 0, barShown: false, docked: false });
  });

  it("is halfway, with the bar up, in the middle of the move", () => {
    expect(dockFrame(424, geometry, false, rest)).toEqual({ p: 0.5, barShown: true, docked: false });
  });

  it("docks at p 1 and stays docked while scrolling on", () => {
    expect(dockFrame(448, geometry, false, rest)).toEqual({ p: 1, barShown: true, docked: true });
    expect(dockFrame(5000, geometry, false, rest)).toEqual({ p: 1, barShown: true, docked: true });
  });

  it("clamps an overscroll bounce above the page", () => {
    expect(dockFrame(-120, geometry, false, rest)).toEqual({ p: 0, barShown: false, docked: false });
  });

  it("latches docked=true part way when it was already docked (scrolling back up)", () => {
    const prev = { barShown: true, docked: true };
    expect(dockFrame(424, geometry, false, prev)).toEqual({ p: 0.5, barShown: true, docked: true });
  });

  it("latches docked=false part way when it was not yet docked (scrolling down)", () => {
    const prev = { barShown: true, docked: false };
    expect(dockFrame(440, geometry, false, prev).docked).toBe(false);
  });

  it("undocks only once back at p 0", () => {
    const prev = { barShown: true, docked: true };
    expect(dockFrame(401, geometry, false, prev).docked).toBe(true);
    expect(dockFrame(400, geometry, false, prev).docked).toBe(false);
  });

  it("rounds p to steps of 1/500 so a scroll of a fraction of a pixel is not a change", () => {
    // Smoothstep at 0.1 px of 48 is about 1.3e-5: under a step, so it reads as 0.
    const early = dockFrame(400.1, geometry, false, { barShown: false, docked: true });
    expect(early.p).toBe(0);
    expect(early.docked).toBe(false);
    const late = dockFrame(447.9, geometry, false, rest);
    expect(late.p).toBe(1);
    expect(late.docked).toBe(true);
    // Every value is a multiple of 1/500.
    for (let y = 400; y <= 448; y += 0.7) {
      const { p } = dockFrame(y, geometry, false, rest);
      expect(Math.abs(p * 500 - Math.round(p * 500))).toBeLessThan(1e-9);
    }
  });

  it("keeps the bar up through the hysteresis and drops it below", () => {
    const up = { barShown: true, docked: false };
    expect(dockFrame(412, geometry, false, up).barShown).toBe(true);
    expect(dockFrame(411.9, geometry, false, up).barShown).toBe(false);
    expect(dockFrame(412, geometry, false, rest).barShown).toBe(false);
    expect(dockFrame(420, geometry, false, rest).barShown).toBe(true);
  });

  it("under Reduce Motion, snaps p to its two poses", () => {
    expect(dockFrame(424, geometry, true, rest).p).toBe(0);
    expect(dockFrame(447.9, geometry, true, rest).p).toBe(0);
    expect(dockFrame(448, geometry, true, rest).p).toBe(1);
    expect(dockFrame(448, geometry, true, rest).docked).toBe(true);
  });

  it("under Reduce Motion, docked releases at once short of the end", () => {
    const prev = { barShown: true, docked: true };
    expect(dockFrame(430, geometry, true, prev).docked).toBe(false);
  });

  it("feeds the store: a scroll down and back up yields the expected changes", () => {
    const store = createDockStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(JSON.stringify(store.get())));
    for (const y of [0, 410, 421, 430, 448, 460, 430, 405, 300, 0]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set({ barShown: next.barShown, docked: next.docked });
    }
    expect(seen).toEqual([
      '{"barShown":true,"docked":false}',
      '{"barShown":true,"docked":true}',
      '{"barShown":false,"docked":true}',
      '{"barShown":false,"docked":false}',
    ]);
  });
});

describe("clampScroll", () => {
  it("holds a position the page can rest at", () => {
    expect(clampScroll(0, 2000)).toBe(0);
    expect(clampScroll(640.5, 2000)).toBe(640.5);
    expect(clampScroll(2000, 2000)).toBe(2000);
  });

  it("brings the rubber band's overshoot back to the two ends", () => {
    expect(clampScroll(-84, 2000)).toBe(0);
    expect(clampScroll(2096, 2000)).toBe(2000);
  });

  it("never lets a page that cannot scroll go below 0", () => {
    expect(clampScroll(40, 0)).toBe(0);
    expect(clampScroll(40, -12)).toBe(0);
  });
});

describe("resizeMovesDock", () => {
  it("ignores a resize that changes only the height, as the iOS toolbar does", () => {
    // 430 wide throughout; the viewport's height going from 740 to 820 is not a change of width.
    expect(resizeMovesDock(430, 430)).toBe(false);
  });

  it("follows a change of width, a rotation or a window resize", () => {
    expect(resizeMovesDock(430, 932)).toBe(true);
    expect(resizeMovesDock(1280, 1279)).toBe(true);
  });
});

describe("dockFrame, on an iPhone", () => {
  const geometry: DockGeometry = { start: 400, range: 48, barStart: 420, hysteresis: 8 };
  const rest = { barShown: false, docked: false };
  const docked = { barShown: true, docked: true };

  it("reads a rubber band above the top as the top, whatever the state before", () => {
    for (const prev of [rest, docked]) {
      const frame = dockFrame(-300, geometry, false, prev, 2000);
      expect(frame.p).toBe(0);
      expect(frame.barShown).toBe(false);
    }
  });

  it("reads a rubber band below the bottom as the bottom: docked, bar up, and nothing flips", () => {
    expect(dockFrame(2000, geometry, false, docked, 2000)).toEqual({ p: 1, barShown: true, docked: true });
    expect(dockFrame(2090, geometry, false, docked, 2000)).toEqual({ p: 1, barShown: true, docked: true });
  });

  it("is the same wherever the bounce goes, down to the pixel it started from", () => {
    const store = createDockStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(JSON.stringify(store.get())));
    // A fling down to the bottom, the bounce back past it, and the settle.
    for (const y of [300, 460, 1200, 2000, 2060, 2110, 2060, 2000, 1990]) {
      const next = dockFrame(y, geometry, false, store.get(), 2000);
      store.set({ barShown: next.barShown, docked: next.docked });
    }
    expect(seen).toEqual(['{"barShown":true,"docked":true}']);
  });

  it("does not flip the bar while a bounce at the top swings across 0", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const y of [0, -60, -4, -90, 0, -30, 0]) {
      const next = dockFrame(y, geometry, false, store.get(), 2000);
      store.set({ barShown: next.barShown, docked: next.docked });
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not flicker the bar when a finger rests within a pixel of where it comes up", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const y of [419.4, 420, 419.6, 420.2, 419, 420.4, 415, 420, 412]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set({ barShown: next.barShown, docked: next.docked });
    }
    // Up once at 420 and held through the hysteresis: 412 is as low as it goes.
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("dockFrame, under Reduce Motion", () => {
  const phone: DockGeometry = { start: 400, range: 48, barStart: 420, hysteresis: 8 };
  const wide: DockGeometry = { start: 952, range: 48, barStart: 1000, hysteresis: 0 };

  it("holds the snap through the hysteresis on a phone, so a finger at the end cannot flip the field", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const y of [447, 448, 447.5, 448.4, 446, 449, 444, 448, 441]) {
      const next = dockFrame(y, phone, true, store.get());
      store.set({ barShown: next.barShown, docked: next.docked });
    }
    // Docked once at 448 and held down to 440; the settle at 441 is still docked.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual({ barShown: true, docked: true });
  });

  it("undocks on a phone once the page is the hysteresis above the end", () => {
    const prev = { barShown: true, docked: true };
    expect(dockFrame(440, phone, true, prev).docked).toBe(true);
    expect(dockFrame(439.9, phone, true, prev).docked).toBe(false);
    expect(dockFrame(448, phone, true, { barShown: true, docked: false }).docked).toBe(true);
    expect(dockFrame(447.9, phone, true, { barShown: true, docked: false }).docked).toBe(false);
  });

  it("keeps the wide snap exact: the bar must not stay up over a field that has left it", () => {
    const prev = { barShown: true, docked: true };
    expect(dockFrame(1000, wide, true, prev)).toEqual({ p: 1, barShown: true, docked: true });
    expect(dockFrame(999.9, wide, true, prev)).toEqual({ p: 0, barShown: false, docked: false });
  });
});
