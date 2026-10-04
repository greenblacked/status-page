import type { PreferenceStorage } from "@/lib/status/glass";

/**
 * Tilt lighting: on a phone or tablet, the light on the glass follows how
 * the device is held. This file is the pure part (the stored choice, the
 * maths from a motion sample to a light position, and the smoothing);
 * src/components/status/use-tilt-lighting.ts wires it to the browser.
 *
 * The light reaches the CSS only through two custom properties,
 * --light-x and --light-y, each from -1 to 1, written inline on one element,
 * the board's <main>. The glass panels inside it (TILT_LIGHT_SELECTOR) read
 * them in their ::before and ::after, which place a fixed gradient with a
 * transform. Nothing may depend on them: unset, the board looks exactly as it
 * did before this existed. They only draw on the Glass and Full backgrounds
 * (src/background.css), so the hook stands down on Quiet.
 */
export const TILT_STORAGE_KEY = "status-bar:tilt-lighting";
/** Set on <html> while the light is really being driven, and only then. */
export const TILT_ATTRIBUTE = "data-tilt";
export const TILT_VAR_X = "--light-x";
export const TILT_VAR_Y = "--light-y";
/**
 * The panels whose sheen (::before) and glint (::after) draw the light. The
 * hook finds them once, then follows them with a MutationObserver, to know
 * which are on screen; the light itself is written once, on their ancestor.
 */
export const TILT_LIGHT_SELECTOR = ".surface";

/**
 * Where the glint is drawn: no hover-capable pointer. There it takes the card's ::after over from the wandering
 * light (which runs on every device in Full) for as long as the light is driven; with a hover-capable pointer
 * the wander keeps it. The same string as the media query that wraps the glint's rules in src/background.css (a
 * test holds the two together), so the sink can ask the page what the style sheet is asking, and listen for it
 * to change (a mouse plugged into or taken off a tablet).
 */
export const GLINT_QUERY = "not ((hover: hover) and (pointer: fine))";

/**
 * Which way the light moves for a given tilt. The one place to flip it: 1
 * or -1 turns the light toward the other side of the screen on both axes.
 */
export const LIGHT_SIGN = 1;

/** Off unless this browser switched it on; anything unreadable counts as off. */
export function parseTiltPreference(raw: string | null): boolean {
  return raw === "on";
}

export function serializeTiltPreference(on: boolean): string {
  return on ? "on" : "off";
}

export function readTiltLighting(storage: () => PreferenceStorage): boolean {
  try {
    return parseTiltPreference(storage().getItem(TILT_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function writeTiltLighting(storage: () => PreferenceStorage, on: boolean): void {
  try {
    storage().setItem(TILT_STORAGE_KEY, serializeTiltPreference(on));
  } catch {
    // Private windows can refuse storage; the choice then lasts for this visit.
  }
}

/**
 * What a `storage` event from another tab means for this one: the new
 * choice, or null when the event is about another key. A null key is
 * localStorage.clear(), which puts the default back.
 */
export function tiltFromStorageEvent(event: { key: string | null; newValue: string | null }): boolean | null {
  if (event.key === null) return parseTiltPreference(null);
  if (event.key !== TILT_STORAGE_KEY) return null;
  return parseTiltPreference(event.newValue);
}

/** A direction in a plane: x to the right, y up. */
export type Vec2 = { x: number; y: number };

const RAD = Math.PI / 180;

/**
 * Where "up" lies in the device's own frame, from the W3C beta (front to
 * back, -180..180) and gamma (left to right, -90..90) angles in degrees.
 * Both components stay continuous when beta passes +-90 (a phone held
 * upright), where the Euler angles themselves jump and gamma swings wildly.
 */
export function gravityFromOrientation(beta: number, gamma: number): Vec2 {
  const b = beta * RAD;
  const g = gamma * RAD;
  return { x: -Math.sin(g) * Math.cos(b), y: Math.sin(b) };
}

/**
 * The same direction seen from the screen as the user reads it, rotated by
 * screen.orientation.angle (0, 90, 180 or 270; a missing angle is 0).
 */
export function toScreen(v: Vec2, angleDeg: number | null | undefined): Vec2 {
  const a = (angleDeg ?? 0) * RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** How far the device must tilt from its resting pose for the light to reach the edge. */
export const LIGHT_RANGE = 0.45;

/**
 * The light position, each axis from -1 to 1, for a screen-space tilt
 * measured against the pose the device rests in (the baseline). Screen y
 * points down in CSS, so the vertical axis is flipped.
 */
export function lightFromTilt(screenVec: Vec2, baseline: Vec2, range = LIGHT_RANGE): Vec2 {
  return {
    x: clamp(((screenVec.x - baseline.x) / range) * LIGHT_SIGN, -1, 1),
    y: clamp((-(screenVec.y - baseline.y) / range) * LIGHT_SIGN, -1, 1),
  };
}

/** A step over this long is stale: the filter jumps rather than glides. */
const STALE_MS = 1000;

/**
 * One step of an exponential low-pass filter over `dtMs`. A step that is
 * not forward in time (dt <= 0, or NaN) changes nothing; one after a gap of
 * over a second is stale, so the filter jumps to the new value instead.
 */
export function lowPass(prev: number, next: number, dtMs: number, tauMs = 120): number {
  if (!(dtMs > 0)) return prev;
  if (dtMs > STALE_MS) return next;
  const a = 1 - Math.exp(-dtMs / tauMs);
  return prev + a * (next - prev);
}

/** The pose the device rests in is learned slowly, so a tilt held for many seconds drifts back to a neutral light. */
export const BASELINE_TAU_MS = 5000;
/** The light must move this far (of its -1..1 range) before the page is touched again. */
export const DEADBAND = 0.004;
/** About 30 writes a second where a write restyles the board (the properties fallback). The animation path writes on every frame (see createWritePacer). */
export const MIN_APPLY_INTERVAL_MS = 33;
/** The slowest the light is written when frames are dropping (on the properties fallback): about 4 a second. */
export const MAX_APPLY_INTERVAL_MS = 250;

/** No display frames faster than this (120 Hz is 8.3 ms), so a glitch cannot set an impossible baseline. */
const MIN_FRAME_MS = 8;
/** A frame longer than this is counted as this long. */
const MAX_FRAME_MS = 1000;
/** A gap that has to widen starts from at least this, so a pacer that writes on every frame (a gap of 0) can back off. */
const WIDEN_FROM_MS = 16;
/** A frame this many times the device's own frame period is overrunning; this few, it is on time. */
const OVERRUN_RATIO = 1.5;
const ON_TIME_RATIO = 1.2;

export type WritePacer = {
  /** The gap to leave between writes now. */
  interval(): number;
  /** Reports how long the last frame took (from the one before it, in the same run). */
  frame(frameMs: number): void;
};

/**
 * Sets the gap between writes from how the frames are going. A write costs
 * the page work (a restyle, or the commit of the layers it slid), which on a slow
 * device takes longer than a frame; a frame that overran means the writes are too
 * frequent, so the gap widens, and it narrows again once frames are on time. It
 * never goes under `minMs`: the default is the 33 ms of the fallback that restyles
 * the board; a write that is cheap passes 0 and goes out on every frame until
 * frames start to overrun.
 *
 * "Overran" is judged against the device's own frame period, not a fixed 60 Hz:
 * the baseline is the shortest frame seen, rising only very slowly so that a
 * device that changes rate (iOS Low Power Mode drops to 30 Hz) is followed. A
 * 30 Hz screen with an occasional dropped frame backs off for that frame and
 * recovers; a fixed threshold would take every 33 ms frame for a fast one or
 * every 66 ms frame for a slow one and ratchet up for good. Give it every frame
 * of a run; start a new run (a new pacer, or `frame` after a rest) with no
 * long gap in it: the caller resets its frame clock when the loop rests.
 */
export function createWritePacer(minMs = MIN_APPLY_INTERVAL_MS): WritePacer {
  let interval = minMs;
  let period: number | null = null;
  return {
    interval: () => interval,
    frame(frameMs) {
      if (!(frameMs > 0)) return;
      const ms = Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, frameMs));
      // The shortest frame is the display's period. It creeps up so a lower refresh rate is followed in time.
      period = period === null || ms < period ? ms : period + (ms - period) * 0.005;
      if (ms > period * OVERRUN_RATIO) {
        interval = Math.min(MAX_APPLY_INTERVAL_MS, Math.max(interval, WIDEN_FROM_MS) * 1.5);
      } else if (ms <= period * ON_TIME_RATIO) {
        // Under a frame's length a gap means nothing: back to the minimum.
        const narrowed = interval * 0.9;
        interval = narrowed < MIN_FRAME_MS ? minMs : Math.max(minMs, narrowed);
      }
    },
  };
}

/** The filter counts as caught up with the device within this distance. */
const SETTLED = 0.001;

export type TiltSampleResult = {
  /** False when the device reported no angles at all: it has no motion sensor. */
  sensor: boolean;
  /** True when feeding the same reading again would change nothing on the page. */
  settled: boolean;
};

export type TiltController = {
  /** Feeds one reading; calls `apply` when the light has moved enough. The same reading may be fed again to let the filter catch up. */
  sample(beta: number | null, gamma: number | null, angle: number | null | undefined, t?: number): TiltSampleResult;
  /** Forgets the resting pose, so the current hold becomes neutral. */
  resetBaseline(): void;
  /** Forgets everything, as before the first reading. */
  reset(): void;
};

export function createTiltController({
  apply,
  now,
  minIntervalMs = () => MIN_APPLY_INTERVAL_MS,
}: {
  apply: (x: number, y: number) => void;
  now: () => number;
  /** How long to leave between writes; see createWritePacer. */
  minIntervalMs?: () => number;
}): TiltController {
  let filtered: Vec2 | null = null;
  let baseline: Vec2 | null = null;
  let lastAngle: number | null = null;
  let lastT: number | null = null;
  let applied: Vec2 | null = null;
  let appliedAt = Number.NEGATIVE_INFINITY;
  let dirty = false;

  const resetBaseline = () => {
    baseline = null;
  };
  const reset = () => {
    filtered = null;
    baseline = null;
    lastAngle = null;
    lastT = null;
    applied = null;
    appliedAt = Number.NEGATIVE_INFINITY;
    dirty = false;
  };

  const sample: TiltController["sample"] = (beta, gamma, angle, t = now()) => {
    if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) {
      return { sensor: false, settled: true };
    }
    const orientation = angle ?? 0;
    // Turning the device to another orientation changes what "left" means: start again from there.
    if (lastAngle !== null && orientation !== lastAngle) {
      filtered = null;
      baseline = null;
    }
    lastAngle = orientation;

    const target = toScreen(gravityFromOrientation(beta, gamma), orientation);
    const dt = lastT === null ? 0 : t - lastT;
    lastT = t;
    const before = filtered;
    const current = before
      ? { x: lowPass(before.x, target.x, dt), y: lowPass(before.y, target.y, dt) }
      : { x: target.x, y: target.y };
    filtered = current;
    // The resting pose moves on real time only up to a second at a time: after a
    // pause (the loop rests when the device does) the light must not be re-centred on the new hold.
    const baselineDt = Math.min(dt, STALE_MS);
    baseline = baseline
      ? {
          x: lowPass(baseline.x, current.x, baselineDt, BASELINE_TAU_MS),
          y: lowPass(baseline.y, current.y, baselineDt, BASELINE_TAU_MS),
        }
      : { x: current.x, y: current.y };

    const light = lightFromTilt(current, baseline);
    const moved = !applied || Math.abs(light.x - applied.x) >= DEADBAND || Math.abs(light.y - applied.y) >= DEADBAND;
    if (!moved) {
      dirty = false;
    } else if (t - appliedAt >= minIntervalMs()) {
      applied = light;
      appliedAt = t;
      dirty = false;
      apply(light.x, light.y);
    } else {
      // Over the frame cap: the next reading writes it.
      dirty = true;
    }
    const caughtUp = Math.abs(current.x - target.x) < SETTLED && Math.abs(current.y - target.y) < SETTLED;
    return { sensor: true, settled: caughtUp && !dirty };
  };

  return { sample, resetBaseline, reset };
}

/** The part of `window` these checks read, so tests can pass a stand-in. */
export type TiltWindow = {
  DeviceOrientationEvent?: unknown;
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { maxTouchPoints?: number };
};

/** A touch device that can report its orientation. Desktop Safari does not expose the API at all; a laptop's Chrome has it but no touch. */
export function tiltSupported(win: TiltWindow): boolean {
  if (typeof win.DeviceOrientationEvent === "undefined") return false;
  const coarse = win.matchMedia?.("(any-pointer: coarse)").matches === true;
  return coarse || (win.navigator?.maxTouchPoints ?? 0) > 0;
}

/** iOS asks before it shares motion; the request must come from a tap. */
export function needsPermission(win: TiltWindow): boolean {
  const api = win.DeviceOrientationEvent as { requestPermission?: unknown } | undefined;
  return typeof api?.requestPermission === "function";
}

/** The part of `window` that says how the screen is turned; `orientation` is the legacy, signed value. */
export type OrientationWindow = {
  screen?: { orientation?: { angle?: number } };
  orientation?: unknown;
};

/**
 * How far the screen is turned from its natural orientation, 0, 90, 180 or
 * 270. Safari before 16.4 has no screen.orientation, only the legacy
 * window.orientation (0, 90, -90, 180). Both count a turn counter-clockwise
 * (90 is the device turned to the left), so the legacy -90 is 270.
 */
export function screenAngle(win: OrientationWindow): number {
  const angle = win.screen?.orientation?.angle;
  if (typeof angle === "number") return angle;
  const legacy = win.orientation;
  return typeof legacy === "number" && Number.isFinite(legacy) ? ((legacy % 360) + 360) % 360 : 0;
}
