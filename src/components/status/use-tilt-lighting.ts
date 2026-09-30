import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTiltController,
  createWritePacer,
  needsPermission,
  readTiltLighting,
  screenAngle,
  TILT_ATTRIBUTE,
  TILT_LIGHT_SELECTOR,
  TILT_VAR_X,
  TILT_VAR_Y,
  tiltFromStorageEvent,
  tiltSupported,
  writeTiltLighting,
} from "@/lib/status/tilt";

const storage = () => window.localStorage;

/** How long any page waits for a first reading before saying none is coming. */
const NO_READING_MS = 3000;

/**
 * Writes --light-x and --light-y inline on every glass panel (the elements
 * TILT_LIGHT_SELECTOR names); their ::before and ::after take them from the
 * panel (src/styles.css).
 *
 * Not on <html>, and not through a rule of a style sheet: a change to a rule
 * makes WebKit rebuild its rule sets and re-style the document. The
 * properties are plain, inherited custom properties, so an inline write
 * re-styles the panel and what is inside it (about 18 ms for 18 panels on a
 * loaded Chromium, and several times that on a throttled CPU). Registering
 * them as non-inherited is about 5 times cheaper per write, but WebKit then
 * draws the pseudo-elements as if they were unset; see src/styles.css. The
 * deadband and the frame cap in the controller keep the plain form affordable,
 * and the cap widens by itself while frames overrun (createWritePacer), so a
 * slow device writes less often instead of dropping frames.
 *
 * Panels come and go when a refresh re-renders the board, so a new one gets
 * the current value from a MutationObserver, before it paints. It watches
 * only while the light is on, and remove() puts everything back.
 */
function createLightSink(): { set: (x: string, y: string) => void; remove: () => void } {
  const written = new Set<HTMLElement>();
  let last: { x: string; y: string } | null = null;
  let observer: MutationObserver | null = null;

  const write = (host: HTMLElement) => {
    if (!last) return;
    host.style.setProperty(TILT_VAR_X, last.x);
    host.style.setProperty(TILT_VAR_Y, last.y);
    written.add(host);
  };

  const onMutations = (records: MutationRecord[]) => {
    const fresh = records.some((record) =>
      Array.from(record.addedNodes).some(
        (node) =>
          node instanceof Element && (node.matches(TILT_LIGHT_SELECTOR) || node.querySelector(TILT_LIGHT_SELECTOR)),
      ),
    );
    if (!fresh) return;
    for (const host of Array.from(written)) if (!host.isConnected) written.delete(host);
    for (const host of document.querySelectorAll<HTMLElement>(TILT_LIGHT_SELECTOR)) {
      if (!written.has(host)) write(host);
    }
  };

  return {
    set: (x, y) => {
      last = { x, y };
      for (const host of Array.from(written)) if (!host.isConnected) written.delete(host);
      for (const host of document.querySelectorAll<HTMLElement>(TILT_LIGHT_SELECTOR)) write(host);
      if (!observer) {
        observer = new MutationObserver(onMutations);
        observer.observe(document.body, { childList: true, subtree: true });
      }
    },
    remove: () => {
      observer?.disconnect();
      observer = null;
      for (const host of written) {
        host.style.removeProperty(TILT_VAR_X);
        host.style.removeProperty(TILT_VAR_Y);
      }
      written.clear();
      last = null;
    },
  };
}

export type TiltStatus =
  | "off"
  | "on"
  | "denied"
  | "no-sensor"
  | "needs-permission"
  | "no-readings"
  | "no-readings-dropped"
  | "paused";

type Problem = "denied" | "no-sensor" | "needs-permission" | "no-readings" | "no-readings-dropped" | null;

/** iOS 13+ only: motion is behind a permission that a tap has to ask for. */
type MotionPermissionApi = { requestPermission?: () => Promise<"granted" | "denied"> };

/** Reduce Motion, or the system's Reduce Transparency where a browser passes it on. */
const REDUCED_QUERIES = ["(prefers-reduced-motion: reduce)", "(prefers-reduced-transparency: reduce)"];

/**
 * Tilt lighting: on a touch device with motion sensors, the light on the
 * glass follows how the device is held (src/lib/status/tilt.ts has the
 * maths). It is off until switched on, because iOS asks for motion access
 * first, and it writes only --light-x and --light-y (see createLightSink),
 * plus data-tilt="on" on <html> while it really is driving them.
 *
 * `supported` is worked out after hydration, so the server and the first
 * client render agree that there is nothing to show. `paused` is Reduce
 * glass, or the Quiet background (the light only draws on Glass and Full);
 * Reduce Motion is watched here. While paused nothing listens and
 * nothing is written.
 *
 * A motion event only records the latest reading. One animation frame loop
 * turns it into the two properties, and stops as soon as the light has
 * caught up, so React never re-renders per reading. It is not free while the
 * device is held: iOS fires deviceorientation continuously (about 60 a second,
 * still or not), and sensor noise keeps moving the light a little. The
 * deadband and the frame cap keep the writes low then, but not at zero.
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
    const light = createLightSink();
    const viaTap = askedByTap.current;
    askedByTap.current = false;

    let latest: { beta: number; gamma: number; angle: number } | null = null;
    let frame = 0;
    let readingTimer = 0;
    let attached = false;
    let probed = false;
    // Set when this run ends, so a late answer cannot touch a page that has moved on.
    let cancelled = false;
    let gotReading = false;
    let driving = false;
    const pacer = createWritePacer();
    let lastFrame = 0;

    const controller = createTiltController({
      apply: (x, y) => {
        light.set(x.toFixed(3), y.toFixed(3));
        if (!driving) {
          driving = true;
          root.setAttribute(TILT_ATTRIBUTE, "on");
        }
      },
      now: () => performance.now(),
      minIntervalMs: () => pacer.interval(),
    });

    const tick = (time: number) => {
      frame = 0;
      if (!latest) return;
      // Frames that overrun mean the writes cost more than the device can spare: write less often.
      if (lastFrame) pacer.frame(time - lastFrame);
      lastFrame = time;
      const result = controller.sample(latest.beta, latest.gamma, latest.angle, time);
      if (result.settled) lastFrame = 0;
      else frame = requestAnimationFrame(tick);
    };

    const onReading = (event: DeviceOrientationEvent) => {
      if (event.beta === null || event.gamma === null) {
        if (!gotReading) setProblem("no-sensor");
        return;
      }
      gotReading = true;
      window.clearTimeout(readingTimer);
      latest = { beta: event.beta, gamma: event.gamma, angle: screenAngle(window) };
      if (!frame) frame = requestAnimationFrame(tick);
    };

    // A saved choice that cannot be kept: forget it, so the next load does not meet the same problem.
    const forget = (problem: Problem) => {
      writeTiltLighting(storage, false);
      setPreferred(false);
      setProblem(problem);
    };

    /**
     * Asks iOS whether motion is still allowed, without a tap. Called outside a
     * gesture, requestPermission never prompts (WebKit's mayPrompt is false): it
     * answers with what Safari remembers for this session, or rejects when only a
     * tap can ask. So a slow first reading is no longer taken for a missing permission.
     */
    const probe = () => {
      let request: Promise<"granted" | "denied"> | undefined;
      try {
        request = (DeviceOrientationEvent as unknown as MotionPermissionApi).requestPermission?.();
      } catch {
        request = Promise.reject(new Error("motion permission needs a tap"));
      }
      request?.then(
        (answer) => {
          if (!cancelled && answer !== "granted") forget("denied");
        },
        () => {
          if (!cancelled) forget("needs-permission");
        },
      );
    };

    const attach = () => {
      if (attached) return;
      attached = true;
      window.addEventListener("deviceorientation", onReading);
      // A saved "on" on iOS is checked once with the browser (probe). Whatever the device,
      // silence for a few seconds means no motion is coming: after a tap that is only said;
      // for a saved choice it is forgotten too, or the note would return on every load.
      if (!viaTap && !probed && needsPermission(window)) {
        probed = true;
        probe();
      }
      if (gotReading) return;
      readingTimer = window.setTimeout(() => {
        if (viaTap) setProblem("no-readings");
        else forget("no-readings-dropped");
      }, NO_READING_MS);
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      window.removeEventListener("deviceorientation", onReading);
      window.clearTimeout(readingTimer);
      // The loop rests here: the next frame is not a slow one for having waited.
      lastFrame = 0;
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
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", detach);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", detach);
      window.removeEventListener("pageshow", onPageShow);
      detach();
      light.remove();
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
    // Declined: the saved choice goes too, so the note about asking again stops with it.
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
