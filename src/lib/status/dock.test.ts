import { describe, expect, it, vi } from "vitest";
import {
  BAR_RISE,
  createDockStore,
  DOCK_HYSTERESIS,
  DOCK_LEAD_MS,
  DOCK_MS,
  DOCK_REST,
  type DockGeometry,
  type DockState,
  dockFrame,
  dockGeometry,
  PHONE_GAP,
  transitionMs,
  WIDE_BAR_AT,
  WIDE_RANGE,
} from "./dock";

/** A state as the store holds it: `settled` follows `docked` unless a test says the move is still on. */
const state = (barShown: boolean, docked: boolean, settled = docked): DockState => ({ barShown, docked, settled });

describe("createDockStore", () => {
  it("starts at rest: no bar, the field still in the hero", () => {
    expect(createDockStore().get()).toEqual({ barShown: false, docked: false, settled: false });
    expect(DOCK_REST).toEqual({ barShown: false, docked: false, settled: false });
  });

  it("returns what was set and tells its listeners once per change", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(state(true, false));
    expect(store.get()).toEqual(state(true, false));
    expect(listener).toHaveBeenCalledTimes(1);
    store.set(state(true, true));
    expect(store.get()).toEqual(state(true, true));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stays silent, and keeps the same state object, when nothing changed", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const rest = store.get();
    store.set(state(false, false));
    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(rest);
    store.set(state(true, true));
    const shown = store.get();
    store.set(state(true, true));
    expect(store.get()).toBe(shown);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops telling a listener that unsubscribed, and only that one", () => {
    const store = createDockStore();
    const kept = vi.fn();
    const dropped = vi.fn();
    store.subscribe(kept);
    const unsubscribe = store.subscribe(dropped);
    store.set(state(true, false));
    unsubscribe();
    store.set(state(false, false));
    expect(kept).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it("lets a listener unsubscribe itself while being told", () => {
    const store = createDockStore();
    const later = vi.fn();
    const unsubscribe = store.subscribe(() => unsubscribe());
    store.subscribe(later);
    store.set(state(true, false));
    store.set(state(false, false));
    expect(later).toHaveBeenCalledTimes(2);
  });

  it("tells its listeners when only `settled` changes, which is the placeholder's cue", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.set(state(true, true, false));
    store.subscribe(listener);
    store.set(state(true, true, true));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(state(true, true, true));
  });

  it("keeps separate stores independent", () => {
    const a = createDockStore();
    const b = createDockStore();
    a.set(state(true, true));
    expect(b.get()).toEqual(state(false, false));
  });
});

describe("dockGeometry", () => {
  const measured = { end: 1000, pin: 10, barTop: 8, barHeight: 48 };

  it("on a wide screen, makes one move of WIDE_RANGE that ends at `end`", () => {
    const g = dockGeometry({ ...measured, wide: true, reduce: false });
    expect(g.wide).toBe(true);
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
    expect(g).toMatchObject({ start: 952, range: 48, barStart: 1000, hysteresis: 0 });
  });

  it("on a phone, raises the bar early and alone, then docks the field where it reaches the bar's bottom edge", () => {
    const g = dockGeometry({ ...measured, wide: false, reduce: false });
    // The bar at 1000 - (48 + 24 - 2); the field docks when its top (pin + end - y) meets the bar's bottom (56): y = 954.
    expect(g).toEqual({
      wide: false,
      start: 954,
      range: 46,
      barStart: 930,
      hysteresis: 8,
      dockAt: 954,
      undockAt: 946,
    });
    expect(PHONE_GAP).toBe(24);
    // Alone for PHONE_GAP px of scrolling, then the field has at least 46px left to rise to its pin.
    expect(g.start - g.barStart).toBe(PHONE_GAP);
    expect(g.range).toBeGreaterThanOrEqual(46);
  });

  it("on a phone, docks at a position and releases DOCK_HYSTERESIS px short of it, never above it", () => {
    const g = dockGeometry({ ...measured, wide: false, reduce: false });
    expect(DOCK_HYSTERESIS).toBe(8);
    expect(g.dockAt - g.undockAt).toBe(DOCK_HYSTERESIS);
    // A docked field is released with the bar still up: the bar's own hysteresis is not shorter.
    expect(g.undockAt).toBeGreaterThanOrEqual(g.barStart - g.hysteresis);
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
    expect(roomy).toMatchObject({ start: 954, range: 46, barStart: 930, hysteresis: 8 });
  });

  it("on a phone, holds the bar back until the hero's last line has scrolled clear of where it slides in", () => {
    // The line ends at 986, so it is clear of the bar (top 8, less the 8 it slides down) at 986, after the usual 930.
    const g = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 986 });
    expect(BAR_RISE).toBe(8);
    expect(g.barStart).toBe(986);
    // The field docks with the bar, over the scrolling that is left.
    expect(g.start).toBe(986);
    expect(g.dockAt).toBe(986);
    expect(g.range).toBe(14);
    expect(g.hysteresis).toBe(8);
  });

  it("on a phone, with the spacing the page gives it, the bar and the dock each get their own stretch", () => {
    // The live line ends barHeight + BAR_RISE + PHONE_GAP above the field (its top is end + pin), on a phone
    // 375, 390, 412 or 430 wide alike: the geometry depends on none of the width.
    const fieldTop = measured.end + measured.pin;
    const contentBottom = fieldTop - (measured.barHeight + BAR_RISE + PHONE_GAP);
    const g = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom });
    // The line clears the bar exactly when the field is PHONE_GAP under the bar's bottom edge: nothing waits.
    expect(g.barStart).toBe(measured.end - (measured.barHeight + PHONE_GAP - (measured.pin - measured.barTop)));
    expect(g).toEqual(dockGeometry({ ...measured, wide: false, reduce: false }));
    // The bar is up alone for PHONE_GAP px of scrolling, then the field docks as it reaches the bar.
    expect(g.start - g.barStart).toBe(PHONE_GAP);
    expect(g.dockAt).toBe(measured.end - (measured.barHeight - (measured.pin - measured.barTop)));
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
    // The field docks with its top just at the bar's bottom edge, and has the rest of the way to its pin.
    expect(fieldTopAt(g.dockAt)).toBe(barBottom);
    expect(fieldTopAt(g.start + g.range)).toBe(measured.pin);
    // Bar first: at every scroll before the dock the frame has the bar up (past barStart) and the field not docked.
    for (let y = g.barStart; y < g.dockAt; y += 1) {
      const frame = dockFrame(y, g, false, state(false, false));
      expect(frame.barShown).toBe(true);
      expect(frame.docked).toBe(false);
    }
    expect(dockFrame(g.barStart - 1, g, false, state(false, false)).barShown).toBe(false);
  });

  it("on a phone at a larger text size, the dock still happens below the bar, and the bar still has PHONE_GAP px to itself", () => {
    // A 32px root: the bar is 96px tall and 16px from the top, the field (88px) pins 2px under that.
    const big = { end: 1000, pin: 18, barTop: 16, barHeight: 96, fieldHeight: 88 };
    const g = dockGeometry({ ...big, wide: false, reduce: false });
    expect(g.start - g.barStart).toBe(PHONE_GAP);
    const fieldTopAt = (y: number) => big.end + big.pin - y;
    expect(fieldTopAt(g.barStart) - (big.barTop + big.barHeight)).toBe(PHONE_GAP);
    expect(fieldTopAt(g.dockAt)).toBe(big.barTop + big.barHeight);
    expect(g.range).toBe(94);
  });

  it("on a phone, never docks before the bar is up, nor lets its range reach zero", () => {
    const late = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 1100 });
    expect(late.start).toBe(late.barStart);
    expect(late.dockAt).toBe(late.barStart);
    expect(late.range).toBe(1);
  });

  it("on a wide screen, ignores the hero's last line", () => {
    expect(dockGeometry({ ...measured, wide: true, reduce: false, contentBottom: 990 })).toEqual(
      dockGeometry({ ...measured, wide: true, reduce: false }),
    );
  });

  it("on a phone under Reduce Motion, docks where the field reaches its pin, and holds only as far as the bar has room", () => {
    const g = dockGeometry({ ...measured, wide: false, reduce: true });
    // The bar is 48 high, the field 44, and the field pins 2 under the bar's top: 2px of room.
    expect(g).toMatchObject({ barStart: 930, hysteresis: 8, dockAt: 1000, undockAt: 998 });
    // The bar comes up as it does with motion; only the dock waits for the pin.
    expect(g.barStart).toBe(dockGeometry({ ...measured, wide: false, reduce: false }).barStart);
  });

  it("on a phone under Reduce Motion, the hold is the bar's height less the field's and its inset, never negative", () => {
    const hold = (over: Partial<Parameters<typeof dockGeometry>[0]>) => {
      const g = dockGeometry({ ...measured, wide: false, reduce: true, ...over });
      return g.dockAt - g.undockAt;
    };
    expect(hold({})).toBe(2);
    expect(hold({ barHeight: 64 })).toBe(18);
    expect(hold({ pin: 12 })).toBe(0);
    expect(hold({ fieldHeight: 40 })).toBe(6);
    // A field taller than the room the bar has around it: nothing to hold, not a negative hold.
    expect(hold({ barHeight: 40 })).toBe(0);
    expect(hold({ fieldHeight: 90 })).toBe(0);
  });

  it("on a phone under Reduce Motion, a released field has not left the bar yet", () => {
    for (const over of [{}, { barHeight: 64 }, { pin: 12 }, { fieldHeight: 40 }, { barHeight: 40 }]) {
      const input = { ...measured, fieldHeight: 44, ...over };
      const g = dockGeometry({ ...input, wide: false, reduce: true });
      // Just short of the release, the field's bottom edge is as far below its pinned one as the page has moved.
      const bottomAtRelease = input.pin + input.fieldHeight + (input.end - g.undockAt);
      const barBottom = input.barTop + input.barHeight;
      // Within the bar, unless the bar is too short for the pinned field in the first place.
      if (input.pin + input.fieldHeight <= barBottom) expect(bottomAtRelease).toBeLessThanOrEqual(barBottom);
    }
  });
});

describe("transitionMs", () => {
  it("reads seconds and milliseconds, and the longest of a list", () => {
    expect(transitionMs("0.18s")).toBeCloseTo(180, 5);
    expect(transitionMs("180ms")).toBe(180);
    expect(transitionMs("0s, 0.25s")).toBe(250);
    expect(transitionMs("150ms, 0.1s")).toBe(150);
  });

  it("is 0 for no transition", () => {
    expect(transitionMs("0s")).toBe(0);
    expect(transitionMs("0s, 0ms")).toBe(0);
    expect(transitionMs("")).toBe(0);
  });

  it("agrees with the 180ms the stylesheet names", () => {
    expect(DOCK_MS).toBe(180);
    expect(transitionMs(`${DOCK_MS}ms`)).toBe(DOCK_MS);
  });

  it("agrees with the 50ms lead the stylesheet names", () => {
    expect(DOCK_LEAD_MS).toBe(50);
    expect(transitionMs(`${DOCK_LEAD_MS}ms`)).toBe(DOCK_LEAD_MS);
  });
});

describe("dockFrame, on a wide screen", () => {
  const geometry: DockGeometry = {
    wide: true,
    start: 400,
    range: 48,
    barStart: 420,
    hysteresis: 8,
    dockAt: 448,
    undockAt: 448,
  };
  const rest = state(false, false);

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

  it("reads a position above the page as the top", () => {
    expect(dockFrame(-120, geometry, false, rest)).toEqual({ p: 0, barShown: false, docked: false });
  });

  it("latches docked=true part way when it was already docked (scrolling back up)", () => {
    expect(dockFrame(424, geometry, false, state(true, true))).toEqual({ p: 0.5, barShown: true, docked: true });
  });

  it("latches docked=false part way when it was not yet docked (scrolling down)", () => {
    expect(dockFrame(440, geometry, false, state(true, false)).docked).toBe(false);
  });

  it("undocks only once back at p 0", () => {
    const prev = state(true, true);
    expect(dockFrame(401, geometry, false, prev).docked).toBe(true);
    expect(dockFrame(400, geometry, false, prev).docked).toBe(false);
  });

  it("rounds p to steps of 1/500 so a scroll of a fraction of a pixel is not a change", () => {
    // Smoothstep at 0.1 px of 48 is about 1.3e-5: under a step, so it reads as 0.
    const early = dockFrame(400.1, geometry, false, state(false, true));
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
    const up = state(true, false);
    expect(dockFrame(412, geometry, false, up).barShown).toBe(true);
    expect(dockFrame(411.9, geometry, false, up).barShown).toBe(false);
    expect(dockFrame(412, geometry, false, rest).barShown).toBe(false);
    expect(dockFrame(420, geometry, false, rest).barShown).toBe(true);
  });

  it("under Reduce Motion, snaps p to its two poses, with no hold: the bar must not stay up over a field that left it", () => {
    const snapped = { ...geometry, hysteresis: 0, barStart: 448 };
    expect(dockFrame(424, snapped, true, rest).p).toBe(0);
    expect(dockFrame(447.9, snapped, true, rest).p).toBe(0);
    expect(dockFrame(448, snapped, true, rest)).toEqual({ p: 1, barShown: true, docked: true });
    expect(dockFrame(447.9, snapped, true, state(true, true))).toEqual({ p: 0, barShown: false, docked: false });
  });

  it("feeds the store: a scroll down and back up yields the expected changes", () => {
    const store = createDockStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(JSON.stringify(store.get())));
    for (const y of [0, 410, 421, 430, 448, 460, 430, 405, 300, 0]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set(state(next.barShown, next.docked));
    }
    expect(seen).toEqual([
      '{"barShown":true,"docked":false,"settled":false}',
      '{"barShown":true,"docked":true,"settled":true}',
      '{"barShown":false,"docked":true,"settled":true}',
      '{"barShown":false,"docked":false,"settled":false}',
    ]);
  });
});

describe("dockFrame, on a phone", () => {
  // The bar up at 420, the field docked from 448 (where it reaches the bar), released below 440.
  const geometry: DockGeometry = {
    wide: false,
    start: 448,
    range: 46,
    barStart: 420,
    hysteresis: 8,
    dockAt: 448,
    undockAt: 440,
  };
  const rest = state(false, false);

  it("rests at the top of the page: no bar, not docked", () => {
    expect(dockFrame(0, geometry, false, rest)).toEqual({ p: 0, barShown: false, docked: false });
  });

  it("brings the bar up first and alone, then docks the field", () => {
    expect(dockFrame(430, geometry, false, rest)).toEqual({ p: 0, barShown: true, docked: false });
    expect(dockFrame(447.9, geometry, false, state(true, false)).docked).toBe(false);
    expect(dockFrame(448, geometry, false, state(true, false))).toEqual({ p: 1, barShown: true, docked: true });
  });

  it("does not follow the scroll once docked: past the threshold there is only the one pose", () => {
    for (const y of [448, 460, 494, 800, 5000]) {
      expect(dockFrame(y, geometry, false, rest)).toMatchObject({ p: 1, docked: true });
    }
  });

  it("has no part-way pose: p is 0 or 1 whatever the position", () => {
    for (let y = -50; y <= 600; y += 3.3) {
      expect([0, 1]).toContain(dockFrame(y, geometry, false, rest).p);
      expect([0, 1]).toContain(dockFrame(y, geometry, false, state(true, true)).p);
    }
  });

  it("releases a docked field only DOCK_HYSTERESIS px short of where it docked", () => {
    const docked = state(true, true);
    expect(dockFrame(440, geometry, false, docked).docked).toBe(true);
    expect(dockFrame(439.9, geometry, false, docked).docked).toBe(false);
    // And a field that is not docked does not dock short of the threshold, whatever the hysteresis.
    expect(dockFrame(447.9, geometry, false, state(true, false)).docked).toBe(false);
  });

  it("does not flicker the field when a finger rests within a few px of where it docks", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const y of [447, 448, 447.5, 448.4, 446, 449, 444, 448, 441, 442, 440]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set(state(next.barShown, next.docked));
    }
    // The bar once (the first stop is already past 420), the dock once: nothing after.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual(state(true, true));
  });

  it("docks once and releases once over a flick down and back, however few frames it was seen in", () => {
    const store = createDockStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(JSON.stringify(store.get())));
    // One frame sees the page far past the dock; the next, far back above the bar.
    for (const y of [0, 900, 900, 5, 0]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set(state(next.barShown, next.docked));
    }
    expect(seen).toEqual([
      '{"barShown":true,"docked":true,"settled":true}',
      '{"barShown":false,"docked":false,"settled":false}',
    ]);
  });

  it("reads a rubber band above the top as the top, whatever the state before", () => {
    for (const prev of [rest, state(true, true)]) {
      const frame = dockFrame(-300, geometry, false, prev);
      expect(frame).toEqual({ p: 0, barShown: false, docked: false });
    }
  });

  it("reads a rubber band below the bottom as the bottom: docked, bar up, and nothing flips", () => {
    const store = createDockStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(JSON.stringify(store.get())));
    // A fling down to the bottom (2000), the bounce back past it, and the settle.
    for (const y of [300, 460, 1200, 2000, 2060, 2110, 2060, 2000, 1990]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set(state(next.barShown, next.docked));
    }
    expect(seen).toEqual(['{"barShown":true,"docked":true,"settled":true}']);
  });

  it("does not flip the bar or the field while a bounce at the top swings across 0", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const y of [0, -60, -4, -90, 0, -30, 0]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set(state(next.barShown, next.docked));
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not flicker the bar when a finger rests within a pixel of where it comes up", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const y of [419.4, 420, 419.6, 420.2, 419, 420.4, 415, 420, 412]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set(state(next.barShown, next.docked));
    }
    // Up once at 420 and held through the hysteresis: 412 is as low as it goes.
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("dockFrame, on a phone under Reduce Motion", () => {
  // Docks where the field pins (448), and is released 2px short of that.
  const geometry: DockGeometry = {
    wide: false,
    start: 400,
    range: 48,
    barStart: 420,
    hysteresis: 8,
    dockAt: 448,
    undockAt: 446,
  };

  it("keeps the bar's phase and steps the field in only at the pin", () => {
    expect(dockFrame(430, geometry, true, state(false, false))).toEqual({ p: 0, barShown: true, docked: false });
    expect(dockFrame(447.9, geometry, true, state(true, false)).docked).toBe(false);
    expect(dockFrame(448, geometry, true, state(true, false))).toEqual({ p: 1, barShown: true, docked: true });
  });

  it("holds the dock through the hold, so a finger at the pin cannot flip the field, and no further", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const y of [447, 448, 447.5, 448.4, 446.5, 449, 446, 448, 447]) {
      const next = dockFrame(y, geometry, true, store.get());
      store.set(state(next.barShown, next.docked));
    }
    // The bar, then docked once at 448 and held down to 446.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual(state(true, true));
    expect(dockFrame(445.9, geometry, true, store.get()).docked).toBe(false);
  });
});
