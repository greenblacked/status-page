import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { TILT_STORAGE_KEY } from "../src/lib/status/tilt.ts";

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
// TILT_PERF_RUNS (default 3) sets how many timed sweeps are made per throttle
// rate; the medians are reported and asserted. The numbers print as a table.

const RUNS = Number(process.env.TILT_PERF_RUNS) || 3;
const SWEEP_MS = 3000;
const WARMUP_MS = 1000;
const SERVICES = 20;

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
  /** Calls that wrote --light-x or --light-y, through style.setProperty. */
  lightWrites: number;
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
  /** Light updates per second, and per animation frame. */
  updateHz: number;
  updatesPerFrame: number;
  longFrames: number;
  paints?: number;
  rasters?: number;
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
    const spy = { qsaLight: 0, qsaAll: 0, lightWrites: 0, updates: 0 };
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
          window as unknown as { __spy: { qsaLight: number; qsaAll: number; lightWrites: number; updates: number } }
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
    updateHz: result.updates / seconds,
    updatesPerFrame: result.updates / Math.max(1, frames.length),
    longFrames: result.longFrames,
  };
}

/** A traced sweep: how many paints and raster tasks the browser did. Timing from this pass is not used. */
async function traceCounts(
  page: Page,
  cdp: import("@playwright/test").CDPSession,
): Promise<{ paints: number; rasters: number; restyled: number; updates: number }> {
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
    traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] },
  });
  const traced = await sweep(page, SWEEP_MS);
  await cdp.send("Tracing.end");
  await complete;
  cdp.off("Tracing.dataCollected", onData);
  return {
    paints: names.filter((name) => name === "Paint").length,
    rasters: names.filter((name) => name === "RasterTask").length,
    restyled,
    updates: traced.updates,
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
    updateHz: pick("updateHz"),
    updatesPerFrame: pick("updatesPerFrame"),
    longFrames: pick("longFrames"),
  };
}

/**
 * Sweeps the page at each throttle rate and returns the median of the timed runs, with the trace counts.
 * `label` names the tables; the console gets every run, the attachment gets the medians.
 */
async function collect(page: Page, label: string, runs: number): Promise<Row[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const medians: Row[] = [];
  try {
    for (const rate of [1, 4, 6]) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await sweep(page, WARMUP_MS);
      const each: Row[] = [];
      for (let run = 0; run < runs; run++) each.push(await measure(page, cdp, rate));
      const row = medianRow(each);
      const traced = await traceCounts(page, cdp);
      row.paints = traced.paints;
      row.rasters = traced.rasters;
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
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
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
const seed = (page: Page, tilt: "on" | "off") =>
  page.addInitScript(
    ([tiltKey, tilt]) => {
      try {
        localStorage.setItem("status-bar:background", "glass");
        localStorage.setItem(tiltKey, tilt);
      } catch {
        // Storage can refuse; the test then fails at the data-tilt check.
      }
    },
    [TILT_STORAGE_KEY, tilt],
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
    const floor = await collect(page, "light off", RUNS);
    console.log(table(`${testInfo.project.name}, light off, median of ${RUNS} runs`, floor));
    await page.close();

    const lit = await context.newPage();
    await installSpy(lit);
    await seed(lit, "on");
    await openBoard(lit);
    await firstReading(lit);
    const medians = await collect(lit, testInfo.project.name, RUNS);
    const report = table(`${testInfo.project.name}, median of ${RUNS} runs`, medians);
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
});
