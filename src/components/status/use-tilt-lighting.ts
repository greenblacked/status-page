import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTiltController,
  needsPermission,
  readTiltLighting,
  TILT_ATTRIBUTE,
  TILT_VAR_X,
  TILT_VAR_Y,
  tiltFromStorageEvent,
  tiltSupported,
  writeTiltLighting,
} from "@/lib/status/tilt";

const storage = () => window.localStorage;

/** How long a page that was allowed motion before waits for the first reading before asking again. */
const NO_READING_MS = 1500;

export type TiltStatus = "off" | "on" | "denied" | "no-sensor" | "needs-permission" | "paused";

type Problem = "denied" | "no-sensor" | "needs-permission" | null;

/** iOS 13+ only: motion is behind a permission that a tap has to ask for. */
type MotionPermissionApi = { requestPermission?: () => Promise<"granted" | "denied"> };

/** Reduce Motion, or the system's Reduce Transparency where a browser passes it on. */
const REDUCED_QUERIES = ["(prefers-reduced-motion: reduce)", "(prefers-reduced-transparency: reduce)"];

/**
 * Tilt lighting: on a touch device with motion sensors, the light on the
 * glass follows how the device is held (src/lib/status/tilt.ts has the
 * maths). It is off until switched on, because iOS asks for motion access
 * first, and it writes only --light-x and --light-y on <html>, plus
 * data-tilt="on" while it really is driving them.
 *
 * `supported` is worked out after hydration, so the server and the first
 * client render agree that there is nothing to show. `paused` is Reduce
 * glass; Reduce Motion is watched here. While paused nothing listens and
 * nothing is written.
 *
 * A motion event only records the latest reading. One animation frame loop
 * turns it into the two properties, and stops as soon as the light has
 * caught up, so a device lying still costs nothing and React never
 * re-renders per reading.
 */
export function useTiltLighting({ paused }: { paused: boolean }): {
  supported: boolean;
  enabled: boolean;
  status: TiltStatus;
  setEnabled: (on: boolean) => void;
} {
  const [supported, setSupported] = useState(false);
  const [preferred, setPreferred] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [motionReduced, setMotionReduced] = useState(false);
  // A tap just got motion access, so the next attach must not wait for a reading to ask again.
  const askedByTap = useRef(false);

  useEffect(() => {
    setSupported(tiltSupported(window));
    setPreferred(readTiltLighting(storage));
    const onStorage = (event: StorageEvent) => {
      const next = tiltFromStorageEvent(event);
      if (next === null) return;
      setPreferred(next);
      setProblem(null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const lists = REDUCED_QUERIES.map((query) => window.matchMedia(query));
    const update = () => setMotionReduced(lists.some((list) => list.matches));
    update();
    for (const list of lists) list.addEventListener("change", update);
    return () => {
      for (const list of lists) list.removeEventListener("change", update);
    };
  }, []);

  const stillPaused = paused || motionReduced;
  const active = supported && preferred && problem === null && !stillPaused;

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const viaTap = askedByTap.current;
    askedByTap.current = false;

    let latest: { beta: number; gamma: number; angle: number } | null = null;
    let frame = 0;
    let timer = 0;
    let attached = false;
    let gotReading = false;
    let driving = false;

    const controller = createTiltController({
      apply: (x, y) => {
        root.style.setProperty(TILT_VAR_X, x.toFixed(3));
        root.style.setProperty(TILT_VAR_Y, y.toFixed(3));
        if (!driving) {
          driving = true;
          root.setAttribute(TILT_ATTRIBUTE, "on");
        }
      },
      now: () => performance.now(),
    });

    const tick = (time: number) => {
      frame = 0;
      if (!latest) return;
      const result = controller.sample(latest.beta, latest.gamma, latest.angle, time);
      if (!result.settled) frame = requestAnimationFrame(tick);
    };

    const onReading = (event: DeviceOrientationEvent) => {
      if (event.beta === null || event.gamma === null) {
        if (!gotReading) setProblem("no-sensor");
        return;
      }
      gotReading = true;
      window.clearTimeout(timer);
      latest = { beta: event.beta, gamma: event.gamma, angle: window.screen.orientation?.angle ?? 0 };
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const attach = () => {
      if (attached) return;
      attached = true;
      window.addEventListener("deviceorientation", onReading);
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      window.removeEventListener("deviceorientation", onReading);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        detach();
      } else if (!attached) {
        // Whatever the device did meanwhile, this hold is the new neutral.
        controller.reset();
        attach();
      }
    };
    const onPageShow = () => {
      if (document.visibilityState !== "hidden") onVisibility();
    };

    if (document.visibilityState !== "hidden") attach();
    // A saved "on" never asks by itself: iOS wants a tap. Motion that has not arrived shortly after load means it has to ask again.
    if (!viaTap && needsPermission(window)) {
      timer = window.setTimeout(() => {
        if (!gotReading) setProblem("needs-permission");
      }, NO_READING_MS);
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", detach);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", detach);
      window.removeEventListener("pageshow", onPageShow);
      detach();
      root.style.removeProperty(TILT_VAR_X);
      root.style.removeProperty(TILT_VAR_Y);
      root.removeAttribute(TILT_ATTRIBUTE);
    };
  }, [active]);

  const setEnabled = useCallback((on: boolean) => {
    if (!on) {
      writeTiltLighting(storage, false);
      setPreferred(false);
      setProblem(null);
      return;
    }
    // iOS only shows its prompt for a call made inside the tap, so nothing may come before this line.
    let request: Promise<"granted" | "denied"> | undefined;
    try {
      request = (DeviceOrientationEvent as unknown as MotionPermissionApi).requestPermission?.();
    } catch {
      request = Promise.reject(new Error("motion permission refused"));
    }
    const granted = () => {
      askedByTap.current = true;
      writeTiltLighting(storage, true);
      setPreferred(true);
      setProblem(null);
    };
    const denied = () => {
      writeTiltLighting(storage, false);
      setPreferred(false);
      setProblem("denied");
    };
    if (!request) granted();
    else request.then((answer) => (answer === "granted" ? granted() : denied()), denied);
  }, []);

  let status: TiltStatus = "off";
  if (supported) {
    if (problem) status = problem;
    else if (preferred) status = stillPaused ? "paused" : "on";
  }
  return { supported, enabled: status === "on" || status === "paused", status, setEnabled };
}
