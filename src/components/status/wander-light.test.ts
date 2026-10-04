import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWanderLight, WANDER_ROUTES, WANDER_TICK_MS, wanderAt } from "./wander-light";

/** The shortest loop the page gives a card, in seconds (src/components/status/wander-light.ts). */
const SHORTEST_LOOP_S = 44;

describe("wanderAt", () => {
  it("starts each route at its first stop and reaches every stop on time", () => {
    for (const [route, stops] of WANDER_ROUTES.entries()) {
      for (const [at, x, y] of stops) {
        const place = wanderAt(route, at);
        expect(place.x).toBeCloseTo(x, 10);
        expect(place.y).toBeCloseTo(y, 10);
      }
    }
  });

  it("runs the loop back on every second turn, and repeats after two", () => {
    for (const route of WANDER_ROUTES.keys()) {
      for (const progress of [0.1, 0.37, 0.5, 0.92]) {
        const forward = wanderAt(route, progress);
        const back = wanderAt(route, 2 - progress);
        expect(back.x).toBeCloseTo(forward.x, 10);
        expect(back.y).toBeCloseTo(forward.y, 10);
        const later = wanderAt(route, progress + 2);
        expect(later.x).toBeCloseTo(forward.x, 10);
        expect(later.y).toBeCloseTo(forward.y, 10);
      }
    }
  });

  it("stays inside the reach the glint has (38% of the card) and takes any route number or time", () => {
    for (let route = -2; route < 9; route++) {
      for (let progress = 0; progress < 6; progress += 0.013) {
        const place = wanderAt(route, progress);
        expect(Math.abs(place.x)).toBeLessThanOrEqual(0.38 + 1e-9);
        expect(Math.abs(place.y)).toBeLessThanOrEqual(0.38 + 1e-9);
      }
    }
    expect(wanderAt(0, 12.5)).toEqual(wanderAt(0, 0.5));
    expect(Number.isFinite(wanderAt(1, 1e7).x)).toBe(true);
  });

  it("moves slowly enough that a step is a few pixels of a soft gradient", () => {
    // At the shortest loop, in one step of the page's timer: a fraction of the card, never more than this.
    const step = WANDER_TICK_MS / 1000 / SHORTEST_LOOP_S;
    let widest = 0;
    for (const route of WANDER_ROUTES.keys()) {
      for (let progress = 0; progress < 2; progress += step / 4) {
        const a = wanderAt(route, progress);
        const b = wanderAt(route, progress + step);
        widest = Math.max(widest, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      }
    }
    // 6% of a 380px card is about 23px, on a light that fades over 200.
    expect(widest).toBeLessThan(0.06);
    expect(widest).toBeGreaterThan(0);
  });

  it("steps about twice a second, so the page is damaged on a few frames a second, not on all of them", () => {
    expect(WANDER_TICK_MS).toBeGreaterThanOrEqual(250);
    expect(WANDER_TICK_MS).toBeLessThanOrEqual(1000);
  });
});

/** A card, as far as the page's timer sees it: a size, a mark, two custom properties and whether it is on the page. */
function fakeCard() {
  const props = new Map<string, string>();
  const card = {
    isConnected: true,
    offsetWidth: 400,
    offsetHeight: 300,
    dataset: {} as Record<string, string | undefined>,
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => void props.delete(name),
    },
    matches: (selector: string) => selector === ".spotlight",
    querySelectorAll: () => [],
    props,
  };
  return card;
}

describe("startWanderLight", () => {
  let hidden: boolean;
  let tilt: string | undefined;
  let layer: { content: string; display: string };
  let visibility: (() => void) | undefined;
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    tilt = undefined;
    layer = { content: '""', display: "block" };
    visibility = undefined;
    clock = 100;
    vi.stubGlobal("HTMLElement", class {});
    vi.stubGlobal("window", {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (id: number) => clearInterval(id),
      matchMedia: () => ({ matches: true }),
    });
    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
      },
      documentElement: {
        get dataset() {
          return { tilt };
        },
      },
      addEventListener: (_: string, fn: () => void) => {
        visibility = fn;
      },
      removeEventListener: () => {
        visibility = undefined;
      },
    });
    vi.stubGlobal("getComputedStyle", () => layer);
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function start(...cards: ReturnType<typeof fakeCard>[]) {
    // The page checks `instanceof HTMLElement`, so the fakes borrow the stubbed class's prototype.
    const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
    for (const card of cards) Object.setPrototypeOf(card, proto);
    const root = { ...fakeCard(), matches: () => false, querySelectorAll: () => cards };
    Object.setPrototypeOf(root, proto);
    return startWanderLight(root as never, { random: () => 0.3, now: () => clock });
  }

  it("places each card's light and marks it, then moves it as the clock runs", () => {
    const card = fakeCard();
    start(card);
    expect(card.dataset.wander).toBeDefined();
    const first = card.props.get("--wander-x");
    expect(first).toMatch(/^-?\d+px$/);
    clock += 10;
    vi.advanceTimersByTime(WANDER_TICK_MS);
    expect(card.props.get("--wander-x")).not.toBe(first);
  });

  it("takes the light off while the page is hidden, and puts it back in its place when the page returns", () => {
    const card = fakeCard();
    start(card);
    hidden = true;
    visibility?.();
    expect(card.dataset.wander).toBeUndefined();
    clock += 30;
    vi.advanceTimersByTime(WANDER_TICK_MS * 4);
    expect(card.dataset.wander).toBeUndefined();
    hidden = false;
    visibility?.();
    expect(card.dataset.wander).toBeDefined();
  });

  it("takes the light off while Tilt drives the glint, and while the style sheet hides the layer", () => {
    const card = fakeCard();
    start(card);
    tilt = "on";
    vi.advanceTimersByTime(WANDER_TICK_MS);
    expect(card.dataset.wander).toBeUndefined();
    tilt = undefined;
    vi.advanceTimersByTime(WANDER_TICK_MS);
    expect(card.dataset.wander).toBeDefined();
    layer = { content: "none", display: "none" };
    vi.advanceTimersByTime(WANDER_TICK_MS);
    expect(card.dataset.wander).toBeUndefined();
  });

  it("forgets a card that left the page even while the light is paused", () => {
    const card = fakeCard();
    const stop = start(card);
    const placed = card.props.get("--wander-x");
    card.isConnected = false;
    hidden = true;
    vi.advanceTimersByTime(WANDER_TICK_MS);
    // Had it been kept, bringing it back would give it its light again.
    card.isConnected = true;
    hidden = false;
    clock += 20;
    vi.advanceTimersByTime(WANDER_TICK_MS * 2);
    expect(card.props.get("--wander-x")).toBe(placed);
    stop();
  });
});
