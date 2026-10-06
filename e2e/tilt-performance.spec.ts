import type { BrowserContext, Page } from "@playwright/test";
import { WANDER_TICK_MS } from "../src/components/status/wander-light.ts";
import { TILT_STORAGE_KEY } from "../src/lib/status/tilt.ts";
import { expect, test } from "./test";

// How smoothly Tilt lighting runs on a slow phone. A test browser has no motion
// sensor and a fast CPU, so this stands in for both: it dispatches synthetic
// `deviceorientation` events at about 90 Hz (faster than any phone reports)
// along a smooth sweep, and slows the page's main thread down through the
// DevTools protocol (Emulation.setCPUThrottlingRate, 4x and 6x, roughly a
// mid-range and a low-end phone against a desktop core). While the sweep runs
// it records
//   - the gaps between animation frames, inside the page;
//   - the browser's own counters (Performance.getMetrics): style
//     recalculations, layouts and main-thread task time;
//   - how often the light was moved (a burst of writes of the animations' time
//     or of --light-x/--light-y counts once), and how often the page searched
//     the document for the panels (querySelectorAll with the light selector)
//     from an animation frame callback, where the light's own code runs, through
//     a spy installed before the page's own scripts run;
//   - from a second, traced sweep, how many times the main thread painted, how
//     many raster tasks ran and how many elements the style system revisited
//     (the elementCount of the UpdateLayoutTree events) while the light moved
//     (tracing slows the page, so no timing is taken from that pass).
// Durations and frame timing depend on how busy the machine is, so they are only
// reported; what is asserted are counts that load does not change.
// It needs the DevTools protocol, so it runs on Chromium (the mobile and tablet
// projects) and is skipped in WebKit and on a desktop.
//
// Cost: this runs on two Chromium projects in CI, so it is kept short: it took 84 s on the mobile project in CI with every
// sweep 3 s long and repeated, and takes about 50 s with the sweeps below (49 s on a machine busy with other
// work). Only the timed sweeps at 1x feed an assertion that depends on timing
// (the light moves on nearly every frame of a screen that keeps up, and is judged
// only when the frames themselves were on time), so that rate takes TILT_PERF_RUNS
// of them (default 3) and the median is used; the throttled rates and the
// light-off floor take one, since their timings are only reported. The traced sweep, which
// counts the paints, raster tasks and restyled elements the assertions rest on, runs
// once per rate for the full TRACE_MS, because those limits were measured over that
// long. The wandering card light's tests (below) assert counts only, so they take one timed sweep per rate too.
// Set TILT_PERF_RUNS=5 or more to look at the timings more closely. The numbers
// print as a table.

const RUNS = Number(process.env.TILT_PERF_RUNS) || 3;
/** A timed sweep: long enough for ~180 readings and ~120 frames, and only reported (except at 1x, see above). */
const SWEEP_MS = 2000;
/** The traced sweep: the paint, raster and restyle limits below were measured over 3 s. */
const TRACE_MS = 3000;
const WARMUP_MS = 500;
const SERVICES = 20;
// What the wandering card light may add to the floor's counts (see its test): a repaint on every frame would add 180 or more in
// the traced 3 s, and the counts themselves wander by a dozen on a busy machine. And the rule that holds the period dial still.
const STILL_DIAL = ".period-sweep, .period-hand { animation: none !important; }";
const PAINT_SLACK = 40;
const RASTER_SLACK = 40;
// Elements the style system may revisit per card and step of the wandering light (the card and its direct children).
const RESTYLE_PER_STEP = 30;
// Frames the compositor may draw over the floor's in the traced sweep: a step of the light draws one, about 6 in 3 s; the
// panel-sized CSS animation drew 100 or more more than the floor.
const SWAP_SLACK = 40;
// The idle window (no sweep, no frame loop) and what the wander may add to the floor's recalculations in it: one for each
// step of the light, 6 in the 3 s (the panel-sized CSS animation it replaced made 21-28 here, and over 150 when it ran on
// the main thread).
const IDLE_MS = 3000;
const IDLE_RECALC_SLACK = 15;

type SweepResult = {
  /** Gaps between consecutive animation frames, in ms. */
  frames: number[];
  /** Wall-clock length of the sweep in the page, in ms. */
  elapsed: number;
  /** deviceorientation events actually dispatched. */
  events: number;
  /** Calls to querySelectorAll whose selector names the lit panels, made inside an animation frame callback, and all calls. */
  qsaLight: number;
  qsaAll: number;
  /** Calls that wrote --light-x or --light-y, through style.setProperty, and --wander-x or --wander-y. */
  lightWrites: number;
  wanderWrites: number;
  /** Times the light moved: bursts of writes (of an animation's time or of the properties) at least 5 ms apart. */
  updates: number;
  /** "long-animation-frame" entries (a frame that blocked the main thread over 50 ms). */
  longFrames: number;
};

type Counters = Record<string, number>;

type Row = {
  rate: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over33: number;
  recalcCount: number;
  recalcMs: number;
  layoutCount: number;
  taskMs: number;
  scriptMs: number;
  qsaLight: number;
  lightWrites: number;
  /** Writes of --wander-x or --wander-y during the sweep. */
  wanderWrites: number;
  /** Light updates per second, and per animation frame. */
  updateHz: number;
  updatesPerFrame: number;
  longFrames: number;
  paints?: number;
  rasters?: number;
  /** Frames the compositor drew in the traced sweep (Display::DrawAndSwap; the wander test traces them). */
  swaps?: number;
  /** Elements the style system revisited during the traced sweep, and the light updates in that sweep. */
  restyled?: number;
  tracedUpdates?: number;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** Counts calls the page makes, before any of the page's own scripts exist. */
async function installSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy = { qsaLight: 0, qsaAll: 0, lightWrites: 0, wanderWrites: 0, updates: 0 };
    (window as unknown as { __spy: typeof spy }).__spy = spy;
    // The light's own code runs from an animation frame callback. A search for the panels made anywhere
    // else (a re-render, the observer that follows a card being added) is the page's other business.
    let inFrame = 0;
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      requestFrame((time) => {
        inFrame++;
        try {
          callback(time);
        } finally {
          inFrame--;
        }
      });
    for (const proto of [Document.prototype, Element.prototype]) {
      const original = proto.querySelectorAll;
      proto.querySelectorAll = function (this: ParentNode, selector: string) {
        spy.qsaAll++;
        if (inFrame > 0 && typeof selector === "string" && selector.includes(".surface")) spy.qsaLight++;
        return original.call(this, selector);
      } as typeof original;
    }
    // One move of the light is a burst of writes (every panel's animations, or both properties).
    let lastWrite = Number.NEGATIVE_INFINITY;
    const wrote = () => {
      const now = performance.now();
      if (now - lastWrite > 5) spy.updates++;
      lastWrite = now;
    };
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, ...rest: never[]) {
      if (typeof name === "string" && name.startsWith("--light-")) {
        spy.lightWrites++;
        wrote();
      }
      // The wandering card light's steps (src/components/status/wander-light.ts): a few a second, not a write per frame.
      if (typeof name === "string" && name.startsWith("--wander-")) spy.wanderWrites++;
      return (setProperty as (...args: unknown[]) => void).call(this, name, ...rest);
    } as typeof setProperty;
    const time = Object.getOwnPropertyDescriptor(Animation.prototype, "currentTime");
    if (time?.set) {
      const set = time.set;
      Object.defineProperty(Animation.prototype, "currentTime", {
        ...time,
        set(this: Animation, value: CSSNumberish | null) {
          if (this.id === "tilt-light-x" || this.id === "tilt-light-y") wrote();
          set.call(this, value);
        },
      });
    }
    // A browser with no sensor fires one empty reading of its own as soon as something
    // listens. Only the sweep's readings should count.
    window.addEventListener("deviceorientation", (event) => event.isTrusted && event.stopImmediatePropagation(), true);
  });
}

/**
 * Runs one sweep in the page: ~90 readings a second on a smooth path through
 * the tilt range, while recording the animation frame gaps and the spy.
 */
function sweep(page: Page, durationMs: number): Promise<SweepResult> {
  return page.evaluate(
    (durationMs) =>
      new Promise<SweepResult>((resolve) => {
        const spy = (
          window as unknown as {
            __spy: { qsaLight: number; qsaAll: number; lightWrites: number; wanderWrites: number; updates: number };
          }
        ).__spy;
        const before = { ...spy };
        const frames: number[] = [];
        let longFrames = 0;
        let observer: PerformanceObserver | null = null;
        try {
          observer = new PerformanceObserver((list) => {
            longFrames += list.getEntries().length;
          });
          observer.observe({ type: "long-animation-frame", buffered: false });
        } catch {
          // Not every engine reports long animation frames.
        }
        const start = performance.now();
        let events = 0;
        // Time-based, not count-based: a throttled timer fires late, and the sweep must stay smooth.
        const dispatch = () => {
          const t = (performance.now() - start) / 1000;
          const beta = 40 + 30 * Math.sin((2 * Math.PI * t) / 1.7);
          const gamma = 45 * Math.sin((2 * Math.PI * t) / 2.3);
          const event = new Event("deviceorientation");
          for (const [key, value] of Object.entries({ alpha: 0, beta, gamma, absolute: false })) {
            Object.defineProperty(event, key, { value });
          }
          window.dispatchEvent(event);
          events++;
        };
        const timer = window.setInterval(dispatch, 11);
        let last = 0;
        const onFrame = (now: number) => {
          if (last) frames.push(now - last);
          last = now;
          if (now - start < durationMs) {
            requestAnimationFrame(onFrame);
            return;
          }
          window.clearInterval(timer);
          observer?.disconnect();
          resolve({
            frames,
            elapsed: now - start,
            events,
            qsaLight: spy.qsaLight - before.qsaLight,
            qsaAll: spy.qsaAll - before.qsaAll,
            lightWrites: spy.lightWrites - before.lightWrites,
            wanderWrites: spy.wanderWrites - before.wanderWrites,
            updates: spy.updates - before.updates,
            longFrames,
          });
        };
        requestAnimationFrame(onFrame);
      }),
    durationMs,
  );
}

async function counters(cdp: import("@playwright/test").CDPSession): Promise<Counters> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

/** One timed sweep at the current throttle, with the browser's counters around it. */
async function measure(page: Page, cdp: import("@playwright/test").CDPSession, rate: number): Promise<Row> {
  const a = await counters(cdp);
  const result = await sweep(page, SWEEP_MS);
  const b = await counters(cdp);
  const seconds = result.elapsed / 1000;
  const delta = (name: string) => (b[name] - a[name]) / seconds;
  const frames = result.frames;
  return {
    rate,
    fps: frames.length / seconds,
    p50: percentile(frames, 50),
    p95: percentile(frames, 95),
    p99: percentile(frames, 99),
    max: Math.max(...frames),
    over33: frames.filter((gap) => gap > 33.5).length,
    // Per second of the sweep.
    recalcCount: delta("RecalcStyleCount"),
    recalcMs: delta("RecalcStyleDuration") * 1000,
    layoutCount: delta("LayoutCount"),
    taskMs: delta("TaskDuration") * 1000,
    scriptMs: delta("ScriptDuration") * 1000,
    qsaLight: result.qsaLight,
    lightWrites: result.lightWrites,
    wanderWrites: result.wanderWrites,
    updateHz: result.updates / seconds,
    updatesPerFrame: result.updates / Math.max(1, frames.length),
    longFrames: result.longFrames,
  };
}

/** A traced sweep: how many paints and raster tasks the browser did. Timing from this pass is not used. */
async function traceCounts(
  page: Page,
  cdp: import("@playwright/test").CDPSession,
  viz = false,
): Promise<{ paints: number; rasters: number; restyled: number; updates: number; swaps: number }> {
  const names: string[] = [];
  let restyled = 0;
  const onData = (payload: { value: { name?: string; ph?: string; args?: { elementCount?: number } }[] }) => {
    for (const event of payload.value) {
      if (!event.name || event.ph === "M") continue;
      names.push(event.name);
      if (event.name === "UpdateLayoutTree") restyled += event.args?.elementCount ?? 0;
    }
  };
  cdp.on("Tracing.dataCollected", onData);
  const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", ...(viz ? ["viz"] : [])],
    },
  });
  const traced = await sweep(page, TRACE_MS);
  await cdp.send("Tracing.end");
  await complete;
  cdp.off("Tracing.dataCollected", onData);
  return {
    paints: names.filter((name) => name === "Paint").length,
    rasters: names.filter((name) => name === "RasterTask").length,
    restyled,
    updates: traced.updates,
    swaps: names.filter((name) => name === "Display::DrawAndSwap").length,
  };
}

/**
 * An idle window: nothing of the test's own runs (no sweep, no animation frame loop), so any style recalculation
 * the trace shows comes from the page itself. A transform animation on the compositor leaves a handful; one
 * animated on the main thread makes a frame, and a recalculation, every frame.
 */
async function idleCounts(
  page: Page,
  cdp: import("@playwright/test").CDPSession,
): Promise<{ recalcs: number; paints: number }> {
  const names: string[] = [];
  const onData = (payload: { value: { name?: string; ph?: string }[] }) => {
    for (const event of payload.value) if (event.name && event.ph !== "M") names.push(event.name);
  };
  cdp.on("Tracing.dataCollected", onData);
  const complete = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] },
  });
  await page.waitForTimeout(IDLE_MS);
  await cdp.send("Tracing.end");
  await complete;
  cdp.off("Tracing.dataCollected", onData);
  return {
    recalcs: names.filter((name) => name === "UpdateLayoutTree").length,
    paints: names.filter((name) => name === "Paint").length,
  };
}

/** Elements the style system revisited per move of the light, in the traced sweep. */
const restyledPerUpdate = (row: Row) => (row.restyled ?? 0) / Math.max(1, row.tracedUpdates ?? 0);

const f = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "n/a");

function table(label: string, rows: Row[]): string {
  const head = [
    "throttle",
    "fps",
    "p50 ms",
    "p95 ms",
    "p99 ms",
    "max ms",
    ">33ms",
    "recalc/s",
    "recalc ms/s",
    "layout/s",
    "task ms/s",
    "script ms/s",
    "qSA(light)",
    "light writes",
    "updates/s",
    "updates/frame",
    "LoAF",
    "paints",
    "rasters",
    "swaps",
    "restyled/update",
  ];
  const lines = rows.map((row) =>
    [
      `${row.rate}x`,
      f(row.fps),
      f(row.p50),
      f(row.p95),
      f(row.p99),
      f(row.max),
      String(row.over33),
      f(row.recalcCount),
      f(row.recalcMs),
      f(row.layoutCount),
      f(row.taskMs),
      f(row.scriptMs),
      String(row.qsaLight),
      String(row.lightWrites),
      f(row.updateHz),
      f(row.updatesPerFrame, 2),
      String(row.longFrames),
      row.paints === undefined ? "-" : String(row.paints),
      row.rasters === undefined ? "-" : String(row.rasters),
      row.swaps === undefined ? "-" : String(row.swaps),
      row.restyled === undefined ? "-" : f(restyledPerUpdate(row), 1),
    ].join(" | "),
  );
  return [`[tilt-perf] ${label}`, head.join(" | "), ...lines].join("\n");
}

/** The median of each number across the runs. */
function medianRow(rows: Row[]): Row {
  const pick = (key: keyof Row) => median(rows.map((row) => Number(row[key])));
  return {
    rate: rows[0].rate,
    fps: pick("fps"),
    p50: pick("p50"),
    p95: pick("p95"),
    p99: pick("p99"),
    max: pick("max"),
    over33: pick("over33"),
    recalcCount: pick("recalcCount"),
    recalcMs: pick("recalcMs"),
    layoutCount: pick("layoutCount"),
    taskMs: pick("taskMs"),
    scriptMs: pick("scriptMs"),
    qsaLight: pick("qsaLight"),
    lightWrites: pick("lightWrites"),
    wanderWrites: pick("wanderWrites"),
    updateHz: pick("updateHz"),
    updatesPerFrame: pick("updatesPerFrame"),
    longFrames: pick("longFrames"),
  };
}

/**
 * Sweeps the page at each throttle rate and returns the median of the timed runs (`runsAt` says how many per
 * rate), with the trace counts. `label` names the tables; the console gets every run, the attachment gets the medians.
 */
async function collect(page: Page, label: string, runsAt: (rate: number) => number, viz = false): Promise<Row[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const medians: Row[] = [];
  try {
    for (const rate of [1, 4, 6]) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await sweep(page, WARMUP_MS);
      const each: Row[] = [];
      for (let run = 0; run < runsAt(rate); run++) each.push(await measure(page, cdp, rate));
      const row = medianRow(each);
      const traced = await traceCounts(page, cdp, viz);
      row.paints = traced.paints;
      row.rasters = traced.rasters;
      if (viz) row.swaps = traced.swaps;
      row.restyled = traced.restyled;
      row.tracedUpdates = traced.updates;
      medians.push(row);
      console.log(table(`${label}, runs at ${rate}x`, each));
    }
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
  return medians;
}

async function openBoard(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('article[id^="service-"]')).toHaveCount(SERVICES);
  // data-hydrated waits for the saved checks, a few renders after the first: 15 s on a loaded runner, as in board.spec.ts.
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
}

/** Elements that carry the light as an inline property: it is meant to be written on one at most. */
const holders = (page: Page) => page.evaluate(() => document.querySelectorAll('[style*="--light-"]').length);

/**
 * Seeds a saved choice. A saved "on" is checked once with the browser, which is asked outside a tap whether
 * motion is still allowed (src/components/status/use-tilt-lighting.ts), and a browser that has
 * DeviceOrientationEvent.requestPermission and does not say "granted" gets the choice dropped: iOS does,
 * and so does Chromium 154, the headless shell CI runs (it answers "prompt" until motion is granted to the
 * page; Chromium 141 has no such call). The test grants motion to its context (see grantMotion), as a
 * visitor who allowed it would have it.
 */
const seed = (page: Page, tilt: "on" | "off", background: "glass" | "full" = "glass") =>
  page.addInitScript(
    ([tiltKey, tilt, background]) => {
      try {
        localStorage.setItem("status-bar:background", background);
        localStorage.setItem(tiltKey, tilt);
      } catch {
        // Storage can refuse; the test then fails at the data-tilt check.
      }
    },
    [TILT_STORAGE_KEY, tilt, background],
  );

/** Motion allowed for the pages of a context, which is what the browser's own permission call then answers. */
const grantMotion = (context: BrowserContext) => context.grantPermissions(["accelerometer", "gyroscope"]);

/** One reading, so a saved "on" is answered (the page forgets a saved choice that gets none in 3 s). */
const firstReading = (page: Page) =>
  expect
    .poll(
      async () => {
        await page.evaluate(() => {
          const event = new Event("deviceorientation");
          for (const [key, value] of Object.entries({ alpha: 0, beta: 0, gamma: 0, absolute: false })) {
            Object.defineProperty(event, key, { value });
          }
          window.dispatchEvent(event);
        });
        return page.locator("html").getAttribute("data-tilt");
      },
      { timeout: 10_000, intervals: [50, 100, 200] },
    )
    .toBe("on");

test.describe("tilt performance", () => {
  test.skip(({ hasTouch }) => !hasTouch, "tilt lighting is for touch devices");
  test.skip(({ browserName }) => browserName !== "chromium", "needs the DevTools protocol");

  // The same sweep first with Tilt lighting off (the readings go to nobody): what that costs is
  // the floor (the timer, the frame loop and the page's own work), which the lit run cannot get
  // under. Then with it on. What is asserted are counts that machine load does not change (document
  // searches, paints, raster tasks, elements restyled per move of the light). Durations and frame
  // timing move with whatever else the machine is doing, so they are logged and attached, not asserted.
  test("lights the glass smoothly on a throttled CPU", async ({ page, context }, testInfo) => {
    test.setTimeout(300_000);
    await grantMotion(context);
    await installSpy(page);
    await seed(page, "off");
    await openBoard(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-tilt");
    // The floor is only compared by its trace counts and reported, so a single timed sweep per rate does.
    const floor = await collect(page, "light off", () => 1);
    console.log(table(`${testInfo.project.name}, light off`, floor));
    await page.close();

    const lit = await context.newPage();
    await installSpy(lit);
    await seed(lit, "on");
    await openBoard(lit);
    await firstReading(lit);
    const medians = await collect(lit, testInfo.project.name, (rate) => (rate === 1 ? RUNS : 1));
    const report = table(`${testInfo.project.name}, median of ${RUNS} runs at 1x, one at the throttled rates`, medians);
    console.log(report);
    await testInfo.attach("tilt-performance", { body: report, contentType: "text/plain" });
    // The light must still be driven after the sweeps, from one element at most.
    await expect(lit.locator("html")).toHaveAttribute("data-tilt", "on");
    expect(await holders(lit)).toBeLessThanOrEqual(1);
    expect(medians[0].fps).toBeGreaterThan(0);
    if (process.env.TILT_PERF_REPORT_ONLY) return;

    // Measured on unchanged code (every panel written on, a document search per write), at 4x:
    //   recalc 250-490 ms/s, 120-160 traced paints and 100-130 raster tasks per 3 s, task time 450-690 ms/s,
    //   far more elements restyled per move of the light (every panel's subtree), 7-10 light updates a second (about one
    //   frame in five), 38-46 fps (light off: 49-55); at 6x similar or worse.
    // And on this code, at 4x: 4-8 traced paints and 2-4 raster tasks, about 4 elements restyled per move of
    //   the light (the pseudo-elements), recalc 30-55 ms/s alone and more beside other tests, task time
    //   160-360 ms/s over the light-off run's (the commit of the sliding layers, see the CHANGELOG).
    // Style recalculation time, task time and frame timing depend on the machine's load (and a software
    // compositor in headless Chromium pays for each commit), so they are in the table and not asserted.
    // Counts of work done do not depend on it, and they are what tell this code from the old.
    medians.forEach((row, index) => {
      const base = floor[index];
      const at = `at ${row.rate}x`;
      // No search of the document for the panels while the light moves.
      expect(row.qsaLight, `document searches for the panels from frame callbacks ${at}`).toBe(0);
      // Nothing is repainted: the traced paints and raster tasks stay near the still page's own.
      expect(row.paints ?? 0, `paints ${at}, over the light-off run's ${base.paints}`).toBeLessThanOrEqual(
        (base.paints ?? 0) + 40,
      );
      expect(row.rasters ?? 0, `raster tasks ${at}, over the light-off run's ${base.rasters}`).toBeLessThanOrEqual(
        (base.rasters ?? 0) + 30,
      );
      // The style system revisits the pseudo-elements and not the board's panels with their rows, as the old path did on every write.
      expect(row.tracedUpdates ?? 0, `light updates in the traced sweep ${at}`).toBeGreaterThan(0);
      expect(restyledPerUpdate(row), `elements restyled per move of the light ${at}`).toBeLessThanOrEqual(40);
      console.log(
        `[tilt-perf] ${at}, over the light-off run: p95 ${f(row.p95 - base.p95)} ms, ${row.over33 - base.over33} more frames over 33 ms, ${f(base.fps - row.fps)} fps lower, recalc ${f(row.recalcMs - base.recalcMs)} ms/s`,
      );
    });
    // The light moves on nearly every frame of a screen that keeps up (it was every second frame at
    // best, and every fifth under load, when it was capped at about 30 a second), so the glow follows
    // a 60 or 120 Hz screen instead of stepping. When frames overrun, whatever the cause (a throttled
    // CPU, or other tests running on the same machine), the writes back off on purpose (createWritePacer),
    // so this is asserted only for an unthrottled run whose own frames were on time; the other rows report it.
    expect(medians[0].rate).toBe(1);
    if (medians[0].p95 > 20) {
      console.log(
        `[tilt-perf] light updates per frame not asserted: the frames themselves were late (p95 ${f(medians[0].p95)} ms, ${f(medians[0].updatesPerFrame, 2)} updates per frame)`,
      );
      return;
    }
    expect(medians[0].updatesPerFrame, "light updates per animation frame at 1x").toBeGreaterThanOrEqual(0.65);
  });

  // The card light that wanders by itself in Glass and Full (src/background.css, src/components/status/wander-light.ts):
  // on a phone or tablet it runs with Tilt lighting off, so it must not bring the lag back. The floor is the same page
  // with only the wander's layer hidden (a style rule added by the test), so the difference between the two runs is the
  // wandering light and nothing else. Both runs stop the period dial's sweep (.period-dial): it animates a registered
  // property, so by itself it costs a recalculation on nearly every frame, which would hide the wander's share.
  //
  // What this guards is the cost of the frosted panels. A layer that moves inside (or over) a panel with a
  // backdrop-filter makes the compositor draw the panel's blur again on every frame it moves, whatever its size
  // (a 40px square cost what a panel-sized one did), and a CSS animation moves it on every frame. Measured at 4x on a
  // Pixel 7 profile with that design (a panel-sized layer, a CSS animation): about 100-170 frames drawn in 3 s against 3-15
  // for the still page, 400-750 ms of the compositor's CPU time against 1, and a third of the frame rate. So the light is
  // stepped about twice a second instead (wander-light.ts) and what is asserted are counts that load does not change:
  //   - the layer is a fixed 432px square on every card, not the card's own size;
  //   - the frames the compositor drew in the traced 3 s stay near the floor's (the old design adds a hundred or more);
  //   - the page wrote the light's place a few times a second per card and no more, and nothing of Tilt lighting's;
  //   - nothing repainted or rasterised for it, and few elements were restyled;
  //   - in an idle window (no sweep, no frame loop) it adds a handful of style recalculations, not one a frame.
  // Timings (fps, frame gaps) are in the table, not asserted: they move with how busy the machine is.
  for (const background of ["full", "glass"] as const) {
    test(`lets the card light wander in ${background === "full" ? "Full" : "Glass"} on a throttled CPU without redrawing the glass every frame`, async ({
      page,
      context,
    }, testInfo) => {
      test.setTimeout(300_000);
      const lights = (target: Page) =>
        target.evaluate(() => {
          const drawn = [...document.querySelectorAll<HTMLElement>(".spotlight[data-wander]")].filter(
            (card) => getComputedStyle(card, "::after").display !== "none" && card.style.getPropertyValue("--wander-x"),
          );
          return {
            count: drawn.length,
            sizes: [
              ...new Set(drawn.map((card) => getComputedStyle(card, "::after")).map((s) => `${s.width} ${s.height}`)),
            ],
            animations: document
              .getAnimations()
              .filter(
                (animation) => animation instanceof CSSAnimation && animation.animationName.startsWith("light-wander"),
              ).length,
          };
        });
      await grantMotion(context);
      await installSpy(page);
      await seed(page, "off", background);
      await openBoard(page);
      await page.addStyleTag({ content: `${STILL_DIAL} .spotlight::after { display: none !important; }` });
      await expect(page.locator("html")).not.toHaveAttribute("data-tilt");
      expect((await lights(page)).count, "wandering lights with the wander's layer hidden").toBe(0);
      const floor = await collect(page, "card light off", () => 1, true);
      console.log(table(`${testInfo.project.name}, ${background}, card light off`, floor));
      // Idle: dial still, no sweep, no frame loop of the test's own.
      const floorIdle = await idleCounts(page, await context.newCDPSession(page));
      await page.close();

      const lit = await context.newPage();
      await installSpy(lit);
      await seed(lit, "off", background);
      await openBoard(lit);
      await lit.addStyleTag({ content: STILL_DIAL });
      await expect(lit.locator("html")).toHaveAttribute("data-background", background);
      await expect(lit.locator("html")).not.toHaveAttribute("data-tilt");
      await expect
        .poll(async () => (await lights(lit)).count, { message: "lights wandering on every card" })
        .toBeGreaterThan(5);
      const medians = await collect(
        lit,
        `${testInfo.project.name}, ${background}, card light wandering`,
        () => 1,
        true,
      );
      const report = table(`${testInfo.project.name}, ${background}, card light wandering`, medians);
      console.log(report);
      await testInfo.attach(`wander-performance-${background}`, { body: report, contentType: "text/plain" });
      // Still wandering after the sweeps, and not driven by Tilt lighting.
      const after = await lights(lit);
      expect(after.count, "lights wandering after the sweeps").toBeGreaterThan(5);
      await expect(lit.locator("html")).not.toHaveAttribute("data-tilt");
      expect(await holders(lit)).toBe(0);
      if (process.env.TILT_PERF_REPORT_ONLY) return;

      // The layer the compositor moves is the light's own size on every card, never the card's: a card-sized layer
      // is damaged over the whole card, and a long list's is two lists high.
      expect(after.sizes, "sizes of the moving layers").toEqual(["432px 432px"]);
      // Moved by script a step at a time, not by a CSS animation.
      expect(after.animations, "CSS animations of the old wander").toBe(0);

      // Idle again, with nothing of the test's own asking for frames: the wander alone must not keep the main
      // thread producing frames.
      const litIdle = await idleCounts(lit, await context.newCDPSession(lit));
      console.log(
        `[wander-perf] ${background} idle ${IDLE_MS / 1000} s: ${litIdle.recalcs} style recalcs (card light off: ${floorIdle.recalcs}), ${litIdle.paints} paints (card light off: ${floorIdle.paints})`,
      );
      expect(
        litIdle.recalcs,
        `style recalculations in an idle ${IDLE_MS / 1000} s with the wander running, over the card-light-off run's ${floorIdle.recalcs}`,
      ).toBeLessThanOrEqual(floorIdle.recalcs + IDLE_RECALC_SLACK);
      expect(litIdle.paints, "paints in the idle window").toBeLessThanOrEqual(floorIdle.paints + PAINT_SLACK);

      const cards = after.count;
      medians.forEach((row, index) => {
        const base = floor[index];
        const at = `at ${row.rate}x`;
        expect(row.paints ?? 0, `paints ${at}, over the card-light-off run's ${base.paints}`).toBeLessThanOrEqual(
          (base.paints ?? 0) + PAINT_SLACK,
        );
        expect(
          row.rasters ?? 0,
          `raster tasks ${at}, over the card-light-off run's ${base.rasters}`,
        ).toBeLessThanOrEqual((base.rasters ?? 0) + RASTER_SLACK);
        // The glass is not redrawn every frame: a frame drawn per step of the light at most, a few a second.
        expect(
          row.swaps ?? 0,
          `frames the compositor drew in the traced ${TRACE_MS / 1000} s ${at} (the card-light-off run's ${base.swaps})`,
        ).toBeLessThanOrEqual((base.swaps ?? 0) + SWAP_SLACK);
        // At most one place written per step of the light and card, two properties each (a step takes in the sweep's
        // length, one more for a step on either edge, one for the first, which fills every card).
        const steps = SWEEP_MS / WANDER_TICK_MS + 2;
        // The restyle count is the traced sweep's, which is TRACE_MS long.
        const tracedSteps = TRACE_MS / WANDER_TICK_MS + 2;
        expect(
          row.wanderWrites,
          `writes of the light's place in one ${SWEEP_MS / 1000} s sweep ${at}`,
        ).toBeLessThanOrEqual(cards * 2 * steps);
        // Style: at most one recalculation per frame, and a few elements per card and step.
        expect(
          row.recalcCount,
          `style recalculations a second ${at} (${f(row.fps)} fps; the card-light-off run's ${f(base.recalcCount)})`,
        ).toBeLessThanOrEqual(row.fps + 5);
        expect(
          row.restyled ?? 0,
          `elements restyled in the traced sweep ${at} for ${cards} lights (the card-light-off run's ${base.restyled})`,
        ).toBeLessThanOrEqual((base.restyled ?? 0) + cards * tracedSteps * RESTYLE_PER_STEP);
        // No work of the light's own: nothing writes the tilt light, nothing searches for the panels.
        expect(row.qsaLight, `document searches from frame callbacks ${at}`).toBe(0);
        expect(row.lightWrites, `tilt light writes ${at}`).toBe(0);
        console.log(
          `[wander-perf] ${background} ${at}, over the card-light-off run: ${(row.swaps ?? 0) - (base.swaps ?? 0)} frames drawn, ${(row.paints ?? 0) - (base.paints ?? 0)} paints, ${(row.rasters ?? 0) - (base.rasters ?? 0)} raster tasks, ${(row.restyled ?? 0) - (base.restyled ?? 0)} elements restyled, ${f(row.recalcCount - base.recalcCount)} recalcs/s, p95 ${f(row.p95 - base.p95)} ms, ${f(base.fps - row.fps)} fps lower`,
        );
      });
    });
  }
});
