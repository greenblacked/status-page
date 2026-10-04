import { expect, type Page, test } from "@playwright/test";
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
//   - how often the page called document/element.querySelectorAll with the
//     light selector, and wrote --light-x/--light-y, through a spy installed
//     before the page's own scripts run;
//   - from a second, traced sweep, how many times the main thread painted and
//     how many raster tasks ran (tracing slows the page, so no timing is taken
//     from that pass).
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
  /** Calls to querySelectorAll whose selector names the lit panels, and all calls. */
  qsaLight: number;
  qsaAll: number;
  /** Calls that wrote --light-x or --light-y, through style.setProperty. */
  lightWrites: number;
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
  qsaLight: number;
  lightWrites: number;
  longFrames: number;
  paints?: number;
  rasters?: number;
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
    const spy = { qsaLight: 0, qsaAll: 0, lightWrites: 0 };
    (window as unknown as { __spy: typeof spy }).__spy = spy;
    for (const proto of [Document.prototype, Element.prototype]) {
      const original = proto.querySelectorAll;
      proto.querySelectorAll = function (this: ParentNode, selector: string) {
        spy.qsaAll++;
        if (typeof selector === "string" && selector.includes(".surface")) spy.qsaLight++;
        return original.call(this, selector);
      } as typeof original;
    }
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, ...rest: never[]) {
      if (typeof name === "string" && name.startsWith("--light-")) spy.lightWrites++;
      return (setProperty as (...args: unknown[]) => void).call(this, name, ...rest);
    } as typeof setProperty;
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
        const spy = (window as unknown as { __spy: { qsaLight: number; qsaAll: number; lightWrites: number } }).__spy;
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
    qsaLight: result.qsaLight,
    lightWrites: result.lightWrites,
    longFrames: result.longFrames,
  };
}

/** A traced sweep: how many paints and raster tasks the browser did. Timing from this pass is not used. */
async function traceCounts(
  page: Page,
  cdp: import("@playwright/test").CDPSession,
): Promise<{ paints: number; rasters: number }> {
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
  await sweep(page, SWEEP_MS);
  await cdp.send("Tracing.end");
  await complete;
  cdp.off("Tracing.dataCollected", onData);
  return {
    paints: names.filter((name) => name === "Paint").length,
    rasters: names.filter((name) => name === "RasterTask").length,
  };
}

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
    "qSA(light)",
    "light writes",
    "LoAF",
    "paints",
    "rasters",
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
      String(row.qsaLight),
      String(row.lightWrites),
      String(row.longFrames),
      row.paints === undefined ? "-" : String(row.paints),
      row.rasters === undefined ? "-" : String(row.rasters),
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
    qsaLight: pick("qsaLight"),
    lightWrites: pick("lightWrites"),
    longFrames: pick("longFrames"),
  };
}

test.describe("tilt performance", () => {
  test.skip(({ hasTouch }) => !hasTouch, "tilt lighting is for touch devices");
  test.skip(({ browserName }) => browserName !== "chromium", "needs the DevTools protocol");

  test.beforeEach(async ({ page }) => {
    await installSpy(page);
    await page.addInitScript(
      ([tiltKey]) => {
        try {
          localStorage.setItem("status-bar:background", "glass");
          localStorage.setItem(tiltKey, "on");
        } catch {
          // Storage can refuse; the test then fails at the data-tilt check below.
        }
      },
      [TILT_STORAGE_KEY],
    );
  });

  test("lights the glass smoothly on a throttled CPU", async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    await page.goto("/");
    await expect(page.locator('article[id^="service-"]')).toHaveCount(SERVICES);
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    // The first reading turns the light on; the page forgets a saved choice that gets none in 3 s.
    await expect
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

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const medians: Row[] = [];
    try {
      for (const rate of [4, 6]) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        await sweep(page, WARMUP_MS);
        const runs: Row[] = [];
        for (let run = 0; run < RUNS; run++) runs.push(await measure(page, cdp, rate));
        const row = medianRow(runs);
        const traced = await traceCounts(page, cdp);
        row.paints = traced.paints;
        row.rasters = traced.rasters;
        medians.push(row);
        console.log(table(`${testInfo.project.name}, runs at ${rate}x`, runs));
      }
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    }
    const report = table(`${testInfo.project.name}, median of ${RUNS} runs`, medians);
    console.log(report);
    await testInfo.attach("tilt-performance", { body: report, contentType: "text/plain" });
    // The light must still be driven after the sweeps.
    await expect(page.locator("html")).toHaveAttribute("data-tilt", "on");
    expect(medians[0].fps).toBeGreaterThan(0);
  });
});
