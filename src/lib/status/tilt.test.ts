import { describe, expect, it, vi } from "vitest";
import {
  BASELINE_TAU_MS,
  createTiltController,
  DEADBAND,
  gravityFromOrientation,
  LIGHT_RANGE,
  LIGHT_SIGN,
  lightFromTilt,
  lowPass,
  MIN_APPLY_INTERVAL_MS,
  needsPermission,
  parseTiltPreference,
  readTiltLighting,
  serializeTiltPreference,
  TILT_STORAGE_KEY,
  tiltFromStorageEvent,
  tiltSupported,
  toScreen,
  writeTiltLighting,
} from "./tilt";

const refused = () => {
  throw new Error("storage refused");
};

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("tilt lighting preference", () => {
  it("defaults to off and round-trips", () => {
    expect(parseTiltPreference(null)).toBe(false);
    expect(parseTiltPreference("garbage")).toBe(false);
    expect(parseTiltPreference(serializeTiltPreference(true))).toBe(true);
    expect(parseTiltPreference(serializeTiltPreference(false))).toBe(false);
  });

  it("reads and writes the stored choice", () => {
    const store = memory();
    expect(readTiltLighting(() => store)).toBe(false);
    writeTiltLighting(() => store, true);
    expect(store.items.get(TILT_STORAGE_KEY)).toBe("on");
    expect(readTiltLighting(() => store)).toBe(true);
    writeTiltLighting(() => store, false);
    expect(store.items.get(TILT_STORAGE_KEY)).toBe("off");
    expect(readTiltLighting(() => store)).toBe(false);
  });

  it("falls back to off when storage is refused, and keeps going", () => {
    expect(readTiltLighting(refused)).toBe(false);
    expect(() => writeTiltLighting(refused, true)).not.toThrow();
    expect(
      readTiltLighting(() => ({
        getItem: refused,
        setItem: refused,
      })),
    ).toBe(false);
  });

  it("follows other tabs, and a cleared storage puts the default back", () => {
    expect(tiltFromStorageEvent({ key: TILT_STORAGE_KEY, newValue: "on" })).toBe(true);
    expect(tiltFromStorageEvent({ key: TILT_STORAGE_KEY, newValue: "off" })).toBe(false);
    expect(tiltFromStorageEvent({ key: TILT_STORAGE_KEY, newValue: null })).toBe(false);
    expect(tiltFromStorageEvent({ key: null, newValue: null })).toBe(false);
    expect(tiltFromStorageEvent({ key: "status-bar:reduce-glass", newValue: "on" })).toBeNull();
  });
});

describe("gravityFromOrientation", () => {
  it("is neutral lying flat, and points fully up when held upright", () => {
    const flat = gravityFromOrientation(0, 0);
    expect(flat.x).toBeCloseTo(0);
    expect(flat.y).toBeCloseTo(0);
    const upright = gravityFromOrientation(90, 0);
    expect(upright.x).toBeCloseTo(0);
    expect(upright.y).toBeCloseTo(1);
  });

  it("stays continuous through beta +-90 however wildly gamma swings", () => {
    for (const edge of [90, -90]) {
      const at = gravityFromOrientation(edge, 0);
      for (const gamma of [-90, -45, 0, 30, 89.9]) {
        const near = gravityFromOrientation(edge, gamma);
        expect(near.x).toBeCloseTo(at.x, 6);
        expect(near.y).toBeCloseTo(at.y, 6);
      }
      // A tiny step across the edge moves the vector a tiny distance, whatever gamma does there.
      const before = gravityFromOrientation(edge - 0.01, -85);
      const after = gravityFromOrientation(edge + 0.01, 85);
      expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(0.02);
    }
  });

  it("tips left and right with gamma", () => {
    expect(gravityFromOrientation(0, 30).x).toBeCloseTo(-0.5);
    expect(gravityFromOrientation(0, -30).x).toBeCloseTo(0.5);
    expect(gravityFromOrientation(30, 0).y).toBeCloseTo(0.5);
  });
});

describe("toScreen", () => {
  const v = { x: 1, y: 0 };
  const w = { x: 0, y: 1 };

  it("rotates the vector by the screen angle", () => {
    const table: Array<[number, { x: number; y: number }, { x: number; y: number }]> = [
      [0, { x: 1, y: 0 }, { x: 0, y: 1 }],
      [90, { x: 0, y: 1 }, { x: -1, y: 0 }],
      [180, { x: -1, y: 0 }, { x: 0, y: -1 }],
      [270, { x: 0, y: -1 }, { x: 1, y: 0 }],
    ];
    for (const [angle, fromX, fromY] of table) {
      const a = toScreen(v, angle);
      const b = toScreen(w, angle);
      expect(a.x).toBeCloseTo(fromX.x);
      expect(a.y).toBeCloseTo(fromX.y);
      expect(b.x).toBeCloseTo(fromY.x);
      expect(b.y).toBeCloseTo(fromY.y);
    }
  });

  it("treats a missing angle as 0", () => {
    expect(toScreen({ x: 0.3, y: -0.7 }, null)).toEqual(toScreen({ x: 0.3, y: -0.7 }, 0));
    expect(toScreen({ x: 0.3, y: -0.7 }, undefined)).toEqual({ x: 0.3, y: -0.7 });
  });
});

describe("lightFromTilt", () => {
  const rest = { x: 0.2, y: 0.5 };

  it("is centred at the baseline", () => {
    expect(lightFromTilt(rest, rest)).toEqual({ x: 0, y: -0 });
  });

  it("scales by the range and flips y, because CSS y points down", () => {
    const light = lightFromTilt({ x: rest.x + LIGHT_RANGE / 2, y: rest.y + LIGHT_RANGE / 2 }, rest);
    expect(light.x).toBeCloseTo(0.5 * LIGHT_SIGN);
    expect(light.y).toBeCloseTo(-0.5 * LIGHT_SIGN);
  });

  it("clamps to -1..1", () => {
    expect(lightFromTilt({ x: 5, y: -5 }, rest)).toEqual({ x: LIGHT_SIGN, y: LIGHT_SIGN });
    expect(lightFromTilt({ x: -5, y: 5 }, rest)).toEqual({ x: -LIGHT_SIGN, y: -LIGHT_SIGN });
  });

  it("takes a custom range", () => {
    expect(lightFromTilt({ x: 0.1, y: 0 }, { x: 0, y: 0 }, 0.2).x).toBeCloseTo(0.5 * LIGHT_SIGN);
  });

  it("has one sign for both axes", () => {
    expect(Math.abs(LIGHT_SIGN)).toBe(1);
  });
});

describe("lowPass", () => {
  it("moves a fraction of the way, faster for a longer step", () => {
    const short = lowPass(0, 1, 16);
    const long = lowPass(0, 1, 120);
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeCloseTo(1 - Math.exp(-1));
  });

  it("takes the time constant", () => {
    expect(lowPass(0, 1, 100, 100)).toBeCloseTo(1 - Math.exp(-1));
    expect(lowPass(0, 1, 100, 1000)).toBeLessThan(lowPass(0, 1, 100, 100));
  });

  it("does not move on a step that is not forward in time", () => {
    expect(lowPass(0.3, 1, 0)).toBe(0.3);
    expect(lowPass(0.3, 1, -5)).toBe(0.3);
    expect(lowPass(0.3, 1, Number.NaN)).toBe(0.3);
  });

  it("jumps to the new value after a stale gap of over a second", () => {
    expect(lowPass(0.3, 1, 1001)).toBe(1);
    expect(lowPass(0.3, 1, 1000)).toBeLessThan(1);
  });
});

describe("createTiltController", () => {
  function setup() {
    let clock = 0;
    const apply = vi.fn<(x: number, y: number) => void>();
    const controller = createTiltController({ apply, now: () => clock });
    return {
      apply,
      controller,
      at: (t: number) => {
        clock = t;
        return t;
      },
    };
  }

  it("applies the first reading as the neutral light", () => {
    const { apply, controller } = setup();
    expect(controller.sample(60, 10, 0, 0)).toEqual({ sensor: true, settled: true });
    expect(apply).toHaveBeenCalledTimes(1);
    const [x, y] = apply.mock.calls[0] ?? [];
    expect(Math.abs(x ?? 1)).toBeLessThan(1e-9);
    expect(Math.abs(y ?? 1)).toBeLessThan(1e-9);
  });

  it("moves the light with the tilt and settles as the filter catches up", () => {
    const { apply, controller } = setup();
    controller.sample(0, 0, 0, 0);
    let result = controller.sample(90, 0, 0, 40);
    expect(result.settled).toBe(false);
    for (let t = 80; t < 1200 && !result.settled; t += 40) result = controller.sample(90, 0, 0, t);
    expect(result.settled).toBe(true);
    const [, y] = apply.mock.lastCall ?? [];
    // Upright is +1 on the screen's up axis, and CSS y is down.
    expect(y).toBeLessThan(-0.7 * Math.abs(LIGHT_SIGN));
  });

  it("does not write again inside the deadband", () => {
    const { apply, controller } = setup();
    controller.sample(45, 0, 0, 0);
    apply.mockClear();
    // Half the deadband of light: 0.45 * 0.004 / 2 in gravity units, about 0.0006 rad in beta.
    const tinyBeta = 45 + (DEADBAND / 2) * LIGHT_RANGE * (180 / Math.PI) * 1.4;
    controller.sample(tinyBeta, 0, 0, 100);
    expect(apply).not.toHaveBeenCalled();
  });

  it("caps writes at about 30 a second, and finishes the move on a later reading", () => {
    const { apply, controller } = setup();
    controller.sample(0, 0, 0, 0);
    apply.mockClear();
    // 5ms apart: many readings per write interval.
    let last = { sensor: true, settled: true };
    for (let t = 5; t < 5 + MIN_APPLY_INTERVAL_MS * 3; t += 5) last = controller.sample(90, 0, 0, t);
    expect(apply.mock.calls.length).toBeLessThanOrEqual(4);
    expect(apply.mock.calls.length).toBeGreaterThan(0);
    // Not settled while a move waits behind the cap.
    expect(last.settled).toBe(false);
    // Long after, one more reading catches everything up and reports it settled.
    let result = last;
    for (let t = 200; t < 4000 && !result.settled; t += 16) result = controller.sample(90, 0, 0, t);
    expect(result.settled).toBe(true);
  });

  it("reports no sensor for missing angles, and writes nothing", () => {
    const { apply, controller } = setup();
    expect(controller.sample(null, null, 0, 0).sensor).toBe(false);
    expect(controller.sample(10, null, 0, 10).sensor).toBe(false);
    expect(controller.sample(null, 10, 0, 20).sensor).toBe(false);
    expect(controller.sample(Number.NaN, 10, 0, 30).sensor).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("starts again from the new hold when the screen turns", () => {
    const { apply, controller } = setup();
    controller.sample(90, 0, 0, 0);
    controller.sample(90, 0, 0, 100);
    apply.mockClear();
    // The same physical pose, seen from a landscape screen, is a different vector: no leap in the light.
    controller.sample(90, 0, 90, 200);
    expect(apply).not.toHaveBeenCalled();
    // And a tilt from there is measured from the new hold.
    let result = controller.sample(30, 0, 90, 240);
    for (let t = 280; t < 1500 && !result.settled; t += 40) result = controller.sample(30, 0, 90, t);
    expect(Math.abs(apply.mock.lastCall?.[0] ?? 0)).toBeGreaterThan(0.5);
  });

  it("learns a held pose slowly, so a long tilt drifts back to neutral", () => {
    const { apply, controller } = setup();
    controller.sample(0, 0, 0, 0);
    let t = 0;
    for (; t < 1500; t += 16) controller.sample(90, 0, 0, t);
    const early = Math.abs(apply.mock.lastCall?.[1] ?? 0);
    for (; t < BASELINE_TAU_MS * 6; t += 16) controller.sample(90, 0, 0, t);
    const late = Math.abs(apply.mock.lastCall?.[1] ?? 1);
    expect(early).toBeGreaterThan(0.9);
    expect(late).toBeLessThan(0.1);
  });

  it("keeps the resting pose across a pause instead of re-centring on the new hold", () => {
    const { apply, controller } = setup();
    controller.sample(0, 0, 0, 0);
    // A long silence (the device lay still), then it is picked up upright.
    controller.sample(90, 0, 0, 10_000);
    expect(apply.mock.lastCall?.[1]).toBeLessThan(-0.9);
  });

  it("resetBaseline makes the current hold neutral; reset forgets everything", () => {
    const { apply, controller } = setup();
    controller.sample(0, 0, 0, 0);
    for (let t = 40; t < 1200; t += 40) controller.sample(90, 0, 0, t);
    controller.resetBaseline();
    controller.sample(90, 0, 0, 1300);
    expect(Math.abs(apply.mock.lastCall?.[1] ?? 1)).toBeLessThan(1e-9);

    controller.reset();
    apply.mockClear();
    controller.sample(90, 0, 0, 1400);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("reads the clock when a reading brings no time", () => {
    const { apply, controller, at } = setup();
    at(100);
    controller.sample(10, 0, 0);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("tiltSupported and needsPermission", () => {
  const media = (matches: boolean) => () => ({ matches });

  it("needs the API and a touch device", () => {
    expect(tiltSupported({})).toBe(false);
    expect(tiltSupported({ DeviceOrientationEvent: class {}, matchMedia: media(false), navigator: {} })).toBe(false);
    expect(tiltSupported({ DeviceOrientationEvent: class {}, matchMedia: media(true) })).toBe(true);
    expect(
      tiltSupported({ DeviceOrientationEvent: class {}, matchMedia: media(false), navigator: { maxTouchPoints: 5 } }),
    ).toBe(true);
    expect(tiltSupported({ matchMedia: media(true), navigator: { maxTouchPoints: 5 } })).toBe(false);
    expect(tiltSupported({ DeviceOrientationEvent: class {} })).toBe(false);
  });

  it("asks for permission only where the API has requestPermission", () => {
    expect(needsPermission({})).toBe(false);
    expect(needsPermission({ DeviceOrientationEvent: class {} })).toBe(false);
    expect(needsPermission({ DeviceOrientationEvent: { requestPermission: async () => "granted" } })).toBe(true);
    expect(needsPermission({ DeviceOrientationEvent: { requestPermission: "yes" } })).toBe(false);
  });
});
