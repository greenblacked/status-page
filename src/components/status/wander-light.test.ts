import { describe, expect, it } from "vitest";
import { WANDER_ROUTES, WANDER_TICK_MS, wanderAt } from "./wander-light";

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
