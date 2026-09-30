import { describe, expect, it, vi } from "vitest";
import {
  createDockStore,
  DOCK_REST,
  type DockGeometry,
  dockFrame,
  dockGeometry,
  PHONE_GAP,
  PHONE_RANGE,
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

  it("on a phone, merges over PHONE_RANGE px and raises the bar early, clear of the field", () => {
    const g = dockGeometry({ ...measured, wide: false, reduce: false });
    expect(g).toEqual({ start: 944, range: 56, barStart: 934, hysteresis: 8 });
    expect(PHONE_RANGE).toBe(56);
    expect(PHONE_GAP).toBe(20);
  });

  it("on a phone, the bar comes up earlier the taller it is", () => {
    const short = dockGeometry({ ...measured, wide: false, reduce: false, barHeight: 40 });
    const tall = dockGeometry({ ...measured, wide: false, reduce: false, barHeight: 64 });
    expect(short.barStart).toBe(942);
    expect(tall.barStart).toBe(918);
  });

  it("on a phone, the gap counts from where the field pins relative to the bar's own top", () => {
    const g = dockGeometry({ end: 500, wide: false, reduce: false, pin: 16, barTop: 4, barHeight: 48 });
    // 500 - (48 + 20 - (16 - 4))
    expect(g.barStart).toBe(444);
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
