import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAR_RISE,
  clampScroll,
  createDockStore,
  crossingTarget,
  DOCK_HYSTERESIS,
  DOCK_REST,
  type DockGeometry,
  type DockState,
  dockFrame,
  dockGeometry,
  focusReveal,
  HIDE_DOWN_PX,
  quietScroll,
  quietScrolling,
  REVEAL_REST,
  REVEAL_UP_PX,
  type RevealMemo,
  readerMoved,
  revealFrame,
  WIDE_BAR_AT,
  WIDE_RANGE,
} from "./dock";

/** A state as the store holds it. The field's reveal is off unless a test says the hero's field is behind the bar. */
const state = (barShown: boolean, docked: boolean, heroAway = false, revealed = false): DockState => ({
  barShown,
  docked,
  heroAway,
  revealed,
});

describe("createDockStore", () => {
  it("starts at rest: no bar, the field in the hero, nothing revealed", () => {
    expect(createDockStore().get()).toEqual({ barShown: false, docked: false, heroAway: false, revealed: false });
    expect(DOCK_REST).toEqual({ barShown: false, docked: false, heroAway: false, revealed: false });
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

  it("tells its listeners when only `heroAway` or only `revealed` changes", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.set(state(true, false));
    store.subscribe(listener);
    store.set(state(true, false, true));
    expect(listener).toHaveBeenCalledTimes(1);
    store.set(state(true, false, true, true));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toEqual(state(true, false, true, true));
    store.set(state(true, false, true, false));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps separate stores independent", () => {
    const a = createDockStore();
    const b = createDockStore();
    a.set(state(true, true));
    expect(b.get()).toEqual(state(false, false));
  });
});

describe("dockGeometry", () => {
  const measured = { end: 1000, barTop: 8, barHeight: 48 };

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

  it("on a wide screen, never reaches the bar's field: it is not there", () => {
    expect(dockGeometry({ ...measured, wide: true, reduce: false }).revealFrom).toBe(Number.POSITIVE_INFINITY);
  });

  it("on a wide screen, ignores the hero's last line and the field's place in the page", () => {
    expect(dockGeometry({ ...measured, wide: true, reduce: false, contentBottom: 990, fieldBottom: 1200 })).toEqual(
      dockGeometry({ ...measured, wide: true, reduce: false }),
    );
  });

  it("below 64rem, brings the bar up when the hero's last line has scrolled clear of where it slides in from", () => {
    // The sliding bar's highest point is its top (8) less the 8 it slides down: the line is clear at its bottom edge.
    const g = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 920, fieldBottom: 1000 });
    expect(BAR_RISE).toBe(8);
    expect(g.barStart).toBe(920);
    expect(g.hysteresis).toBe(8);
  });

  it("below 64rem, has the bar's field usable once the hero's field has its bottom edge at the bar's", () => {
    // The field's bottom is at page position 1000; the bar's bottom (8 + 48) is at the viewport's 56: y = 944.
    const g = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 920, fieldBottom: 1000 });
    expect(g.revealFrom).toBe(944);
    // The bar is up alone for a stretch before that.
    expect(g.revealFrom).toBeGreaterThan(g.barStart);
  });

  it("below 64rem, moves both thresholds with the bar's top, as the safe area does on a notch", () => {
    const flat = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 920, fieldBottom: 1000 });
    const notch = dockGeometry({
      ...measured,
      barTop: measured.barTop + 47,
      wide: false,
      reduce: false,
      contentBottom: 920,
      fieldBottom: 1000,
    });
    expect(notch.barStart).toBe(flat.barStart - 47);
    expect(notch.revealFrom).toBe(flat.revealFrom - 47);
  });

  it("below 64rem, makes the bar's field usable later the taller the bar is", () => {
    const short = dockGeometry({ ...measured, wide: false, reduce: false, barHeight: 40, fieldBottom: 1000 });
    const tall = dockGeometry({ ...measured, wide: false, reduce: false, barHeight: 64, fieldBottom: 1000 });
    expect(short.revealFrom).toBe(952);
    expect(tall.revealFrom).toBe(928);
  });

  it("below 64rem, has no move to time: Reduce Motion changes nothing", () => {
    const input = { ...measured, wide: false, contentBottom: 920, fieldBottom: 1000 };
    expect(dockGeometry({ ...input, reduce: true })).toEqual(dockGeometry({ ...input, reduce: false }));
  });

  it("below 64rem, brings the bar up at the top of a page with no hero line to wait for", () => {
    expect(dockGeometry({ ...measured, wide: false, reduce: false, fieldBottom: 1000 }).barStart).toBe(0);
  });

  it("below 64rem, keeps the bar down while the hero's last line is under where it slides in", () => {
    const early = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 500, fieldBottom: 600 });
    const late = dockGeometry({ ...measured, wide: false, reduce: false, contentBottom: 986, fieldBottom: 1050 });
    expect(early.barStart).toBe(500);
    expect(late.barStart).toBe(986);
  });
});

describe("dockFrame, on a wide screen", () => {
  const geometry: DockGeometry = {
    wide: true,
    start: 400,
    range: 48,
    barStart: 420,
    hysteresis: 8,
    revealFrom: Number.POSITIVE_INFINITY,
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
      '{"barShown":true,"docked":false,"heroAway":false,"revealed":false}',
      '{"barShown":true,"docked":true,"heroAway":false,"revealed":false}',
      '{"barShown":false,"docked":true,"heroAway":false,"revealed":false}',
      '{"barShown":false,"docked":false,"heroAway":false,"revealed":false}',
    ]);
  });
});

describe("dockFrame, below 64rem", () => {
  // The bar up from 420, kept up through 8px short of that.
  const geometry: DockGeometry = {
    wide: false,
    start: 420,
    range: 1,
    barStart: 420,
    hysteresis: 8,
    revealFrom: 470,
  };
  const rest = state(false, false);

  it("rests at the top of the page: no bar, nothing docked", () => {
    expect(dockFrame(0, geometry, false, rest)).toEqual({ p: 0, barShown: false, docked: false });
  });

  it("brings the bar up where the hero's last line has cleared it, and never docks the field", () => {
    expect(dockFrame(419.9, geometry, false, rest)).toEqual({ p: 0, barShown: false, docked: false });
    for (const y of [420, 430, 470, 800, 5000]) {
      expect(dockFrame(y, geometry, false, rest)).toEqual({ p: 0, barShown: true, docked: false });
    }
  });

  it("has no part-way pose and no docked pose, whatever the position or the state before", () => {
    for (let y = -50; y <= 600; y += 3.3) {
      for (const prev of [rest, state(true, false, true, true)]) {
        const frame = dockFrame(y, geometry, false, prev);
        expect(frame.p).toBe(0);
        expect(frame.docked).toBe(false);
      }
    }
  });

  it("is the same under Reduce Motion: there is no move to snap", () => {
    for (const y of [0, 419, 420, 430, 470, 900]) {
      expect(dockFrame(y, geometry, true, rest)).toEqual(dockFrame(y, geometry, false, rest));
    }
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
    expect(dockFrame(411.9, geometry, false, state(true, false)).barShown).toBe(false);
  });

  it("does not flip the bar while a bounce at the top swings across 0", () => {
    const store = createDockStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const y of [0, -60, -4, -90, 0, -30, 0]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set(state(next.barShown, next.docked));
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it("reads a rubber band below the bottom as the bottom: the bar stays up", () => {
    const store = createDockStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(JSON.stringify(store.get())));
    for (const y of [300, 460, 1200, 2000, 2060, 2110, 2060, 2000, 1990]) {
      const next = dockFrame(y, geometry, false, store.get());
      store.set(state(next.barShown, next.docked));
    }
    expect(seen).toEqual(['{"barShown":true,"docked":false,"heroAway":false,"revealed":false}']);
  });
});

describe("clampScroll", () => {
  it("holds a position to the page, from 0 to what it can scroll", () => {
    expect(clampScroll(120, 2000)).toBe(120);
    expect(clampScroll(-30, 2000)).toBe(0);
    expect(clampScroll(2040, 2000)).toBe(2000);
    expect(clampScroll(2000, 2000)).toBe(2000);
    // A page that cannot scroll (or has not been measured) is only its top.
    expect(clampScroll(40, 0)).toBe(0);
    expect(clampScroll(40, -5)).toBe(0);
  });
});

describe("revealFrame", () => {
  // The hero's field is behind the bar from 500 (usable from 508 going down), on a page that scrolls to 2000.
  const geometry: DockGeometry = {
    wide: false,
    start: 420,
    range: 1,
    barStart: 420,
    hysteresis: 8,
    revealFrom: 500,
  };
  const LIMIT = 2000;
  const up = { barShown: true, latched: false };

  /** Runs the frames from a memo, one position each, and returns every memo along the way. */
  const run = (positions: number[], from: RevealMemo = REVEAL_REST, context = up): RevealMemo[] => {
    const seen: RevealMemo[] = [];
    let memo = from;
    for (const y of positions) {
      memo = revealFrame(y, LIMIT, geometry, memo, context);
      seen.push(memo);
    }
    return seen;
  };
  /** A memo of a field that is behind the bar and showing (or not), the run having reached `at`. */
  const behind = (at: number, revealed: boolean): RevealMemo => ({
    heroAway: true,
    revealed,
    dir: revealed ? "up" : "down",
    pivot: at,
    lastY: at,
  });

  it("stays hidden and rebases above the hero-away line", () => {
    const frames = run([0, 100, 400, 507.9]);
    for (const [index, memo] of frames.entries()) {
      expect(memo.heroAway, `frame ${index}`).toBe(false);
      expect(memo.revealed, `frame ${index}`).toBe(false);
    }
    // The baseline follows the page, so a run that starts later counts from where it is.
    expect(frames.at(-1)).toMatchObject({ dir: "down", pivot: 507.9, lastY: 507.9 });
  });

  it("turns heroAway on at revealFrom plus the hysteresis and off at revealFrom", () => {
    expect(DOCK_HYSTERESIS).toBe(8);
    expect(revealFrame(507.9, LIMIT, geometry, REVEAL_REST, up).heroAway).toBe(false);
    expect(revealFrame(508, LIMIT, geometry, REVEAL_REST, up).heroAway).toBe(true);
    expect(revealFrame(500, LIMIT, geometry, behind(520, false), up).heroAway).toBe(true);
    expect(revealFrame(499.9, LIMIT, geometry, behind(520, false), up).heroAway).toBe(false);
  });

  it("starts hidden when the page opens part way down, whatever the direction after", () => {
    const [first] = run([900]);
    expect(first).toMatchObject({ heroAway: true, revealed: false, dir: "down", pivot: 900, lastY: 900 });
  });

  it("never shows heroAway while the bar is down", () => {
    const down = { barShown: false, latched: false };
    for (const memo of run([0, 300, 508, 900, 1500], REVEAL_REST, down)) expect(memo.heroAway).toBe(false);
    expect(revealFrame(900, LIMIT, geometry, behind(900, true), down)).toMatchObject({
      heroAway: false,
      revealed: false,
    });
  });

  it("reveals at exactly REVEAL_UP_PX of upward travel and not one px less", () => {
    expect(REVEAL_UP_PX).toBe(24);
    expect(revealFrame(1000 - (REVEAL_UP_PX - 0.5), LIMIT, geometry, behind(1000, false), up).revealed).toBe(false);
    expect(revealFrame(1000 - REVEAL_UP_PX, LIMIT, geometry, behind(1000, false), up)).toMatchObject({
      revealed: true,
      dir: "up",
      pivot: 1000 - REVEAL_UP_PX,
    });
  });

  it("hides at exactly HIDE_DOWN_PX of downward travel and not one px less", () => {
    expect(HIDE_DOWN_PX).toBe(12);
    expect(revealFrame(1000 + (HIDE_DOWN_PX - 0.5), LIMIT, geometry, behind(1000, true), up).revealed).toBe(true);
    expect(revealFrame(1000 + HIDE_DOWN_PX, LIMIT, geometry, behind(1000, true), up)).toMatchObject({
      revealed: false,
      dir: "down",
      pivot: 1000 + HIDE_DOWN_PX,
    });
  });

  it("counts the travel from the lowest point of the run, so a small step up after a long way down is not a reveal", () => {
    const frames = run([1000, 1400, 1380, 1390, 1378, 1370]);
    expect(frames.map((memo) => memo.revealed)).toEqual([false, false, false, false, false, true]);
    // 22px short of the lowest point (1400) is not enough, 30px is.
    expect(frames[4].pivot).toBe(1400);
    expect(frames[5]).toMatchObject({ dir: "up", pivot: 1370 });
  });

  it("restarts the count on a reversal, and jitter changes nothing", () => {
    // Up 20 (short of 24), a nudge down to a new high point, up 22 from there: still hidden. Then 25: shown.
    const hidden = run([1000, 980, 1010, 988, 985]);
    expect(hidden.map((memo) => memo.revealed)).toEqual([false, false, false, false, true]);
    expect(hidden[2].pivot).toBe(1010);
    // Shown, jitter of up to 11px down and up does not hide it, and a real 12px down does.
    const shown = run([1000, 970, 975, 981, 972, 975, 981], REVEAL_REST);
    expect(shown.map((memo) => memo.revealed)).toEqual([false, true, true, true, true, true, true]);
    expect(run([982], behind(970, true))[0].revealed).toBe(false);
  });

  it("goes round once for a flick down and one back up: one reveal and one hide", () => {
    const frames = run([600, 900, 1500, 1200, 1100, 1180, 1300]);
    const flips = frames.filter((memo, index) => index > 0 && memo.revealed !== frames[index - 1].revealed);
    expect(flips).toHaveLength(2);
    expect(frames.map((memo) => memo.revealed)).toEqual([false, false, false, true, true, false, false]);
  });

  it("hides again, and starts a new run, once the page is back above the hero-away line", () => {
    const frames = run([900, 860, 520, 499, 700, 650]);
    expect(frames.map((memo) => memo.heroAway)).toEqual([true, true, true, false, true, true]);
    expect(frames.map((memo) => memo.revealed)).toEqual([false, true, true, false, false, true]);
  });

  it("reveals nothing for a bottom overshoot and its recoil, which read as the end of the page", () => {
    const frames = run([1900, LIMIT, LIMIT + 60, LIMIT + 120, LIMIT + 60, LIMIT, LIMIT + 6, LIMIT - 1]);
    for (const memo of frames) expect(memo.revealed).toBe(false);
    expect(frames.at(-2)).toMatchObject({ pivot: LIMIT, lastY: LIMIT });
  });

  it("reveals nothing when the baseline was taken at an overshoot and the next frame is at or past the end", () => {
    // A rebase (a toolbar returning, a focus leaving) during a bottom rubber band, held to the page as the hook does.
    const at = clampScroll(LIMIT + 40, LIMIT);
    expect(at).toBe(LIMIT);
    const baseline: RevealMemo = { ...behind(1500, false), pivot: at, lastY: at };
    for (const y of [LIMIT, LIMIT + 40, LIMIT + 120]) {
      const next = revealFrame(y, LIMIT, geometry, baseline, up);
      expect(next.revealed, `at ${y}`).toBe(false);
      expect(next).toMatchObject({ dir: "down", pivot: LIMIT, lastY: LIMIT });
    }
    // The raw number as a baseline is what read as 40px of travel up: the reason the hook holds it to the page.
    const raw: RevealMemo = { ...baseline, pivot: LIMIT + 40, lastY: LIMIT + 40 };
    expect(revealFrame(LIMIT, LIMIT, geometry, raw, up).revealed).toBe(true);
  });

  it("reads a negative scroll as 0", () => {
    expect(revealFrame(-300, LIMIT, geometry, REVEAL_REST, up)).toEqual(REVEAL_REST);
    expect(revealFrame(-4, LIMIT, geometry, behind(900, true), up)).toMatchObject({
      heroAway: false,
      revealed: false,
      lastY: 0,
    });
  });

  it("keeps the state and rebases on a latched frame", () => {
    const latched = { barShown: true, latched: true };
    const before = behind(1000, true);
    expect(revealFrame(1400, LIMIT, geometry, before, latched)).toEqual({ ...before, lastY: 1400, pivot: 1400 });
    // Not even a long way up reveals anything while latched, and nothing is counted afterwards.
    const frames = run([1100, 1000, 700], before, latched);
    for (const memo of frames) expect(memo.revealed).toBe(true);
    const hidden = run([900, 700, 690], behind(1000, false), latched);
    for (const memo of hidden) expect(memo.revealed).toBe(false);
    // The run that follows counts from where the latch left the page.
    expect(revealFrame(690 - 10, LIMIT, geometry, hidden.at(-1) as RevealMemo, up).revealed).toBe(false);
    expect(revealFrame(690 - REVEAL_UP_PX, LIMIT, geometry, hidden.at(-1) as RevealMemo, up).revealed).toBe(true);
  });

  it("lets a latch go once the page is back above the hero-away line, so only one field is on screen", () => {
    const latched = { barShown: true, latched: true };
    const shown = behind(900, true);
    // Still behind the bar (at the line, going up, and with the bar's hysteresis): the latch holds.
    expect(revealFrame(500, LIMIT, geometry, shown, latched)).toMatchObject({ heroAway: true, revealed: true });
    // Above it the hero's field is in view: nothing is away, nothing is revealed, whoever has focus.
    expect(revealFrame(499.9, LIMIT, geometry, shown, latched)).toEqual({
      heroAway: false,
      revealed: false,
      dir: "down",
      pivot: 499.9,
      lastY: 499.9,
    });
    expect(revealFrame(0, LIMIT, geometry, shown, latched)).toMatchObject({ heroAway: false, revealed: false });
    // The bar going down ends it too.
    expect(revealFrame(900, LIMIT, geometry, shown, { barShown: false, latched: true })).toMatchObject({
      heroAway: false,
      revealed: false,
    });
    // A latch with the hero's field in view never turns heroAway on (a hero field in use is not hidden).
    expect(revealFrame(1200, LIMIT, geometry, REVEAL_REST, latched)).toMatchObject({ heroAway: false });
  });

  it("returns the same object for an unchanged frame", () => {
    const hidden = behind(1000, false);
    expect(revealFrame(1000, LIMIT, geometry, hidden, up)).toBe(hidden);
    const shown = behind(1000, true);
    expect(revealFrame(1000, LIMIT, geometry, shown, up)).toBe(shown);
    expect(revealFrame(0, LIMIT, geometry, REVEAL_REST, up)).toBe(REVEAL_REST);
    const latched = { barShown: true, latched: true };
    expect(revealFrame(1000, LIMIT, geometry, shown, latched)).toBe(shown);
  });

  it("holds the field showing for as long as a search is written, however far the page goes down", () => {
    const keep = { barShown: true, latched: false, keep: true };
    const frames = run([900, 1000, 1500, 1800, 1100], REVEAL_REST, keep);
    for (const memo of frames) expect(memo).toMatchObject({ heroAway: true, revealed: true });
    // Above the hero-away line there is only the hero's field.
    expect(revealFrame(300, LIMIT, geometry, frames.at(-1) as RevealMemo, keep)).toMatchObject({
      heroAway: false,
      revealed: false,
    });
  });

  it("lets the rule resume from where the search was cleared, without flipping at once", () => {
    const keep = { barShown: true, latched: false, keep: true };
    const kept = run([900, 1500], REVEAL_REST, keep).at(-1) as RevealMemo;
    // Cleared at 1500: the next frame, at the same place or a little on, does not hide it...
    expect(revealFrame(1500, LIMIT, geometry, kept, up).revealed).toBe(true);
    expect(revealFrame(1500 + HIDE_DOWN_PX - 1, LIMIT, geometry, kept, up).revealed).toBe(true);
    // ...and HIDE_DOWN_PX of travel down from there does.
    expect(revealFrame(1500 + HIDE_DOWN_PX, LIMIT, geometry, kept, up).revealed).toBe(false);
  });

  it("returns the same object for an unchanged frame with a search kept", () => {
    const keep = { barShown: true, latched: false, keep: true };
    const kept = revealFrame(900, LIMIT, geometry, REVEAL_REST, keep);
    expect(revealFrame(900, LIMIT, geometry, kept, keep)).toBe(kept);
  });
});

describe("focusReveal", () => {
  const away: RevealMemo = { heroAway: true, revealed: false, dir: "down", pivot: 900, lastY: 880 };

  it("shows the bar's field as a run going up from the position, once the hero's field is behind the bar", () => {
    expect(focusReveal(away, 700)).toEqual({ heroAway: true, revealed: true, dir: "up", pivot: 700, lastY: 700 });
  });

  it("changes nothing while the hero's field is in view, or when the bar's is showing already", () => {
    const home: RevealMemo = { ...REVEAL_REST, lastY: 40, pivot: 40 };
    expect(focusReveal(home, 40)).toBe(home);
    const showing: RevealMemo = { heroAway: true, revealed: true, dir: "up", pivot: 700, lastY: 710 };
    expect(focusReveal(showing, 705)).toBe(showing);
  });
});

describe("crossingTarget", () => {
  it("is the hero's field from 64rem, whatever the scroll position says", () => {
    expect(crossingTarget({ wide: true, heroAway: false })).toBe("hero");
    expect(crossingTarget({ wide: true, heroAway: true })).toBe("hero");
  });

  it("is the hero's field below 64rem while it is in view, and the bar's copy once it is behind the bar", () => {
    expect(crossingTarget({ wide: false, heroAway: false })).toBe("hero");
    expect(crossingTarget({ wide: false, heroAway: true })).toBe("bar");
  });
});

describe("quietScroll", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the scroll once, reads as quiet for two frames, and then clears", () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    const scroll = vi.fn();
    expect(quietScrolling()).toBe(false);
    quietScroll(scroll);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(quietScrolling()).toBe(true);
    // The first frame queues the second; the flag clears when that one has run.
    frames.shift()?.();
    expect(quietScrolling()).toBe(true);
    frames.shift()?.();
    expect(quietScrolling()).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("stays quiet until the last of overlapping scrolls has had its two frames", () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    quietScroll(() => {});
    quietScroll(() => {});
    // The first scroll's frames run out; the second's are still to come.
    frames.shift()?.();
    frames.shift()?.();
    expect(quietScrolling()).toBe(true);
    for (let frame = frames.shift(); frame; frame = frames.shift()) frame();
    expect(quietScrolling()).toBe(false);
  });
});

describe("readerMoved", () => {
  const base = { from: 292, scrollY: 292, limit: 800, lastLimit: 800 };

  it("reads no travel under a pixel as no move", () => {
    expect(readerMoved(base)).toBe(false);
    expect(readerMoved({ ...base, scrollY: 292.6 })).toBe(false);
  });

  it("reads travel nothing else accounts for as the reader's, up or down", () => {
    expect(readerMoved({ ...base, scrollY: 222 })).toBe(true);
    expect(readerMoved({ ...base, scrollY: 340 })).toBe(true);
  });

  it("reads a page held to a nearer end as the layout's", () => {
    // The page shortened to 0 and the position went with it, to the new end.
    expect(readerMoved({ ...base, scrollY: 0, limit: 0 })).toBe(false);
    // The end is 150 now and the browser left the page there.
    expect(readerMoved({ ...base, scrollY: 150, limit: 150 })).toBe(false);
    // Still short of the new end and further than the anchor or the end can say: the reader's.
    expect(readerMoved({ ...base, scrollY: 40, limit: 150 })).toBe(true);
  });

  it("reads travel equal to what the anchor moved as scroll anchoring", () => {
    expect(readerMoved({ ...base, scrollY: 222, anchorMoved: -70 })).toBe(false);
    expect(readerMoved({ ...base, scrollY: 223, anchorMoved: -70 })).toBe(false);
    expect(readerMoved({ ...base, scrollY: 218, anchorMoved: -70 })).toBe(true);
  });

  it("reads travel equal to how far the end of the page moved as the layout's", () => {
    // Content above the reader's place went, and the page followed it up.
    expect(readerMoved({ ...base, scrollY: 222, limit: 730 })).toBe(false);
    expect(readerMoved({ ...base, scrollY: 222, limit: 800 + 3 })).toBe(true);
  });

  it("does not let a small change of the page hide the reader's own scroll", () => {
    // The page got 2px longer in the frame the reader scrolled 70px up.
    expect(readerMoved({ ...base, scrollY: 222, limit: 802 })).toBe(true);
  });

  it("reads a scroll the page made itself as the layout's", () => {
    expect(readerMoved({ ...base, scrollY: 100, quiet: true })).toBe(false);
  });

  it("reads a move in the direction the end of the page moved, by no more than it moved, as a typed key's", () => {
    // A key filtered the board: 888px came off the page, 264 of them above the reader's place, and the browser moved
    // the page up by that much; the card it held was one the search removed, so the anchor has nothing to read.
    const typed = { from: 591, scrollY: 327, limit: 3147, lastLimit: 4035, anchorMoved: 0 };
    expect(readerMoved(typed)).toBe(true);
    expect(readerMoved({ ...typed, typing: true })).toBe(false);
    // Held to the new end from a position near the old one.
    expect(readerMoved({ from: 4000, scrollY: 3147, limit: 3147, lastLimit: 4035, typing: true })).toBe(false);
    // A page that got longer takes the same.
    expect(readerMoved({ from: 300, scrollY: 400, limit: 1000, lastLimit: 700, typing: true })).toBe(false);
  });

  it("does not let a typed key hide a scroll that the page's change cannot account for", () => {
    const typed = { from: 591, limit: 3147, lastLimit: 4035, typing: true };
    // Against the way the end moved, or by more than it moved.
    expect(readerMoved({ ...typed, scrollY: 700 })).toBe(true);
    expect(readerMoved({ ...typed, from: 3500, scrollY: 100 })).toBe(true);
    // The page's end did not move at all: nothing changed the page, so the scroll is the reader's.
    expect(readerMoved({ from: 591, scrollY: 327, limit: 3147, lastLimit: 3147, typing: true })).toBe(true);
  });

  it("holds the position to the page, so an overshoot is no travel", () => {
    // iOS reports 40px past the end that the last frame was clamped to.
    expect(readerMoved({ from: 800, scrollY: 840, limit: 800, lastLimit: 800 })).toBe(false);
    expect(readerMoved({ from: 0, scrollY: -30, limit: 800, lastLimit: 800 })).toBe(false);
    // And one past a nearer end is the layout's clamp.
    expect(readerMoved({ from: 600, scrollY: 640, limit: 560, lastLimit: 800 })).toBe(false);
  });
});
