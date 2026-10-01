import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CATALOG } from "../src/lib/status/catalog.ts";
import { DOCK_HYSTERESIS, DOCK_MS, transitionMs } from "../src/lib/status/dock.ts";
import { PULSE_STORAGE_KEY } from "../src/lib/status/pulse.ts";
import type { BoardSnapshot } from "../src/lib/status/types.ts";
import { calmBoard, fixtureBoard, longHeroBoard, serveBoard } from "./fixture-board";

const SERVICES = 14;
const cards = (page: Page) => page.locator('article[id^="service-"]');
/** The services of one board group: "attention", "unread" (Couldn't read), "up" (every category's list) or "releases". */
const group = (page: Page, id: "attention" | "unread" | "up" | "releases") =>
  page.locator(`[data-group="${id}"] article[id^="service-"]`);
/** The healthy services of one category's list, such as "ai". */
const upList = (page: Page, category: string) =>
  page.locator(`section[aria-labelledby="up-${category}-heading"] article[id^="service-"]`);

/**
 * Waits until React has hydrated the page. The server's markup, cards
 * included, paints before that, and a click on it goes nowhere: on a slow
 * device (WebKit on a phone) a test that clicks as soon as the cards are
 * there can beat the handlers, and the click is lost for good.
 */
async function hydrated(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
}

/**
 * Waits until every card glide has finished, including any started meanwhile.
 * Starring a card and a refresh glide the cards that moved to their new place
 * (withCardMotion in src/components/status/effects.ts) with a transform-only
 * animation named "card-move"; the update itself has applied by then, so this
 * only lets the motion settle before a test reads positions.
 */
async function motionDone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const glides = () => document.getAnimations().filter((animation) => animation.id === "card-move");
    let timer: number | undefined;
    // A glide lasts a quarter of a second; one that outlives this is stuck, and says so.
    const stuck = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("card glide did not finish in 10 s")), 10_000);
    });
    const settled = (async () => {
      for (let running = glides(); running.length > 0; running = glides()) {
        await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
      }
    })();
    try {
      await Promise.race([settled, stuck]);
    } finally {
      window.clearTimeout(timer);
    }
  });
}

/** Runs `press` (a click or a key that toggles a star), then lets the cards' glide settle. */
async function toggleStar(page: Page, press: () => Promise<void>): Promise<void> {
  await press();
  await motionDone(page);
}

/**
 * Presses a Refresh button and waits for all of it: the forced response, the
 * button leaving its busy state, one frame for the cache write to reach the
 * page, then the cards' glide.
 */
async function pressRefresh(page: Page, button: Locator, press = () => button.click()): Promise<void> {
  const answered = page.waitForResponse(
    (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
  );
  await press();
  await answered;
  await expect(button).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await motionDone(page);
}

/** Records every animation the page starts, so a test can count the card glides even after they end. */
async function recordAnimations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked = window as Window & { __animations?: Animation[] };
    tracked.__animations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = animate.apply(this, args);
      tracked.__animations?.push(animation);
      return animation;
    };
  });
}

/**
 * Records what a glide depends on, so a failure on a slow browser says why: the person's input events
 * (type, time, trusted), when Grok's card changed section, and, from the product code, the
 * performance marks card-motion:start and card-motion:glide.
 */
async function traceGlides(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked = window as Window & { __glideTrace?: Record<string, unknown>[] };
    tracked.__glideTrace = [];
    const note = (entry: Record<string, unknown>) =>
      tracked.__glideTrace?.push({ ...entry, t: Math.round(performance.now()) });
    for (const type of ["pointerdown", "keydown", "input", "resize", "orientationchange"]) {
      window.addEventListener(type, (event) => note({ type, trusted: event.isTrusted, width: innerWidth }), true);
    }
    let section: string | null | undefined;
    new MutationObserver(() => {
      const now = document.getElementById("service-grok")?.closest("section")?.getAttribute("aria-labelledby");
      if (now !== section) note({ type: "grok-section", section: now });
      section = now;
    }).observe(document, { childList: true, subtree: true });
  });
}

/** Everything traceGlides and the product marks recorded, with the page's size and scroll, as one JSON-able object. */
const glideTrace = (page: Page) =>
  page.evaluate(() => {
    const tracked = window as Window & { __glideTrace?: unknown[]; __animations?: Animation[] };
    return {
      viewport: [innerWidth, innerHeight],
      scrollY: Math.round(scrollY),
      grokTop: Math.round(document.getElementById("service-grok")?.getBoundingClientRect().top ?? Number.NaN),
      events: tracked.__glideTrace,
      marks: performance
        .getEntriesByType("mark")
        .filter((mark) => mark.name.startsWith("card-motion"))
        .map((mark) => ({ name: mark.name, t: Math.round(mark.startTime) })),
      glides: (tracked.__animations ?? [])
        .filter((animation) => animation.id === "card-move")
        .map((animation) => {
          const effect = animation.effect as KeyframeEffect;
          return `${effect.target?.id} ${String(effect.getKeyframes()[0].transform)}`;
        }),
    };
  });

/**
 * The card glides recorded after the first `since`, that travel 100 px or more. A glide of a few pixels follows a
 * change above the cards (the hero's text wrapping differently on a slow machine), which is a layout shift the
 * glide is right to smooth. What a stale layout would cause is a glide across the page: a filter, a scroll or a
 * resize replayed as cards moving, in the hundreds of pixels.
 */
const longGlides = (page: Page, since: number) =>
  page.evaluate((since) => {
    const tracked = window as Window & { __animations?: Animation[] };
    return (tracked.__animations ?? [])
      .filter((animation) => animation.id === "card-move")
      .slice(since)
      .map((animation) => {
        const effect = animation.effect as KeyframeEffect;
        return { id: effect.target?.id, from: String(effect.getKeyframes()[0].transform) };
      })
      .filter(({ from }) =>
        (from.match(/-?[\d.]+(?=px)/g) ?? []).some((distance) => Math.abs(Number(distance)) >= 100),
      );
  }, since);

const cardGlides = (page: Page) =>
  page.evaluate(
    () =>
      (window as Window & { __animations?: Animation[] }).__animations?.filter(
        (animation) => animation.id === "card-move",
      ).length ?? 0,
  );

/**
 * Loads the page, then presses Refresh so the served fixture replaces the server's first render.
 * `ready` names a card and the status word that shows the fixture has arrived.
 */
async function openFixture(
  page: Page,
  board: () => BoardSnapshot,
  ready: { id: string; label: string } = { id: "aws", label: "Outage" },
): Promise<void> {
  await serveBoard(page, board);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // The cards are in the server's markup already; Refresh answers only once hydrated.
  await hydrated(page);
  await pressRefresh(page, page.getByRole("button", { name: "Refresh status now" }).first());
  await expect(page.locator(`#service-${ready.id}`).getByText(ready.label, { exact: true }).first()).toBeVisible();
}

/**
 * Waits until the page's own refetch is far off. The board refetches on the wall clock every two minutes, and while
 * it does the live line reads "Checking…" and then "Checked … · next in m:ss" again, a different height. A sweep
 * or a measure that spans that moves the hero under the test's feet, so it starts only when the countdown has
 * room for it; one that lands in the last seconds waits the refetch out, which resets the countdown.
 */
async function awayFromRefetch(page: Page, seconds = 30): Promise<void> {
  await expect
    .poll(
      async () => {
        const text = (await page.getByTestId("live-bar").textContent()) ?? "";
        const match = /next in (\d+):(\d{2})/.exec(text);
        return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
      },
      { timeout: 90_000, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(seconds);
}

/** Console errors, warnings (React reports hydration mismatches as either) and uncaught exceptions. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
  return problems;
}

test("renders every service with no console errors or hydration warnings", async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto("/");
  // After hydration the title leads with how many services need attention: "(2) Status".
  await expect(page).toHaveTitle(/^(\(\d+\) )?Status$/);
  await expect(cards(page)).toHaveCount(SERVICES);
  // Hydration runs after the first paint; give React time to complain.
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});

test("has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // Cards no longer rise in one after another: no stagger animation is ever started.
  expect(
    await page.evaluate(() => document.getAnimations().some((a) => (a as CSSAnimation).animationName === "rise-in")),
  ).toBe(false);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  // Every failing node with axe's own summary (colours and ratio for
  // contrast), so a failure in CI can be read from the log alone.
  const blocking = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .flatMap((violation) =>
      violation.nodes.map(
        (node) => `${violation.id} ${node.target.join(" ")}: ${node.failureSummary ?? violation.help}`,
      ),
    );
  expect(blocking).toEqual([]);
});

test("starts the tab order with a skip link that moves focus to the board", async ({ page, isMobile, browserName }) => {
  test.skip(isMobile, "no Tab key on a touch device");
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // Unhydrated, Enter follows the link's href and puts #services in the address.
  await hydrated(page);
  const skip = page.getByRole("link", { name: "Skip to the board" });
  // First in the tab order by the markup itself: nothing before it can take
  // focus, and the compact header, hidden at the top, is inert.
  const first = await page.evaluate(() => {
    const focusable = [...document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]")].find(
      (element) => element.tabIndex >= 0 && !element.closest("[inert]"),
    );
    return focusable?.textContent?.trim();
  });
  expect(first).toBe("Skip to the board");
  if (browserName === "webkit") {
    // Safari only tabs to links with a setting switched on, and WebKit's
    // Tab handling differs by platform, so focus it directly there.
    await skip.focus();
  } else {
    await page.keyboard.press("Tab");
  }
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#services")).toBeFocused();
  // Script moves focus without leaving #services in the address.
  expect(new URL(page.url()).hash).toBe("");
});

test("opens with the search from the address and announces a new result count", async ({ page }) => {
  await page.goto("/?q=aws");
  await hydrated(page);
  const search = page.getByRole("searchbox", { name: "Search services" }).or(page.getByLabel("Search services"));
  await expect(search).toHaveValue("aws");
  await expect(page.locator("#service-aws")).toBeVisible();
  await expect(cards(page)).not.toHaveCount(SERVICES);

  await search.fill("");
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(page.getByRole("status").filter({ hasText: "Showing" })).toHaveText(
    `Showing ${SERVICES} of ${SERVICES}`,
  );
  expect(new URL(page.url()).search).toBe("");
});

test("fits the viewport without horizontal scrolling", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("carries the Apple device head tags, with the icon and manifest served", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  await expect(page.locator('meta[name="theme-color"][media*="light"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"][media*="dark"]')).toHaveCount(1);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Status");
  for (const rel of ["apple-touch-icon", "manifest"]) {
    const link = page.locator(`link[rel="${rel}"]`);
    await expect(link).toHaveCount(1);
    const href = await link.getAttribute("href");
    const response = await request.get(href!);
    expect(response.status(), `${rel} ${href}`).toBe(200);
  }
  const manifest: { id: string; icons: Array<{ src: string }> } = await (
    await request.get("/manifest.webmanifest")
  ).json();
  expect(manifest.id).toBe("/");
  for (const icon of manifest.icons) {
    expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  }
});

/** The computed backdrop filter, prefixed or not, for every element matching `selector`. */
function backdropFilters(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      const value = style.getPropertyValue("backdrop-filter") || style.getPropertyValue("-webkit-backdrop-filter");
      return value || "none";
    }),
  );
}

// The panel classes are .surface, .control and .float.
const PANELS = ".surface";
const CONTROLS = ".control";
const BARS = ".float";

test("Quiet, the default background, blurs no panel and no control, only the floating bar", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const panels = await backdropFilters(page, PANELS);
  expect(panels.length).toBeGreaterThan(0);
  expect(panels.filter((value) => value !== "none")).toEqual([]);
  const controls = await backdropFilters(page, CONTROLS);
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.filter((value) => value !== "none")).toEqual([]);
  // The bar is the one translucent layer: hidden it holds no blur, up it blurs.
  const bar = page.locator('section[aria-label="Board controls"]');
  expect((await backdropFilters(page, BARS)).filter((value) => value !== "none")).toEqual([]);
  await page.locator("footer").scrollIntoViewIfNeeded();
  await expect(bar).toHaveAttribute("data-shown", "true");
  expect((await backdropFilters(page, BARS)).some((value) => value.includes("blur("))).toBe(true);
});

test("Glass blurs the panels and never the whisper surfaces", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("status-bar:background", "glass"));
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await expect(page.locator("html")).toHaveAttribute("data-background", "glass");
  const glass = await backdropFilters(page, PANELS);
  expect(glass.some((value) => value.includes("blur("))).toBe(true);
  const whisper = await backdropFilters(page, CONTROLS);
  expect(whisper.length).toBeGreaterThan(0);
  expect(whisper.filter((value) => value !== "none")).toEqual([]);
});

/**
 * The bar has gone: it is `inert` and out of the accessibility tree the moment the hero is back
 * (Playwright's role queries do not see `inert`, so it is found by its markup), then its fade-out
 * plays and it leaves the page.
 */
async function barHidden(page: Page, header: Locator): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const bar = page.locator('section[aria-label="Board controls"]');
  await expect(bar).toHaveAttribute("data-shown", "false");
  await expect(bar).toHaveAttribute("inert", "");
  await expect(header).toBeHidden();
}

test("floats a compact header with the controls once the hero scrolls away", async ({ page, browserName }) => {
  // Its Refresh press below gets the served board, not a live sweep of the vendors.
  await serveBoard(page, () => fixtureBoard(Date.now()));
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // The bar shows and hides from a client-side observer.
  await hydrated(page);
  const header = page.getByRole("region", { name: "Board controls" });
  await expect(header).toBeHidden();
  await page.locator("footer").scrollIntoViewIfNeeded();
  await expect(header).toBeVisible();
  await expect(header.getByRole("button", { name: "Refresh status now" })).toBeVisible();
  // Its Refresh and Alerts are second copies: no id may appear twice.
  const duplicates = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicates).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await barHidden(page, header);

  // A click leaves focus on the button in Chromium; that must not hold the
  // bar over the hero's own controls once the page is back at the top.
  // Clicked where it shows, once its fade-in has settled, as a tap would:
  // Playwright's click first scrolls its target into view, and WebKit
  // scrolls a stuck sticky bar to its place in the page, back over the hero.
  await page.locator("footer").scrollIntoViewIfNeeded();
  const refresh = header.getByRole("button", { name: "Refresh status now" });
  await expect(refresh).toBeInViewport();
  // The bar's own transitions only: the live ring inside it never finishes.
  await header.evaluate((bar) => Promise.all(bar.getAnimations().map((animation) => animation.finished)));
  const box = await refresh.boundingBox();
  expect(box).not.toBeNull();
  // The refresh glides the cards that moved (withCardMotion); the bar's fade-out
  // below is not judged until that has played out.
  await pressRefresh(page, refresh, () => page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2));
  // Safari leaves a clicked button unfocused; Chromium focuses it, the case that matters.
  if (browserName === "chromium") await expect(refresh).toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 0));
  await barHidden(page, header);
});

/** The floating bar, found by its markup: Playwright's role queries skip it while it is `inert`. */
const controlBar = (page: Page) => page.locator('section[aria-label="Board controls"]');

/**
 * The search dock. From 64rem it carries --dock (0 to 1), the search field's progress into the bar, which follows
 * the scroll. Below that the field does not follow the scroll: the dock carries data-docked once the page has
 * reached it, and a transition in time moves the field. Every reading of "the dock" below is --dock on a wide
 * screen and 0 or 1 (data-docked) on a phone, so one assertion serves both.
 */
const searchDock = (page: Page) => page.locator(".search-dock");

/** Scrolls to `y` and waits three frames, so the dock's own callback and React's update have run. */
async function scrollAndSettle(page: Page, y: number): Promise<void> {
  await page.evaluate(
    (top) =>
      new Promise<void>((resolve) => {
        window.scrollTo(0, top);
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }),
    y,
  );
}

/** How far the page can scroll. */
const maxScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);

/** The dock's reading as a number: --dock on a wide screen, 0 or 1 (data-docked) on a phone. */
const dockValue = (page: Page) =>
  searchDock(page).evaluate((element) =>
    element.hasAttribute("data-docked") ? 1 : Number.parseFloat(element.style.getPropertyValue("--dock") || "0"),
  );

/**
 * Waits until the search field and its fill have stopped moving: below 64rem a transition of --t-dock follows the
 * moment the field docks or leaves. Reading the animations also lets the browser start any that is due, so call
 * it after the scroll has been seen by the page (scrollAndSettle).
 */
async function dockMoved(page: Page): Promise<void> {
  await searchDock(page).evaluate(async (dock) => {
    await Promise.allSettled(dock.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
}

/** Waits out the bar's own fade and slide, but not the live ring inside it, which never finishes. */
async function barSettled(page: Page): Promise<void> {
  await controlBar(page).evaluate((bar) => Promise.all(bar.getAnimations().map((animation) => animation.finished)));
}

/** Where the search field sits in the page before any scrolling, as a scroll position. */
const dockNatural = (page: Page) =>
  page.locator(".search-dock").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);

/** What one stop of a scroll sweep saw. */
type DockStop = {
  /** Where the sweep asked to scroll. */
  y: number;
  /** Where that lands once clamped to what the page can scroll. */
  target: number;
  scrollY: number;
  /** How long each of the stop's frames took to arrive, in ms. */
  frameMs: number[];
  /** How many of those frames were the fallback timer rather than a real one. */
  fellBack: number;
  /** The dock's reading: --dock on a wide screen, 0 or 1 on a phone (see dockValue). */
  dock: number;
  shown: string | null;
  /** Wide: the move is under way (--dock above 0). */
  docking: boolean;
  /** Phone: the field is docked (data-docked), which its transition then plays out. */
  docked: boolean;
  liveBottom: number;
  /** Where the hero's last line ends: the live line on a phone, the headline's sentence beside it from 48rem. */
  contentBottom: number;
  barTop: number;
  barBottom: number;
  fieldTop: number;
  /** The input's placeholder, which may only change where the field is at rest. */
  placeholder: string;
  chipOpacity: number;
  chipsClickable: boolean;
  chipHitByInput: boolean;
  input: { same: boolean; mark?: string; value?: string; caret?: number | null; count: number };
};

/** What the page-side half of a sweep hands back. */
type DockSweep = { stops: DockStop[]; total: number; truncated: boolean; ms: number };

/**
 * Frames per stop: one for the scroll and its handler, and one more because useSearchDock coalesces its
 * write of --dock into its own requestAnimationFrame. A scroll event fires in the same rendering update as
 * the frame callbacks, ahead of them, so that write lands in the frame right after the scroll and the
 * second frame's callback sees it (and the state React commits from it in between).
 */
const DOCK_FRAMES = 2;
/**
 * How long a frame may take before the sweep stops waiting for it. CI's WebKit, even with the paint stripped
 * (lightenPaint), has a median frame of 350 to 470 ms and a tail past 1 s (up to 1003 ms seen), so anything
 * near a second cuts real frames short and leaves the stop read too early. 3 s clears that tail with room;
 * it only stops a frame that never comes from hanging the sweep.
 */
const DOCK_FRAME_FALLBACK_MS = 3000;
/**
 * How long a sweep may run inside the page before it gives up and reports how far it got. The worst honest
 * sweep is 30 stops of 2 frames at about 0.5 s (30 s) plus a few 3 s fallbacks, so 40 to 50 s; 30 s was too
 * tight. 60 s leaves headroom, and with one stop's overrun (2 frames of up to 3 s) and the page load still
 * fits inside test.slow()'s 135 s, so a sweep reports its own budget before the test timeout can hide it.
 */
const DOCK_SWEEP_BUDGET_MS = 60_000;
/** The share of a sweep's frames that may fall back before its readings can no longer be trusted. */
const DOCK_MAX_FELL_BACK = 0.1;

/** The one-line summary of a sweep, for a failure message and the log. */
function dockSummary(sweep: DockSweep): string {
  const frames = sweep.stops.flatMap((stop) => stop.frameMs).sort((a, b) => a - b);
  const median = frames.length ? frames[Math.floor(frames.length / 2)] : 0;
  const max = frames.length ? frames[frames.length - 1] : 0;
  const fellBack = sweep.stops.reduce((sum, stop) => sum + stop.fellBack, 0);
  return `swept ${sweep.stops.length} of ${sweep.total} stops in ${Math.round(sweep.ms)} ms; median frame ${Math.round(median)} ms, max ${Math.round(max)} ms; ${fellBack} of ${frames.length} frames fell back`;
}

/**
 * Takes the paint cost out of a page, for a test that reads geometry, focus and hit-testing and never a
 * pixel. Software-rendered WebKit at iPad size cannot paint the backdrop blur and the lens filters in
 * anything like a second, so a sweep that waits on frames spends its whole budget on paint. Neither
 * property is layout: the lenses are position: fixed and out of the flow (and the page already runs
 * without them under Reduce glass), and the bar, live bar, chips and field keep their boxes, opacity,
 * pointer-events and stacking (the glass classes isolate on their own, not through the blur).
 */
const lightenPaint = (page: Page) =>
  page.addStyleTag({
    content: `
      .lenses { display: none !important; }
      *, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
    `,
  });

/** The summary of each test's last sweep, printed by afterEach if the test failed. */
const sweepSummaries = new WeakMap<object, string>();

test.afterEach(() => {
  const testInfo = test.info();
  const summary = sweepSummaries.get(testInfo);
  if (summary && testInfo.status !== testInfo.expectedStatus) console.log(`[dock] ${testInfo.title}: ${summary}`);
});

/**
 * Scrolls through `ys` inside the page, DOCK_FRAMES frames apart, and reads the dock at every stop. Stepping
 * in the page rather than from the test keeps a sweep to a moment, even on a slow browser; the page stops
 * early, and says so, if the sweep outruns its budget, since a test timeout inside one evaluate says nothing.
 * Every stop's timing is attached to the test, and a sweep that was cut short or missed a scroll target fails
 * with what it managed.
 */
async function sweepDock(page: Page, ys: number[]): Promise<DockStop[]> {
  await lightenPaint(page);
  const sweep = await page.evaluate(
    async ({ stops, frameCount, fallback, budget }) => {
      const started = performance.now();
      /** The next frame, or a fallback timer if none comes, and how long that took. */
      const frame = () =>
        new Promise<{ ms: number; fellBack: boolean }>((resolve) => {
          const at = performance.now();
          let done = false;
          const finish = (fellBack: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ ms: performance.now() - at, fellBack });
          };
          const timer = setTimeout(() => finish(true), fallback);
          requestAnimationFrame(() => finish(false));
        });
      const dock = document.querySelector<HTMLElement>(".search-dock");
      const field = document.querySelector<HTMLElement>(".search-field");
      const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
      const live = document.querySelector<HTMLElement>('[data-testid="live-bar"]');
      const hero = document.querySelector<HTMLElement>(".board-body")?.previousElementSibling ?? null;
      const heroPad = hero ? Number.parseFloat(getComputedStyle(hero).paddingBottom) : 0;
      const chips = document.querySelector<HTMLElement>(".board-chips");
      const chip = chips?.querySelector<HTMLElement>("button") ?? null;
      const seen: DockStop[] = [];
      let truncated = false;
      for (const y of stops) {
        if (performance.now() - started > budget) {
          truncated = true;
          break;
        }
        window.scrollTo(0, y);
        const frameMs: number[] = [];
        let fellBack = 0;
        for (let i = 0; i < frameCount; i++) {
          const waited = await frame();
          frameMs.push(waited.ms);
          if (waited.fellBack) fellBack++;
        }
        const input = document.querySelector<HTMLInputElement>('input[type="search"]');
        const box = chip?.getBoundingClientRect();
        const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
        const limit = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        seen.push({
          y,
          target: Math.max(0, Math.min(y, limit)),
          scrollY: window.scrollY,
          frameMs,
          fellBack,
          dock: dock?.hasAttribute("data-docked")
            ? 1
            : Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
          shown: bar?.getAttribute("data-shown") ?? null,
          docking: dock?.hasAttribute("data-docking") ?? false,
          docked: dock?.hasAttribute("data-docked") ?? false,
          liveBottom: live?.getBoundingClientRect().bottom ?? 0,
          contentBottom: (hero?.getBoundingClientRect().bottom ?? 0) - heroPad,
          barTop: bar?.getBoundingClientRect().top ?? 0,
          barBottom: bar?.getBoundingClientRect().bottom ?? 0,
          fieldTop: field?.getBoundingClientRect().top ?? 0,
          placeholder: input?.placeholder ?? "",
          chipOpacity: chips ? Number.parseFloat(getComputedStyle(chips).opacity) : 1,
          chipsClickable: chip ? getComputedStyle(chip).pointerEvents !== "none" : true,
          chipHitByInput: Boolean(hit?.closest(".search-field")),
          input: {
            same: document.activeElement === input,
            mark: (document.activeElement as (HTMLInputElement & { dockMark?: string }) | null)?.dockMark,
            value: input?.value,
            caret: input?.selectionStart,
            count: document.querySelectorAll('input[type="search"]').length,
          },
        });
      }
      return { stops: seen, total: stops.length, truncated, ms: performance.now() - started };
    },
    { stops: ys, frameCount: DOCK_FRAMES, fallback: DOCK_FRAME_FALLBACK_MS, budget: DOCK_SWEEP_BUDGET_MS },
  );

  const summary = dockSummary(sweep);
  const info = test.info();
  sweepSummaries.set(info, summary);
  await info.attach("dock-sweep-timing", {
    body: JSON.stringify(
      {
        summary,
        frames: DOCK_FRAMES,
        fallbackMs: DOCK_FRAME_FALLBACK_MS,
        budgetMs: DOCK_SWEEP_BUDGET_MS,
        truncated: sweep.truncated,
        stops: sweep.stops.map(({ y, target, scrollY, frameMs, fellBack, dock }) => ({
          y,
          target,
          scrollY,
          frameMs: frameMs.map((ms) => Math.round(ms)),
          fellBack,
          dock,
        })),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  if (sweep.truncated) throw new Error(`the dock sweep ran out of its ${DOCK_SWEEP_BUDGET_MS} ms budget: ${summary}`);
  // A frame that fell back may have been read before the page caught up with the scroll.
  const fellBack = sweep.stops.reduce((sum, stop) => sum + stop.fellBack, 0);
  const frames = sweep.stops.reduce((sum, stop) => sum + stop.frameMs.length, 0);
  if (fellBack > frames * DOCK_MAX_FELL_BACK) {
    throw new Error(
      `more than ${DOCK_MAX_FELL_BACK * 100}% of the dock sweep's frames fell back, so its readings may be stale: ${summary}`,
    );
  }
  const missed = sweep.stops.find((stop) => Math.abs(stop.scrollY - stop.target) > 1);
  if (missed) {
    throw new Error(
      `scrolled to ${missed.y} (clamped to ${missed.target}) but landed at ${missed.scrollY}: ${summary}`,
    );
  }
  return sweep.stops;
}

/** On a phone: the clear page, in px, between the bar's bottom edge and the field when the bar comes up (PHONE_GAP in dock.ts). */
const PHONE_GAP = 24;

/** The scroll offsets at which the dock changes, worked out from the page the way useSearchDock does. */
type DockOffsets = {
  /** From 64rem the field shares a row with the chips and moves in one go. */
  wide: boolean;
  natural: number;
  /** The bar comes up: on a phone by itself, with the field still on its way, a good way below it. */
  barStart: number;
  /**
   * Wide: --dock leaves 0 here, and returns to 1 at moveEnd. Phone: the field reaches the bar's bottom edge and
   * docks (data-docked), the one moment the page's scrolling matters to it.
   */
  moveStart: number;
  /** The field reaches its pin (wide: --dock is 1 from here). */
  moveEnd: number;
};

async function dockOffsets(page: Page): Promise<DockOffsets> {
  const natural = await dockNatural(page);
  const { wide, reduced, barStick, barHeight, dockStick } = await page.evaluate(() => {
    const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
    return {
      wide: matchMedia("(min-width: 64rem)").matches,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      barStick: Number.parseFloat(getComputedStyle(bar).top),
      barHeight: bar.offsetHeight,
      dockStick: Number.parseFloat(getComputedStyle(document.querySelector(".search-dock") as Element).top),
    };
  });
  // The field reaches its pin, and --dock its 1, at moveEnd.
  const moveEnd = natural - dockStick;
  if (wide) {
    // One move of 48px; the bar comes up about two thirds of the way through, or at the end when the field snaps.
    const moveStart = moveEnd - 48;
    return { wide, natural, barStart: reduced ? moveEnd : moveStart + 0.67 * 48, moveStart, moveEnd };
  }
  // The bar is fixed and comes up on its own while the field is still PHONE_GAP px below its bottom edge (the
  // page's spacing puts the live line just out from under the sliding bar at the same moment: a test of its own
  // checks that). The field then rises 1:1 with the page and docks once it has risen to the bar's bottom edge; the
  // rest of the way to its pin it has only the page's own scrolling to do.
  const barStart = moveEnd - (barHeight + PHONE_GAP - (dockStick - barStick));
  return { wide, natural, barStart, moveStart: moveEnd - (barHeight - (dockStick - barStick)), moveEnd };
}

/**
 * A sweep path, top to end: fine steps of `step` across the whole of the dock's change (the bar coming up
 * and the field's move into it: 8px before the first to 8px after the last), and only a few stops
 * elsewhere, where nothing changes. `path` is the way up and all of it back.
 */
async function dockPath(page: Page, step = 8): Promise<{ up: number[]; path: number[] }> {
  const { natural, barStart, moveStart, moveEnd } = await dockOffsets(page);
  const limit = await maxScroll(page);
  const ramp: number[] = [];
  for (let y = Math.min(barStart, moveStart) - 8; y <= moveEnd + 8; y += step) ramp.push(y);
  const coarse = [0, natural - 160, natural - 110, natural + 120, natural + 200, limit];
  const up = [...new Set([...coarse, ...ramp].map((y) => Math.round(Math.min(Math.max(y, 0), limit))))].sort(
    (a, b) => a - b,
  );
  return { up, path: [...up, ...[...up].reverse()] };
}

test("keeps the floating bar clear of the live bar as it appears", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "false");
  await expect(page.getByTestId("live-bar")).toContainText("Checked");

  // Down a few pixels at a time: at the first stop where the bar shows, the live
  // bar's text must already be above it, not sliding under or beside it.
  const { up } = await dockPath(page);
  const stops = await sweepDock(page, up);
  const first = stops.find((stop) => stop.shown === "true");
  expect(first, "the bar never showed").toBeDefined();
  expect(first?.liveBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(first?.barTop ?? 0);
  // And it stays clear of it for the rest of the way down.
  for (const stop of stops.filter((stop) => stop.shown === "true")) {
    expect(stop.liveBottom, `at ${stop.y}`).toBeLessThanOrEqual(stop.barTop);
  }
});

test("brings the bar up on its own first, then docks the field into it when it reaches the bar", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, natural, barStart, moveStart, moveEnd } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field shares a row with the chips and moves in one go");

  // The bar has scrolling to itself, long enough for its fade (250ms) to be well under way before the field docks.
  expect(moveStart - barStart, "the stretch the bar is alone").toBeGreaterThanOrEqual(PHONE_GAP - 0.5);

  const { up } = await dockPath(page, 2);
  const stops = await sweepDock(page, up);
  const firstShown = stops.findIndex((stop) => stop.shown === "true");
  const firstDocked = stops.findIndex((stop) => stop.docked);
  expect(firstShown, "the bar never showed").toBeGreaterThanOrEqual(0);
  expect(firstDocked, "the field never docked").toBeGreaterThanOrEqual(0);
  // Before the bar, the field is in the flow: it rises 1:1 with the page and is never pinned on its own.
  const pin = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.querySelector(".search-dock") as Element).top),
  );
  const before = stops.filter((stop) => stop.shown === "false" && stop.fieldTop > pin + 1);
  expect(before.length).toBeGreaterThan(3);
  for (const [index, stop] of before.entries()) {
    const previous = before[index - 1];
    if (previous)
      expect(stop.fieldTop - previous.fieldTop, `at ${stop.y}`).toBeCloseTo(previous.scrollY - stop.scrollY, 0);
    expect(stop.fieldTop, `at ${stop.y}`).toBeCloseTo(natural - stop.scrollY, 0);
  }
  // With the bar hidden nothing sits over the chips: a tap on one reaches the chip, not the search input.
  for (const stop of stops.filter((stop) => stop.shown === "false")) {
    expect(stop.chipHitByInput, `at ${stop.y}`).toBe(false);
  }
  // Where the bar comes up, the field is still well below it and not docked.
  const first = stops[firstShown];
  expect(first?.docked).toBe(false);
  expect(first?.fieldTop ?? 0).toBeGreaterThanOrEqual((first?.barBottom ?? 0) + 12);
  // Phase one: the bar is up while the field has not docked.
  const alone = stops.filter((stop) => stop.shown === "true" && !stop.docked);
  expect(alone.length, "the bar never showed by itself").toBeGreaterThan(1);
  for (const stop of alone) {
    // The field waits below the bar, not under it, until it docks.
    expect(stop.fieldTop, `at ${stop.y}`).toBeGreaterThanOrEqual(stop.barBottom - 0.5);
  }
  // The field docks once the bar is up, at the scroll position where it reaches the bar, and stays docked on the way down.
  expect(firstDocked).toBeGreaterThan(firstShown);
  for (const stop of stops) {
    if (stop.docked) expect(stop.shown, `at ${stop.y}`).toBe("true");
    if (stop.scrollY < barStart) expect(stop.shown, `at ${stop.y}`).toBe("false");
    if (stop.scrollY >= barStart + 1) expect(stop.shown, `at ${stop.y}`).toBe("true");
    if (stop.scrollY < moveStart - 0.5) expect(stop.docked, `at ${stop.y}`).toBe(false);
    if (stop.scrollY >= moveStart + 1) expect(stop.docked, `at ${stop.y}`).toBe(true);
  }
  expect(stops[firstDocked]?.fieldTop, "docks at the bar's bottom edge").toBeGreaterThanOrEqual(
    (stops[firstDocked]?.barBottom ?? 0) - 0.5,
  );
  // It is one step: --dock is not written at all below 64rem, and the field has no part-way pose to hold.
  expect(new Set(stops.map((stop) => stop.dock))).toEqual(new Set([0, 1]));
  // Docked, it ends up inside the bar.
  await scrollAndSettle(page, Math.ceil(moveEnd) + 20);
  await dockMoved(page);
  const docked = await page.evaluate(() => {
    const field = (document.querySelector(".search-field") as Element).getBoundingClientRect();
    const bar = (document.querySelector('section[aria-label="Board controls"]') as Element).getBoundingClientRect();
    return { fieldTop: field.top, barTop: bar.top, barBottom: bar.bottom };
  });
  expect(docked.fieldTop).toBeGreaterThanOrEqual(docked.barTop - 0.5);
  expect(docked.fieldTop).toBeLessThanOrEqual(docked.barBottom + 0.5);
});

test("leaves the bar room to come up on its own under the hero's last line, at every width below 64rem", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  test.slow();
  // Served boards, not the vendors: the hero's words are the board's, and a live board changes them while the
  // sweep runs (the first answer to the page names other services than the page was served with), which moves
  // the last line between two readings. Two heroes, the usual one and the longest the page can have.
  for (const [boardName, board] of [
    ["usual hero", fixtureBoard],
    ["longest hero", longHeroBoard],
  ] as const)
    for (const { width, rootPx } of [
      { width: 375, rootPx: 16 },
      { width: 390, rootPx: 16 },
      { width: 412, rootPx: 16 },
      { width: 430, rootPx: 16 },
      { width: 768, rootPx: 16 },
      { width: 900, rootPx: 16 },
      { width: 430, rootPx: 32 },
    ]) {
      const at = `${boardName}, ${width}px, ${rootPx}px text`;
      await page.setViewportSize({ width, height: 900 });
      await openFixture(page, () => board(Date.now()));
      await expect(page.getByTestId("live-bar")).toContainText("Checked");
      if (rootPx !== 16) {
        await page.evaluate((px) => {
          document.documentElement.style.fontSize = `${px}px`;
        }, rootPx);
        // The dock measures again when the hero and the bar change size.
        await page.waitForTimeout(400);
      }
      // The page's own refetch changes the live line's height for a moment: sweep clear of it.
      await awayFromRefetch(page);
      // The field is sticky: measure it at the top of the page, not where the last width left the scroll.
      await page.evaluate(() => window.scrollTo(0, 0));
      const { natural, barStart, moveStart, moveEnd } = await dockOffsets(page);
      // The spacing under the hero's last line (the live line on a phone) is the bar's height, the 8px it slides
      // in from and PHONE_GAP: the smallest gap at which the bar can come up clear of that line with the field
      // still PHONE_GAP below it, and about 80px at a 16px root.
      const { gap, barHeight } = await page.evaluate(() => {
        const hero = document.querySelector(".board-body")?.previousElementSibling as HTMLElement;
        const field = document.querySelector(".search-field") as HTMLElement;
        const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
        const last = hero.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(hero).paddingBottom);
        return { gap: field.getBoundingClientRect().top - last, barHeight: bar.offsetHeight };
      });
      expect(gap, at).toBeGreaterThanOrEqual(barHeight + 8 + PHONE_GAP - 1);
      expect(gap, at).toBeLessThanOrEqual(barHeight + 8 + PHONE_GAP + 2);
      if (rootPx === 16) expect(gap, at).toBeLessThanOrEqual(88);
      // The bar is alone for at least 24px of scrolling, and the field has at least 46px left to rise to its pin.
      expect(moveStart - barStart, at).toBeGreaterThanOrEqual(24 - 0.5);
      expect(moveEnd - moveStart, at).toBeGreaterThanOrEqual(46 - 0.5);

      const { up } = await dockPath(page, 2);
      const stops = await sweepDock(page, up);
      const shown = stops.filter((stop) => stop.shown === "true");
      const first = shown[0];
      expect(first, `${at}: the bar never showed`).toBeDefined();
      // (a) It comes up with only itself on screen: the field entirely below its bottom edge, with a visible gap,
      // the hero's last line already out from under it, and the field not docked.
      expect(first?.docked, at).toBe(false);
      expect(first?.fieldTop ?? 0, at).toBeGreaterThanOrEqual((first?.barBottom ?? 0) + 16);
      for (const stop of shown) expect(stop.contentBottom, `${at}, ${stop.y}`).toBeLessThanOrEqual(stop.barTop + 0.5);
      for (const stop of shown.filter((stop) => !stop.docked)) {
        expect(stop.fieldTop, `${at}, ${stop.y}`).toBeGreaterThanOrEqual(stop.barBottom - 0.5);
      }
      // Measured off the sweep, not worked out: the bar is up and the field not docked for a real stretch.
      const firstDocked = stops.find((stop) => stop.docked);
      expect(
        firstDocked && first ? firstDocked.scrollY - first.scrollY : 0,
        `${at}: the bar alone`,
      ).toBeGreaterThanOrEqual(22);
      // (b) The field rises 1:1 with the page the whole way, docked or not, until it reaches its pin: it is the
      // page's own (sticky) position, not something the dock moves.
      for (const stop of stops.filter((stop) => stop.scrollY <= moveEnd)) {
        expect(stop.fieldTop, `${at}, ${stop.y}`).toBeCloseTo(natural - stop.scrollY, 0);
      }
      // (c) The field docks within a few px of moveStart, where it meets the bar, and from there on stays docked.
      expect(firstDocked?.scrollY ?? 0, at).toBeGreaterThanOrEqual(moveStart - 0.5);
      expect(firstDocked?.scrollY ?? Number.POSITIVE_INFINITY, at).toBeLessThanOrEqual(moveStart + 6);
      for (const stop of stops.filter((stop) => stop.scrollY >= moveStart + 6)) {
        expect(stop.docked, `${at}, ${stop.y}`).toBe(true);
      }
    }
});

test("starts to take the bar down in the frame that shows a taller hero, not a frame later", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the width is set here, so one project measures it");
  test.slow();
  await page.setViewportSize({ width: 390, height: 900 });
  await openFixture(page, () => fixtureBoard(Date.now()));
  // The hero grows by a line or two in one task, as it does when the board's answer names more services; and by
  // a few pixels, which the bar's 8px hold on its place must not keep it up for: the new last line is under it.
  for (const grow of [60, 6]) {
    await awayFromRefetch(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const { barStart } = await dockOffsets(page);
    await scrollAndSettle(page, Math.ceil(barStart) + 4);
    await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
    await barSettled(page);
    // The test's own frame callback runs ahead of the layout observers in the frame that draws the change, and
    // the one after it ahead of anything the page asked for in between: so the second callback reads the bar as
    // the page left it for the frame after the one that shows the taller hero. The bar must have started down.
    const shown = await page.evaluate(
      (height) =>
        new Promise<string | null>((resolve) => {
          const hero = document.querySelector(".board-body")?.previousElementSibling as HTMLElement;
          const grown = document.createElement("div");
          grown.dataset.grown = "";
          grown.style.height = `${height}px`;
          hero.appendChild(grown);
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(
                document.querySelector('section[aria-label="Board controls"]')?.getAttribute("data-shown") ?? null,
              ),
            ),
          );
        }),
      grow,
    );
    expect(shown, `a hero ${grow}px taller`).toBe("false");
    await page.evaluate(() => document.querySelector("[data-grown]")?.remove());
  }
});

test("takes the bar down when the hero grows under it, at every width below 64rem", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  test.slow();
  let board = fixtureBoard(Date.now());
  const grew: number[] = [];
  for (const { width, rootPx } of [
    { width: 375, rootPx: 16 },
    { width: 430, rootPx: 16 },
    { width: 768, rootPx: 16 },
    { width: 900, rootPx: 16 },
    { width: 430, rootPx: 32 },
  ]) {
    const at = `at ${width}px, ${rootPx}px text`;
    board = fixtureBoard(Date.now());
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page, () => board);
    if (rootPx !== 16) {
      await page.evaluate((px) => {
        document.documentElement.style.fontSize = `${px}px`;
      }, rootPx);
      await page.waitForTimeout(400);
    }
    await awayFromRefetch(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    // With the bar up and the page just past the point where it comes up, the answer to a Refresh names more
    // services: the hero's last line moves down, under the bar's place.
    const { barStart } = await dockOffsets(page);
    await scrollAndSettle(page, Math.ceil(barStart) + 4);
    await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
    await barSettled(page);
    const heroBottom = () =>
      page.evaluate(() => {
        const hero = document.querySelector(".board-body")?.previousElementSibling as HTMLElement;
        return hero.getBoundingClientRect().bottom + window.scrollY;
      });
    const before = await heroBottom();
    board = longHeroBoard(Date.now());
    await pressRefresh(page, controlBar(page).getByRole("button", { name: "Refresh status now" }));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Eleven things need a look.");
    await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
    grew.push((await heroBottom()) - before);
    // Either the bar went down with the line under it, or the line is out from under the bar: never both there.
    const { shown, contentBottom, barTop } = await page.evaluate(() => {
      const hero = document.querySelector(".board-body")?.previousElementSibling as HTMLElement;
      const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
      return {
        shown: bar.getAttribute("data-shown"),
        contentBottom: hero.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(hero).paddingBottom),
        barTop: bar.getBoundingClientRect().top,
      };
    });
    if (shown === "true") expect(contentBottom, at).toBeLessThanOrEqual(barTop + 0.5);
  }
  expect(Math.max(...grew), "the longer hero never made the page taller").toBeGreaterThan(8);
});

test("keeps the bar's buttons clear of the field under Reduce Motion on a phone", async ({ page }) => {
  test.slow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveEnd } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field shares a row with the chips");
  // Under Reduce Motion the field docks, in one step, at moveEnd, so until then it is full width and rises
  // through the bar's own place: it must be under the bar, not over its buttons.
  const stops = await page.evaluate(
    async ({ from, to }) => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
      const field = document.querySelector(".search-field") as HTMLElement;
      const refresh = [...bar.querySelectorAll("button")].find((button) =>
        /^Refresh/.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
      );
      if (!refresh) throw new Error("no Refresh button in the bar");
      const seen: { y: number; shown: string | null; hits: boolean; overlaps: boolean; docked: boolean }[] = [];
      for (let y = from; y <= to; y += 2) {
        window.scrollTo(0, y);
        await frame();
        await frame();
        const box = refresh.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        const fieldBox = field.getBoundingClientRect();
        seen.push({
          y,
          shown: bar.getAttribute("data-shown"),
          hits: Boolean(hit && refresh.contains(hit)),
          overlaps: fieldBox.top < bar.getBoundingClientRect().bottom && fieldBox.right > box.left,
          docked: document.querySelector(".search-dock")?.hasAttribute("data-docked") ?? false,
        });
      }
      return seen;
    },
    { from: Math.round(moveEnd - 120), to: Math.round(moveEnd + 30) },
  );
  const shown = stops.filter((stop) => stop.shown === "true");
  expect(shown.length).toBeGreaterThan(20);
  // Not vacuous: the full-width field does rise through the bar's place before it snaps in.
  expect(stops.filter((stop) => stop.overlaps && !stop.docked).length).toBeGreaterThan(5);
  for (const stop of shown) expect(stop.hits, `Refresh at ${stop.y}`).toBe(true);
});

test("keeps the bar up while the page hovers just above where it appears", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, barStart } = await dockOffsets(page);
  test.skip(wide, "the bar is part of the field's one move from 64rem");
  const bar = controlBar(page);

  await scrollAndSettle(page, Math.ceil(barStart) + 20);
  await expect(bar).toHaveAttribute("data-shown", "true");
  // Up to 8px above the offset it came up at, it stays up; further, it goes; and it does not return before the offset.
  await scrollAndSettle(page, Math.ceil(barStart) - 4);
  await expect(bar).toHaveAttribute("data-shown", "true");
  await scrollAndSettle(page, Math.floor(barStart) - 12);
  await expect(bar).toHaveAttribute("data-shown", "false");
  await scrollAndSettle(page, Math.ceil(barStart) - 4);
  await expect(bar).toHaveAttribute("data-shown", "false");
  await scrollAndSettle(page, Math.ceil(barStart) + 1);
  await expect(bar).toHaveAttribute("data-shown", "true");
});

/**
 * What the dock shows at each of `positions`, with window.scrollY reporting that position whether or not the page
 * can rest there: a stand-in for iOS's rubber band, which reports a negative scrollY above the top and more than
 * the page's end below it, and which no desktop browser produces. Each position is a scroll event and two frames
 * (the dock's own write is coalesced into a frame of its own). The real property is put back afterwards.
 */
async function overscroll(
  page: Page,
  positions: number[],
): Promise<{ y: number; dock: number; shown: string | null; fieldTop: number }[]> {
  return page.evaluate(async (ys) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const original = Object.getOwnPropertyDescriptor(window, "scrollY");
    const dock = document.querySelector<HTMLElement>(".search-dock");
    const field = document.querySelector<HTMLElement>(".search-field");
    const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
    const seen: { y: number; dock: number; shown: string | null; fieldTop: number }[] = [];
    try {
      for (const y of ys) {
        Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
        window.dispatchEvent(new Event("scroll"));
        await frame();
        await frame();
        seen.push({
          y,
          dock: dock?.hasAttribute("data-docked")
            ? 1
            : Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
          shown: bar?.getAttribute("data-shown") ?? null,
          fieldTop: field?.getBoundingClientRect().top ?? 0,
        });
      }
    } finally {
      if (original) Object.defineProperty(window, "scrollY", original);
      else Reflect.deleteProperty(window, "scrollY");
    }
    return seen;
  }, positions);
}

// The two rubber-band tests below are regression guards, not proofs of a fix: the dock only compares the scroll
// position with thresholds, and a position past either end of the page reads as that end, so they pass without any
// special handling of the overshoot. They fail if a change makes the dock follow the overshoot (a progress that
// extrapolates, a threshold that flips on a negative position).
test("regression guard: keeps the dock still through a rubber band above the top of the page", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "false");
  const [at] = await overscroll(page, [0]);
  const seen = await overscroll(page, [-4, -90, -1, -320, 0, -40, -2000, 0]);
  // The field does not move on its own account, and the bar never comes up for a position above the page.
  for (const stop of seen) {
    expect(stop.dock, `at ${stop.y}`).toBe(0);
    expect(stop.shown, `at ${stop.y}`).toBe("false");
    expect(stop.fieldTop, `at ${stop.y}`).toBeCloseTo(at.fieldTop, 0);
  }
});

test("regression guard: keeps the dock docked through a rubber band below the end of the page", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const limit = await maxScroll(page);
  await scrollAndSettle(page, limit);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  expect(await dockValue(page)).toBe(1);
  const [at] = await overscroll(page, [limit]);
  const seen = await overscroll(page, [limit + 6, limit + 120, limit + 2, limit + 600, limit, limit + 60]);
  for (const stop of seen) {
    expect(stop.dock, `at ${stop.y}`).toBe(1);
    expect(stop.shown, `at ${stop.y}`).toBe("true");
    expect(stop.fieldTop, `at ${stop.y}`).toBeCloseTo(at.fieldTop, 0);
  }
});

test("does not move the dock when only the viewport's height changes, as iOS's toolbar does", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveStart, moveEnd } = await dockOffsets(page);
  const frames = (count: number) =>
    page.evaluate(
      (n) =>
        new Promise<void>((resolve) => {
          const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
          next(n);
        }),
      count,
    );
  const look = () =>
    page.evaluate(() => {
      const dock = document.querySelector<HTMLElement>(".search-dock");
      const field = document.querySelector<HTMLElement>(".search-field");
      const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
      const box = field?.getBoundingClientRect();
      return {
        scrollY: window.scrollY,
        dock: dock?.hasAttribute("data-docked") ? 1 : Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
        shown: bar?.getAttribute("data-shown") ?? null,
        box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
      };
    });
  // Count how often the dock measures the page: it reads the body's rect each time it does.
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".board-body") as HTMLElement & { measured?: number };
    host.measured = 0;
    const read = host.getBoundingClientRect.bind(host);
    host.getBoundingClientRect = () => {
      host.measured = (host.measured ?? 0) + 1;
      return read();
    };
  });
  const measured = () => page.evaluate(() => (document.querySelector(".board-body") as { measured?: number }).measured);
  const size = page.viewportSize();
  if (!size) throw new Error("no viewport");

  // Part way through the move (wide) or just after the field docked (phone), where the dock is most sensitive to
  // being measured again. A phone's field is read once its transition has played out.
  const mid = Math.round((moveStart + moveEnd) / 2);
  await scrollAndSettle(page, mid);
  await dockMoved(page);
  const before = await look();
  expect(before.dock).toBeGreaterThan(0);
  if (wide) expect(before.dock).toBeLessThan(1);
  const measuredBefore = await measured();

  // The toolbar collapses (the page gets taller by about 80px), comes back, and does it again.
  for (const height of [size.height + 80, size.height, size.height + 80, size.height]) {
    await page.setViewportSize({ width: size.width, height });
    await frames(3);
    const after = await look();
    expect(after.scrollY, `height ${height}`).toBeCloseTo(before.scrollY, 0);
    expect(after.dock, `height ${height}`).toBe(before.dock);
    expect(after.shown, `height ${height}`).toBe(before.shown);
    expect(after.box?.y, `height ${height}`).toBeCloseTo(before.box?.y ?? 0, 0);
    expect(after.box?.x, `height ${height}`).toBeCloseTo(before.box?.x ?? 0, 0);
    expect(after.box?.width, `height ${height}`).toBeCloseTo(before.box?.width ?? 0, 0);
    expect(after.box?.height, `height ${height}`).toBeCloseTo(before.box?.height ?? 0, 0);
  }
  expect(await measured(), "a change of height alone measures the page again").toBe(measuredBefore);

  // A change of width does (a rotation), so the guard is not just deaf to resizes.
  await page.setViewportSize({ width: size.width - 20, height: size.height });
  await frames(3);
  expect(await measured(), "a change of width does not measure the page again").toBeGreaterThan(measuredBefore ?? 0);
});

test("keeps the dock steady through a fast scroll, down and back up", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await lightenPaint(page);
  const { natural, barStart, moveStart, moveEnd } = await dockOffsets(page);
  const limit = await maxScroll(page);
  const from = Math.max(0, Math.round(Math.min(barStart, moveStart) - 80));
  const to = Math.min(limit, Math.round(moveEnd + 80));
  // A long stride a stop: a flick, not the sweeps' careful steps. Two frames a stop: the dock writes what a scroll
  // means in a requestAnimationFrame of its own, queued after this one's, so it is read in the frame after.
  const run = (ys: number[]) =>
    page.evaluate(async (stops) => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const dock = document.querySelector<HTMLElement>(".search-dock");
      const field = document.querySelector<HTMLElement>(".search-field");
      const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
      const seen: { scrollY: number; fieldTop: number; dock: number; shown: string | null }[] = [];
      for (const y of stops) {
        window.scrollTo(0, y);
        await frame();
        await frame();
        seen.push({
          scrollY: window.scrollY,
          fieldTop: field?.getBoundingClientRect().top ?? 0,
          dock: dock?.hasAttribute("data-docked")
            ? 1
            : Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
          shown: bar?.getAttribute("data-shown") ?? null,
        });
      }
      return seen;
    }, ys);
  const down: number[] = [];
  for (let y = from; y <= to; y += 22) down.push(y);
  const downward = await run(down);
  const upward = await run([...down].reverse());
  // Let the last frame's write land before the next scroll.
  await scrollAndSettle(page, 0);

  const flips = (stops: { shown: string | null }[]) => stops.filter((s, i) => i > 0 && s.shown !== stops[i - 1].shown);
  // Down: the page goes only one way, so the field only rises (it stops at its pin), the dock only grows (docks
  // once, on a phone) and the bar comes up once. Up is the same run backwards. Not one stop goes back and forth.
  for (const [index, stop] of downward.entries()) {
    expect(stop.scrollY, `down, stop ${index}`).toBeGreaterThanOrEqual(downward[Math.max(0, index - 1)].scrollY);
    if (index === 0) continue;
    const previous = downward[index - 1];
    expect(stop.fieldTop, `down, at ${stop.scrollY}`).toBeLessThanOrEqual(previous.fieldTop + 0.5);
    expect(stop.dock, `down, at ${stop.scrollY}`).toBeGreaterThanOrEqual(previous.dock);
  }
  for (const [index, stop] of upward.entries()) {
    if (index === 0) continue;
    const previous = upward[index - 1];
    expect(stop.scrollY, `up, stop ${index}`).toBeLessThanOrEqual(previous.scrollY);
    expect(stop.fieldTop, `up, at ${stop.scrollY}`).toBeGreaterThanOrEqual(previous.fieldTop - 0.5);
    expect(stop.dock, `up, at ${stop.scrollY}`).toBeLessThanOrEqual(previous.dock);
  }
  expect(flips(downward).length, "the bar came up more than once on the way down").toBeLessThanOrEqual(1);
  expect(flips(upward).length, "the bar went more than once on the way up").toBeLessThanOrEqual(1);
  // Above its pin the field is the page's own: it is where the page puts it, at every stop, not a frame behind.
  const pin = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.querySelector(".search-dock") as Element).top),
  );
  for (const stop of [...downward, ...upward].filter((stop) => natural - stop.scrollY > pin + 1)) {
    expect(stop.fieldTop, `at ${stop.scrollY}`).toBeCloseTo(natural - stop.scrollY, 0);
  }
  expect(downward.at(-1)?.dock).toBe(1);
  expect(upward.at(-1)?.dock).toBe(0);
});

/**
 * Scrolls to `y` and, the moment the page has docked or released the field (data-docked changes), stops the
 * transitions that start with it, before a frame is drawn, so a test can look at the field at the start of its
 * move whatever the speed of the browser. `release` lets them finish. Phone only.
 */
async function dockHeld(page: Page, y: number): Promise<{ clearOpacity: number | null }> {
  // Moves are armed two frames after the load; a scroll before that is a snap, not a move.
  await expect(page.locator(".search-dock")).toHaveAttribute("data-armed", "");
  return page.evaluate(
    (top) =>
      new Promise<{ clearOpacity: number | null }>((resolve, reject) => {
        const dock = document.querySelector(".search-dock") as HTMLElement;
        const verdict = document.querySelector("[data-bar-verdict]") as HTMLElement;
        const was = dock.hasAttribute("data-docked");
        const timer = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error(`the dock did not react to ${top}`));
        }, 10_000);
        const observer = new MutationObserver(() => {
          if (dock.hasAttribute("data-docked") === was) return;
          observer.disconnect();
          window.clearTimeout(timer);
          // Reading the animations lets the browser start the ones this change calls for, in this very frame.
          for (const animation of [...dock.getAnimations({ subtree: true }), ...verdict.getAnimations()]) {
            animation.pause();
          }
          // Read in this task: the dock's own timer ends the wait for the move whether or not it is held.
          const clear = dock.querySelector('button[aria-label="Clear search"]');
          resolve({ clearOpacity: clear ? Number.parseFloat(getComputedStyle(clear).opacity) : null });
        });
        observer.observe(dock, { attributes: true, attributeFilter: ["data-docked"] });
        window.scrollTo(0, top);
      }),
    y,
  );
}

/** Lets the transitions `dockHeld` stopped run to their end. */
const dockRelease = (page: Page) =>
  page.evaluate(async () => {
    const dock = document.querySelector(".search-dock") as HTMLElement;
    const verdict = document.querySelector("[data-bar-verdict]") as HTMLElement;
    const running = [...dock.getAnimations({ subtree: true }), ...verdict.getAnimations()];
    for (const animation of running) animation.finish();
    await Promise.allSettled(running.map((animation) => animation.finished));
  });

/** Where things are, for a test of where the field is. */
const dockBoxes = (page: Page) =>
  page.evaluate(() => {
    const rect = (element: Element | null) => {
      const { left, top, width, height, right, bottom } = (element as Element).getBoundingClientRect();
      return { left, top, width, height, right, bottom };
    };
    const dock = document.querySelector(".search-dock") as HTMLElement;
    const chrome = dock.querySelector(".search-chrome");
    return {
      dock: rect(dock),
      field: rect(dock.querySelector(".search-field")),
      chrome: rect(chrome),
      input: rect(dock.querySelector("input")),
      slot: rect(document.querySelector('section[aria-label="Board controls"] div[class*="max-w-[26rem]"]')),
      bar: rect(document.querySelector('section[aria-label="Board controls"]')),
      chromeTransform: getComputedStyle(chrome as Element).transform,
      zIndex: getComputedStyle(dock).zIndex,
    };
  });

test("draws the search field's fill behind a see-through input, the size of the field, at every width", async ({
  page,
}) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { chrome, field, input, style } = await page.evaluate(() => {
    const rect = (element: Element | null) => {
      const { left, top, width, height } = (element as Element).getBoundingClientRect();
      return { left, top, width, height };
    };
    const fieldElement = document.querySelector(".search-field") as Element;
    const chromeElement = fieldElement.querySelector(".search-chrome") as Element;
    const inputElement = fieldElement.querySelector("input") as Element;
    return {
      chrome: rect(chromeElement),
      field: rect(fieldElement),
      input: rect(inputElement),
      style: {
        chromeFill: getComputedStyle(chromeElement).backgroundColor,
        inputFill: getComputedStyle(inputElement).backgroundColor,
        hidden: chromeElement.getAttribute("aria-hidden"),
        transform: getComputedStyle(chromeElement).transform,
      },
    };
  });
  // The fill is the field, edge to edge, and at rest unscaled, so its corners are the .control radius.
  for (const key of ["left", "top", "width", "height"] as const) {
    expect(chrome[key], `fill ${key}`).toBeCloseTo(field[key], 0);
    expect(input[key], `input ${key}`).toBeCloseTo(field[key], 0);
  }
  expect(style.transform).toBe("none");
  expect(style.hidden).toBe("true");
  expect(style.inputFill, "the input shows the fill, not a fill of its own").toBe("rgba(0, 0, 0, 0)");
  expect(style.chromeFill, "the fill is drawn").not.toBe("rgba(0, 0, 0, 0)");
});

test("docks the field in one step where it meets the bar, and holds it a few px short of that", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveStart } = await dockOffsets(page);
  test.skip(wide, "from 64rem the move follows the scroll, with no threshold");
  const dockAt = Math.ceil(moveStart);
  const at = async (y: number) => {
    await scrollAndSettle(page, y);
    return dockValue(page);
  };
  // Short of the point where the field meets the bar's bottom edge it is not docked, however near.
  expect(await at(dockAt - 3)).toBe(0);
  expect(await at(dockAt + 1)).toBe(1);
  // Docked, it stays docked through the hold below that point, so a finger resting there cannot restart the move...
  expect(await at(dockAt - (DOCK_HYSTERESIS - 3))).toBe(1);
  expect(await at(dockAt + 1)).toBe(1);
  // ...and is released beyond it.
  expect(await at(dockAt - DOCK_HYSTERESIS - 3)).toBe(0);
  // Released, it does not dock again until the point itself.
  expect(await at(dockAt - 3)).toBe(0);
  expect(await at(dockAt + 1)).toBe(1);
});

test("moves the docking field with transform and opacity only, over the dock's own time", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveStart } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field follows the scroll instead of playing a transition");

  // What the stylesheet says: of everything in the dock, only transform is timed, over the same time as the
  // stylesheet's token, which dock.ts names too; and on a narrow phone the bar's verdict fades by opacity alone.
  const css = await page.evaluate(() => {
    const dock = document.querySelector(".search-dock") as HTMLElement;
    const timed = (element: Element) => {
      const style = getComputedStyle(element);
      const properties = style.transitionProperty.split(",").map((value) => value.trim());
      const durations = style.transitionDuration.split(",").map((value) => value.trim());
      return properties.filter((_, index) => Number.parseFloat(durations[index % durations.length]) > 0);
    };
    const verdict = document.querySelector("[data-bar-verdict]") as Element;
    return {
      token: getComputedStyle(document.documentElement).getPropertyValue("--t-dock").trim(),
      field: timed(dock.querySelector(".search-field") as Element),
      chrome: timed(dock.querySelector(".search-chrome") as Element),
      fieldDuration: getComputedStyle(dock.querySelector(".search-field") as Element).transitionDuration,
      everything: [dock, ...dock.querySelectorAll("*")].flatMap(timed),
      verdict: timed(verdict),
      verdictDuration: getComputedStyle(verdict).transitionDuration,
      narrow: matchMedia("(width < 40rem)").matches,
    };
  });
  // The stylesheet may spell it 180ms or .18s.
  expect(transitionMs(css.token)).toBeCloseTo(DOCK_MS, 5);
  expect(css.field).toEqual(["transform"]);
  expect(css.chrome).toEqual(["transform"]);
  expect(Number.parseFloat(css.fieldDuration) * 1000).toBeCloseTo(DOCK_MS, 5);
  for (const property of css.everything) expect(["transform", "opacity"], "in the dock").toContain(property);
  if (css.narrow) {
    expect(css.verdict).toEqual(["opacity"]);
    expect(Number.parseFloat(css.verdictDuration) * 1000).toBeCloseTo(DOCK_MS, 5);
  }

  // What the browser then runs when the field docks: transitions of those properties and no other.
  await dockHeld(page, Math.ceil(moveStart) + 2);
  const running = await page.evaluate(() => {
    const dock = document.querySelector(".search-dock") as HTMLElement;
    const verdict = document.querySelector("[data-bar-verdict]") as HTMLElement;
    return [...dock.getAnimations({ subtree: true }), ...verdict.getAnimations()].map((animation) => ({
      kind: typeof CSSTransition !== "undefined" && animation instanceof CSSTransition ? "transition" : "other",
      property: (animation as CSSTransition).transitionProperty,
      ms: Number(animation.effect?.getComputedTiming().duration),
    }));
  });
  expect(running.length, "the field moves").toBeGreaterThan(0);
  for (const animation of running) {
    expect(animation.kind).toBe("transition");
    expect(["transform", "opacity"]).toContain(animation.property);
    expect(animation.ms).toBeCloseTo(DOCK_MS, 0);
  }
  expect(running.some((animation) => animation.property === "transform")).toBe(true);
  await dockRelease(page);
});

test("starts the field's fill where it was and ends it in the slot, never at the wrong width in between", async ({
  page,
}) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveStart } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field follows the scroll, with no fill to play");
  const rest = await dockBoxes(page);
  expect(rest.chromeTransform, "undocked, the fill is unscaled").toBe("none");

  // Docking, held at the first frame of its move: the input has its docked width already (one step, under the
  // transition), while the fill still covers what the field covered, edge to edge.
  await dockHeld(page, Math.ceil(moveStart) + 2);
  const start = await dockBoxes(page);
  expect(
    Math.abs(start.input.width - start.slot.width),
    "the input is at its docked width at once",
  ).toBeLessThanOrEqual(1);
  expect(start.chrome.width, "the fill still has the old width").toBeGreaterThan(start.slot.width + 20);
  expect(start.chrome.width).toBeCloseTo(rest.chrome.width, 0);
  expect(start.chrome.left).toBeCloseTo(rest.chrome.left, 0);
  await dockRelease(page);
  const end = await dockBoxes(page);
  // The slot's offsets are whole pixels (the dock measures them from layout), so it is within one.
  for (const key of ["left", "width", "height"] as const) {
    expect(Math.abs(end.chrome[key] - end.slot[key]), `docked fill ${key}`).toBeLessThanOrEqual(1);
    expect(Math.abs(end.field[key] - end.slot[key]), `docked field ${key}`).toBeLessThanOrEqual(1);
  }
  expect(end.chromeTransform, "docked, the fill is unscaled too, so its corners are not squashed").toBe("none");

  // Leaving, the same the other way: the fill starts as narrow as it was, and ends as wide as the field.
  await dockHeld(page, Math.floor(moveStart) - DOCK_HYSTERESIS - 4);
  const leaving = await dockBoxes(page);
  expect(leaving.chrome.width, "the fill starts at the docked width").toBeCloseTo(end.chrome.width, 0);
  expect(leaving.chrome.left).toBeCloseTo(end.chrome.left, 0);
  expect(leaving.input.width, "the input is at its full width at once").toBeGreaterThan(end.slot.width + 20);
  await dockRelease(page);
  const back = await dockBoxes(page);
  expect(back.chrome.width).toBeCloseTo(back.dock.width, 0);
  expect(back.chrome.left).toBeCloseTo(back.dock.left, 0);
  expect(back.chromeTransform).toBe("none");
});

test("never puts the field under the bar, so a flick's late frame cannot hide it", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveStart } = await dockOffsets(page);
  test.skip(wide, "from 64rem the bar is not fixed, and the field is always over it");
  const zIndex = () => searchDock(page).evaluate((dock) => Number(getComputedStyle(dock).zIndex));
  const barZ = await controlBar(page).evaluate((bar) => Number(getComputedStyle(bar).zIndex));
  // An undocked field is always below the bar's bottom edge (the sweeps above check that), so it can be over the
  // bar all the time: a field that a flick carried into the bar before the page could dock it is then drawn over
  // it, full width, while it shrinks, not hidden under it for a frame and popped on top.
  expect(await zIndex(), "at the top").toBeGreaterThan(barZ);
  await scrollAndSettle(page, Math.floor(moveStart) - 4);
  expect(await zIndex(), "with the bar up alone").toBeGreaterThan(barZ);
  await dockHeld(page, Math.ceil(moveStart) + 2);
  expect(await zIndex(), "as it docks").toBeGreaterThan(barZ);
  await dockRelease(page);
  await scrollAndSettle(page, await maxScroll(page));
  expect(await zIndex(), "docked, after a flick").toBeGreaterThan(barZ);
  await dockHeld(page, Math.floor(moveStart) - DOCK_HYSTERESIS - 4);
  expect(await zIndex(), "as it leaves").toBeGreaterThan(barZ);
  await dockRelease(page);
});

test("opens a page that is already scrolled past the dock with the field docked, and plays no move", async ({
  page,
}) => {
  test.slow();
  // Every transition that starts, from before the page's own script runs.
  await page.addInitScript(() => {
    const runs: string[] = [];
    (window as Window & { __runs?: string[] }).__runs = runs;
    document.addEventListener(
      "transitionrun",
      (event) => {
        const element = event.target as Element;
        if (element.closest(".search-dock")) runs.push(`${element.className} ${event.propertyName}`);
      },
      true,
    );
  });
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveEnd } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field follows the scroll instead of playing a move");
  await scrollAndSettle(page, Math.ceil(moveEnd) + 80);
  await dockMoved(page);
  expect(await dockValue(page)).toBe(1);
  // Back to the same place the way a reload or a return to the tab does: the browser restores the scroll.
  await page.reload();
  await hydrated(page);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(moveEnd);
  await expect.poll(() => dockValue(page)).toBe(1);
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  const runs = await page.evaluate(() => (window as Window & { __runs?: string[] }).__runs ?? []);
  expect(
    runs.filter((run) => run.includes("transform")),
    "the field's move played on load",
  ).toEqual([]);
  // And it is where a docked field belongs: in its slot, not on its way there.
  const boxes = await dockBoxes(page);
  expect(Math.abs(boxes.field.width - boxes.slot.width)).toBeLessThanOrEqual(1);
  expect(boxes.chromeTransform).toBe("none");
});

test("keeps a docked field in its slot when the bar's text moves the slot, without sliding it", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveEnd } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field follows the scroll instead of playing a move");
  await scrollAndSettle(page, Math.ceil(moveEnd) + 80);
  await dockMoved(page);
  expect(await dockValue(page)).toBe(1);
  // From here on, every transition the dock starts. Refreshing changes the bar's lead text ("Checking..."),
  // which from 40rem sits in the flow before the slot: the slot moves and resizes under a docked field.
  await page.evaluate(() => {
    const runs: string[] = [];
    (window as Window & { __runs?: string[] }).__runs = runs;
    document.addEventListener(
      "transitionrun",
      (event) => {
        const element = event.target as Element;
        if (element.closest(".search-dock")) runs.push(`${element.className} ${event.propertyName}`);
      },
      true,
    );
  });
  const refresh = controlBar(page).getByRole("button", { name: "Refresh status now" });
  await pressRefresh(page, refresh);
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  const runs = await page.evaluate(() => (window as Window & { __runs?: string[] }).__runs ?? []);
  expect(
    runs.filter((run) => run.includes("transform")),
    "the docked field slid when its slot changed",
  ).toEqual([]);
  const boxes = await dockBoxes(page);
  expect(Math.abs(boxes.field.left - boxes.slot.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.field.width - boxes.slot.width)).toBeLessThanOrEqual(1);
});

test("takes the pose a scroll gives it before the page has loaded without playing a move", async ({ page }) => {
  test.slow();
  // WebKit restores a reloaded page's scroll position as late as the end of the load, after the dock's hook has
  // run. Held here by an image that does not answer until the test says so, so the load stays open.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/__held.png", async (route) => {
    await held;
    await route.abort();
  });
  await page.addInitScript(() => {
    const runs: string[] = [];
    (window as Window & { __runs?: string[] }).__runs = runs;
    document.addEventListener(
      "transitionrun",
      (event) => {
        const element = event.target as Element;
        if (element.closest(".search-dock")) runs.push(`${element.className} ${event.propertyName}`);
      },
      true,
    );
    new Image().src = "/__held.png";
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  expect(await page.evaluate(() => document.readyState), "the load is still open").not.toBe("complete");
  const { wide, moveStart, moveEnd } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field follows the scroll instead of playing a move");
  await page.evaluate((to) => window.scrollTo(0, to), Math.ceil(moveEnd) + 80);
  await expect.poll(() => dockValue(page)).toBe(1);
  const played = () =>
    page.evaluate(() =>
      ((window as Window & { __runs?: string[] }).__runs ?? []).filter((run) => run.includes("transform")),
    );
  expect(await played(), "the field's move played before the load").toEqual([]);
  release();
  await page.waitForLoadState("load");
  expect(await dockValue(page)).toBe(1);
  const boxes = await dockBoxes(page);
  expect(Math.abs(boxes.field.width - boxes.slot.width)).toBeLessThanOrEqual(1);
  // The transitions are back for the next pose: the hold is two frames long, not for good, and the moves are
  // armed. A pose change after the load is a move again.
  await expect(page.locator(".search-dock")).not.toHaveAttribute("data-instant", "");
  await dockHeld(page, Math.floor(moveStart) - DOCK_HYSTERESIS - 4);
  // transitionrun is dispatched with the next frame, so it is waited for rather than read at once.
  await expect
    .poll(async () => (await played()).length, { message: "the field's move comes back after the load" })
    .toBeGreaterThan(0);
  await dockRelease(page);
});

test("hides the Clear button for the field's move and brings it back once the field has stopped", async ({ page }) => {
  test.slow();
  await page.goto("/?q=aws");
  await expect(page.getByRole("button", { name: "Clear search" })).toBeVisible();
  await hydrated(page);
  const { wide, moveStart } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field follows the scroll, and the button with it");
  const opacity = () =>
    page.evaluate(() =>
      Number.parseFloat(
        getComputedStyle(document.querySelector('.search-field button[aria-label="Clear search"]') as Element).opacity,
      ),
    );
  expect(await opacity()).toBe(1);
  // It would be at the docked input's edge while the fill is still wide: it waits out the move.
  expect((await dockHeld(page, Math.ceil(moveStart) + 2)).clearOpacity, "while the field docks").toBe(0);
  await dockRelease(page);
  await expect.poll(opacity).toBe(1);
  expect(
    (await dockHeld(page, Math.floor(moveStart) - DOCK_HYSTERESIS - 4)).clearOpacity,
    "while the field leaves",
  ).toBe(0);
  await dockRelease(page);
  await expect.poll(opacity).toBe(1);
});

test("fades the bar's verdict with the field's move, and brings it back when the field leaves", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveStart } = await dockOffsets(page);
  test.skip(wide || (page.viewportSize()?.width ?? 0) >= 640, "the verdict only gives way to the field under 640px");
  const opacity = () =>
    page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.querySelector("[data-bar-verdict]") as Element).opacity),
    );
  await scrollAndSettle(page, Math.ceil(moveStart) - 6);
  await barSettled(page);
  expect(await opacity(), "the verdict shows while the bar has the scrolling to itself").toBe(1);
  await dockHeld(page, Math.ceil(moveStart) + 2);
  expect(await opacity(), "it starts to fade as the field docks").toBeGreaterThan(0.9);
  await dockRelease(page);
  expect(await opacity(), "and is gone once the field is in").toBe(0);
  await dockHeld(page, Math.floor(moveStart) - DOCK_HYSTERESIS - 4);
  await dockRelease(page);
  await barSettled(page);
  expect(await opacity(), "it returns when the field leaves").toBe(1);
});

test("shortens the search placeholder as the field docks, and restores it after the field has left", async ({
  page,
}) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, moveStart } = await dockOffsets(page);
  test.skip(wide, "from 64rem there is no move in time, and the placeholder follows the field at once");
  const input = page.getByLabel("Search services");
  const rest = await input.getAttribute("placeholder");
  test.skip(rest === "Search…", "where the long placeholder does not fit, the short one is used throughout");

  // Docking: when the dock changes, when the move's transition ends, and when the placeholder changes.
  const timeline = (y: number) =>
    page.evaluate(
      (top) =>
        new Promise<{ docked: number; ended: number | null; swapped: number }>((resolve, reject) => {
          const dock = document.querySelector(".search-dock") as HTMLElement;
          const field = dock.querySelector(".search-field") as HTMLElement;
          const search = document.querySelector('input[type="search"]') as HTMLInputElement;
          const was = dock.hasAttribute("data-docked");
          const before = search.placeholder;
          const seen: { docked?: number; ended?: number } = {};
          const stop = window.setTimeout(() => reject(new Error("the placeholder never changed")), 10_000);
          const mark = new MutationObserver(() => {
            if (dock.hasAttribute("data-docked") !== was) seen.docked ??= performance.now();
          });
          mark.observe(dock, { attributes: true, attributeFilter: ["data-docked"] });
          field.addEventListener("transitionend", (event) => {
            if (event.target === field && event.propertyName === "transform") seen.ended ??= performance.now();
          });
          const swap = new MutationObserver(() => {
            if (search.placeholder === before) return;
            swap.disconnect();
            mark.disconnect();
            window.clearTimeout(stop);
            resolve({ docked: seen.docked ?? Number.NaN, ended: seen.ended ?? null, swapped: performance.now() });
          });
          swap.observe(search, { attributes: true, attributeFilter: ["placeholder"] });
          window.scrollTo(0, top);
        }),
      y,
    );
  // Going in the input is at its docked width at once, so the long text would be clipped: the short one comes with
  // the dock, in the same task, well before the move ends.
  const down = await timeline(Math.ceil(moveStart) + 2);
  expect(down.swapped - down.docked, "going in, as it docks").toBeLessThan(DOCK_MS / 2);
  if (down.ended !== null) expect(down.swapped, "going in, before the move ends").toBeLessThanOrEqual(down.ended);
  await expect(input).toHaveAttribute("placeholder", "Search…");
  await dockMoved(page);
  const up = await timeline(Math.floor(moveStart) - DOCK_HYSTERESIS - 4);
  expect(up.swapped - up.docked, "coming out, after the move").toBeGreaterThanOrEqual(DOCK_MS - 20);
  if (up.ended !== null) expect(up.swapped, "coming out, after transitionend").toBeGreaterThanOrEqual(up.ended);
  await expect(input).toHaveAttribute("placeholder", rest ?? "");
});

test("changes the search placeholder only where the field is at rest", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { path } = await dockPath(page);
  const { wide } = await dockOffsets(page);
  const stops = await sweepDock(page, path);
  const half = stops.length / 2;
  const long = "Search GCP, CS2 Europe, RouterOS…";
  // At rest it is the long one where the field has room for it, and the short one in the 200px margin column of
  // a wide screen. Either way it never changes part way: down, it changes only once the field is in the bar,
  // and back up only once the field is out of it. On a wide screen that is the stop at which --dock reaches 1 (or
  // leaves it). On a phone the field is still moving for DOCK_MS after it docks, and the placeholder waits for it
  // (a test of its own holds the move still and watches), so a stop right after the dock may still show the old one.
  const rest = stops[0].placeholder;
  expect(stops[0].dock).toBe(0);
  expect([long, "Search…"]).toContain(rest);
  for (const stop of stops.slice(0, half)) {
    if (wide) expect(stop.placeholder, `going down, at ${stop.y}`).toBe(stop.dock === 1 ? "Search…" : rest);
    else if (stop.dock === 0) expect(stop.placeholder, `going down, at ${stop.y}`).toBe(rest);
  }
  for (const stop of stops.slice(half)) {
    if (wide) expect(stop.placeholder, `coming up, at ${stop.y}`).toBe(stop.dock === 0 ? rest : "Search…");
    else if (stop.dock === 1) expect(stop.placeholder, `coming up, at ${stop.y}`).toBe("Search…");
  }
});

test("never clips the search placeholder, at any width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const search = page.getByRole("searchbox", { name: "Search services" }).or(page.getByLabel("Search services"));
  const long = "Search GCP, CS2 Europe, RouterOS…";
  for (const [width, placeholder] of [
    [1280, "Search…"],
    [1100, "Search…"],
    [1024, "Search…"],
    [768, long],
    [412, long],
    [320, "Search…"],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await expect(search, `placeholder at ${width}px`).toHaveAttribute("placeholder", placeholder);
    const { text, room } = await search.evaluate((input: HTMLInputElement) => {
      const style = getComputedStyle(input);
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font}`;
      probe.textContent = input.placeholder;
      document.body.appendChild(probe);
      const text = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        text,
        room: input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
      };
    });
    expect(text, `the placeholder fits the field at ${width}px`).toBeLessThanOrEqual(room);
  }
});

test("keeps one search input, focus, text and caret intact through the dock", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const search = page.getByLabel("Search services");
  await search.evaluate((input) => {
    (input as HTMLInputElement & { dockMark?: string }).dockMark = "the one input";
  });
  await search.focus();
  await page.keyboard.type("e");
  await expect(search).toHaveValue("e");
  await search.evaluate((input) => (input as HTMLInputElement).setSelectionRange(0, 0));

  // Through the whole move, to the end of the page, and back.
  const { path } = await dockPath(page);
  const stops = await sweepDock(page, path);
  expect(stops.some((stop) => stop.shown === "true")).toBe(true);
  for (const stop of stops) {
    expect(stop.input, `scrolled to ${stop.y}`).toEqual({
      same: true,
      mark: "the one input",
      value: "e",
      caret: 0,
      count: 1,
    });
  }
});

// On a board with things to look at, Recent changes sits in view under them; on a calm one it leads the board.
// Both are served, so the page does not depend on what the vendors say today.
for (const [name, board, ready] of [
  ["with services to look at", fixtureBoard, { id: "aws", label: "Outage" }],
  ["on a calm board", calmBoard, { id: "aws", label: "Operational" }],
] as const) {
  test(`keeps a docked field docked when a search leaves almost nothing to scroll (${name})`, async ({ page }) => {
    await openFixture(page, () => board(Date.now()), ready);
    await expect(cards(page)).toHaveCount(SERVICES);
    const bar = controlBar(page);
    await scrollAndSettle(page, (await dockNatural(page)) + 100);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect.poll(() => dockValue(page)).toBe(1);

    await page.getByLabel("Search services").fill("zzzzqq");
    await expect(cards(page)).toHaveCount(0);
    // The page has to stay tall enough to hold the field in the bar.
    await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
    expect(await dockValue(page)).toBe(1);
    await expect(bar).toHaveAttribute("data-shown", "true");
  });
}

test("docks the search field inside the bar, between its dot and its buttons", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const bar = controlBar(page);
  const field = page.locator(".search-field");
  await expect(bar).toHaveAttribute("data-shown", "false");
  // In the hero it sits below the summary.
  const before = await field.boundingBox();

  await page.locator("footer").scrollIntoViewIfNeeded();
  await expect(bar).toHaveAttribute("data-shown", "true");
  await expect.poll(() => dockValue(page)).toBe(1);
  await barSettled(page);

  const boxes = await page.evaluate(() => {
    const rect = (element: Element | null) => {
      const { left, right, top, bottom } = (element as Element).getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const bar = document.querySelector('section[aria-label="Board controls"]');
    return {
      bar: rect(bar),
      field: rect(document.querySelector(".search-field")),
      dot: rect(bar?.querySelector("p") ?? null),
      firstButton: rect(bar?.querySelector("button") ?? null),
      refresh: rect(bar?.querySelector('button[aria-label="Refresh status now"]') ?? null),
    };
  });
  const near = 0.5;
  expect(boxes.field.left).toBeGreaterThanOrEqual(boxes.bar.left - near);
  expect(boxes.field.right).toBeLessThanOrEqual(boxes.bar.right + near);
  expect(boxes.field.top).toBeGreaterThanOrEqual(boxes.bar.top - near);
  expect(boxes.field.bottom).toBeLessThanOrEqual(boxes.bar.bottom + near);
  expect(boxes.field.left).toBeGreaterThanOrEqual(boxes.dot.right - near);
  expect(boxes.field.right).toBeLessThanOrEqual(boxes.firstButton.left + near);
  expect(boxes.field.right).toBeLessThanOrEqual(boxes.refresh.left + near);
  // Centred in the bar's height, not just inside it.
  const off = (boxes.field.top + boxes.field.bottom) / 2 - (boxes.bar.top + boxes.bar.bottom) / 2;
  expect(Math.abs(off)).toBeLessThanOrEqual(near);
  // It travelled up from below the bar, where it sat in the hero.
  expect(before).not.toBeNull();
  expect(before?.y ?? 0).toBeGreaterThan(boxes.bar.bottom);
});

test("leaves the filter chips unclickable and faded while the field slides over them", async ({ page }) => {
  const width = page.viewportSize()?.width ?? 0;
  test.skip(width < 1024, "the field only shares a row with the chips from 1024px");
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { up } = await dockPath(page, 6);
  const stops = await sweepDock(page, up);
  const moving = stops.filter((stop) => stop.dock > 0 && stop.dock < 1);
  expect(moving.length).toBeGreaterThan(2);
  for (const stop of moving) {
    expect(stop.docking, `at ${stop.y}`).toBe(true);
    expect(stop.chipsClickable, `at ${stop.y}`).toBe(false);
    // Halfway in, the chips have gone.
    if (stop.dock >= 0.5) expect(stop.chipOpacity, `at ${stop.y}`).toBe(0);
  }
  // At rest a chip takes the click, not the field.
  const rest = stops.filter((stop) => stop.dock === 0);
  expect(rest.length).toBeGreaterThan(0);
  for (const stop of rest) {
    expect(stop.chipsClickable).toBe(true);
    expect(stop.chipHitByInput, `at ${stop.y}`).toBe(false);
  }
});

test("tabs from the bar's Refresh to the search field, not back up the page", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const bar = controlBar(page);
  await scrollAndSettle(page, (await dockNatural(page)) + 100);
  await expect(bar).toHaveAttribute("data-shown", "true");
  await barSettled(page);
  const scrolled = await page.evaluate(() => window.scrollY);

  await bar.getByRole("button", { name: "Refresh status now" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Search services")).toBeFocused();
  // Nothing on the way pulled the page back to the hero.
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThan(2);
  // While the bar is up, the hero's own copies are out of the tab order.
  await expect(page.locator("header").getByRole("button", { name: "Refresh status now" })).toHaveAttribute(
    "tabindex",
    "-1",
  );
});

test("lands a link to #services below the docked field, not part way into the bar", async ({ page }) => {
  await page.goto("/#services");
  await hydrated(page);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  const { fieldBottom, servicesTop } = await page.evaluate(() => ({
    fieldBottom: (document.querySelector(".search-field") as Element).getBoundingClientRect().bottom,
    servicesTop: (document.querySelector("#services") as Element).getBoundingClientRect().top,
  }));
  expect(servicesTop).toBeGreaterThanOrEqual(fieldBottom - 0.5);
});

test("shows a clear button once there is a search, and it keeps the field focused", async ({ page }) => {
  await page.goto("/?q=aws");
  await hydrated(page);
  const search = page.getByLabel("Search services");
  const clear = page.getByRole("button", { name: "Clear search" });
  await expect(clear).toBeVisible();
  const box = await clear.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await clear.click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(clear).toHaveCount(0);
  await expect(cards(page)).toHaveCount(SERVICES);
  expect(new URL(page.url()).search).toBe("");
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("steps the search field into the bar and out again, with no transition", async ({ page }) => {
    test.slow();
    await page.goto("/");
    await expect(cards(page)).toHaveCount(SERVICES);
    await hydrated(page);
    const { wide, moveEnd } = await dockOffsets(page);
    test.skip(wide, "from 64rem the field snaps through --dock, which the test below reads");
    // Nothing in the dock is timed, and nothing is left running.
    const timed = await page.evaluate(() =>
      [
        document.querySelector(".search-field"),
        document.querySelector(".search-chrome"),
        document.querySelector("[data-bar-verdict]"),
      ].map((element) => getComputedStyle(element as Element).transitionDuration),
    );
    for (const duration of timed) expect(Number.parseFloat(duration)).toBe(0);
    // Docks where the field reaches its pin: at that frame it is already in its slot, with no animation to get there.
    await dockHeld(page, Math.ceil(moveEnd) + 1);
    const boxes = await dockBoxes(page);
    const running = await page.evaluate(
      () => (document.querySelector(".search-dock") as HTMLElement).getAnimations({ subtree: true }).length,
    );
    expect(running, "no transition plays under Reduce Motion").toBe(0);
    for (const key of ["left", "width"] as const) {
      expect(
        Math.abs(boxes.field[key] - boxes.slot[key]),
        `the field's ${key}, in its slot at once`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(boxes.chrome[key] - boxes.slot[key]),
        `the fill's ${key}, in its slot at once`,
      ).toBeLessThanOrEqual(1);
    }
    // Back out: it is full width again in the same frame.
    await dockHeld(page, Math.floor(moveEnd) - 12);
    const out = await dockBoxes(page);
    expect(out.field.width).toBeCloseTo(out.dock.width, 0);
    expect(out.chrome.width).toBeCloseTo(out.dock.width, 0);
  });

  test("keeps the field under the bar until it docks, and over it from then on", async ({ page }) => {
    test.slow();
    await page.goto("/");
    await expect(cards(page)).toHaveCount(SERVICES);
    await hydrated(page);
    const { wide, moveEnd } = await dockOffsets(page);
    test.skip(wide, "from 64rem the bar is not fixed, and the field is always over it");
    const zIndex = () => searchDock(page).evaluate((dock) => Number(getComputedStyle(dock).zIndex));
    const barZ = await controlBar(page).evaluate((bar) => Number(getComputedStyle(bar).zIndex));
    // The field rises through the bar's own place at full width before it steps in: it must not cover the buttons.
    expect(await zIndex(), "at the top").toBeLessThan(barZ);
    await scrollAndSettle(page, Math.floor(moveEnd) - 12);
    expect(await zIndex(), "rising towards its pin").toBeLessThan(barZ);
    await dockHeld(page, Math.ceil(moveEnd) + 1);
    expect(await zIndex(), "as it docks").toBeGreaterThan(barZ);
    await dockHeld(page, Math.floor(moveEnd) - 12);
    expect(await zIndex(), "as it leaves").toBeLessThan(barZ);
  });

  test("holds a docked field in the bar only as far as the bar has room around it", async ({ page }) => {
    test.slow();
    await page.goto("/");
    await expect(cards(page)).toHaveCount(SERVICES);
    await hydrated(page);
    const { wide, moveEnd } = await dockOffsets(page);
    test.skip(wide, "from 64rem the snap has no hold");
    // The bar's height less the field's and the field's inset from the bar's top: how far the narrow field can
    // descend before it pokes out of the bar's bottom edge.
    const hold = await page.evaluate(() => {
      const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
      const dock = document.querySelector(".search-dock") as HTMLElement;
      const pin = Number.parseFloat(getComputedStyle(dock).top);
      const barTop = Number.parseFloat(getComputedStyle(bar).top);
      return Math.max(0, bar.offsetHeight - dock.offsetHeight - (pin - barTop));
    });
    expect(hold, "not the 8px of a bar that moves in time").toBeLessThan(DOCK_HYSTERESIS);
    const at = async (y: number) => {
      await scrollAndSettle(page, y);
      return dockValue(page);
    };
    expect(await at(Math.ceil(moveEnd) + 1)).toBe(1);
    // Held at the far end of the hold, the narrow field is still inside the bar.
    const held = Math.ceil(moveEnd - hold) + 1;
    expect(await at(held)).toBe(1);
    const { field, bar } = await dockBoxes(page);
    expect(field.bottom, "the held field is inside the bar").toBeLessThanOrEqual(bar.bottom + 0.5);
    // Beyond the hold it is released, before it can poke out.
    expect(await at(Math.floor(moveEnd - hold) - 3)).toBe(0);
  });

  test("snaps the search field into the bar and out again, never part way", async ({ page }) => {
    test.slow();
    await page.goto("/");
    await expect(cards(page)).toHaveCount(SERVICES);
    await hydrated(page);
    const { path } = await dockPath(page);
    const stops = await sweepDock(page, path);
    expect([...new Set(stops.map((stop) => stop.dock))].sort()).toEqual([0, 1]);
    // The bar never shows over a field that has not snapped into it, going down or coming back up.
    if ((await dockOffsets(page)).wide) {
      for (const stop of stops.filter((stop) => stop.shown === "true")) {
        expect(stop.dock, `at ${stop.y}`).toBe(1);
      }
    }
    // The two phases stay apart without motion: on a phone the bar is up before the field snaps in.
    if (!(await dockOffsets(page)).wide) {
      expect(stops.some((stop) => stop.shown === "true" && stop.dock === 0)).toBe(true);
    }
  });
});

test("marks the search field for an iPhone keyboard: search key, no autocorrect", async ({ page }) => {
  await page.goto("/");
  await hydrated(page);
  const input = page.getByLabel("Search services");
  await expect(input).toHaveAttribute("type", "search");
  await expect(input).toHaveAttribute("enterkeyhint", "search");
  await expect(input).toHaveAttribute("autocapitalize", "off");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveAttribute("spellcheck", "false");
});

test("sets the search field at 16px on a touch screen, so iPhone does not zoom in", async ({ page }) => {
  await page.goto("/");
  await hydrated(page);
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  test.skip(!coarse, "the zoom guard is for a coarse pointer, which this project does not have");
  const size = await page.getByLabel("Search services").evaluate((input) => getComputedStyle(input).fontSize);
  expect(Number.parseFloat(size)).toBeGreaterThanOrEqual(16);
});

test("renders healthy services as rows, alike whether or not the vendor lists components", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  await openFixture(page, () => board);

  // Each category's heading counts the rows under it.
  const up = group(page, "up");
  const total = await up.count();
  expect(total).toBeGreaterThan(0);
  const counts = await page.locator('[data-group="up"] h2').allTextContents();
  expect(counts.reduce((sum, text) => sum + Number(text.replace(/\D/g, "")), 0)).toBe(total);

  for (const id of ["chatgpt", "claude", "grok"] as const) {
    const service = board.services.find((item) => item.id === id);
    if (!service) throw new Error(`the fixture has no ${id}`);
    const card = page.locator(`article#service-${id}`);
    // In a category's list, not a card of its own.
    await expect(up.and(card), `${id} sits in a list of healthy services`).toHaveCount(1);
    // The same parts on every one: name, word, star, link to the official source.
    await expect(card.getByRole("heading", { level: 3, name: service.name })).toBeVisible();
    // The word in the row's header, not the component list's screen-reader-only state words.
    await expect(card.locator("[data-card-header]").getByText("Operational", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: `Star ${service.name}` })).toBeVisible();
    await expect(card.locator(`a[href="${service.sourceUrl}"]`)).toBeVisible();
    // A row opens to its components when the vendor reports them, and only then.
    const list = card.getByRole("list", { name: "Components" });
    if (service.components.length === 0) {
      await expect(card.locator("details")).toHaveCount(0);
      await expect(list).toHaveCount(0);
    } else {
      await card.locator("summary").click();
      await expect(list).toHaveCount(1);
      await expect(list.getByRole("listitem")).toHaveCount(Math.min(service.components.length, 6));
      for (const component of service.components.slice(0, 6)) {
        await expect(list.getByText(component.name, { exact: true })).toBeVisible();
      }
    }
  }
});

/** Whether the element sits wholly inside the viewport, so a reader never loses the button they just pressed. */
const inViewport = (locator: Locator) =>
  locator.evaluate((element) => {
    const { top, bottom } = element.getBoundingClientRect();
    return top >= 0 && bottom <= window.innerHeight;
  });

test("opens a long component list with Show all and closes it with Show fewer", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  await openFixture(page, () => board);
  const card = page.locator("article#service-spotify");
  await card.locator("summary").click();
  const list = card.getByRole("list", { name: "Components" });
  const toggle = card.getByRole("button", { name: /^Show all 32/ });
  await expect(list.getByRole("listitem")).toHaveCount(6);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // A 44pt target.
  const box = await toggle.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  await toggle.click();
  await expect(list.getByRole("listitem")).toHaveCount(32);
  const fewer = card.getByRole("button", { name: /^Show fewer/ });
  await expect(fewer).toHaveAttribute("aria-expanded", "true");
  await expect(fewer).toBeFocused();
  await expect(list.getByText("Spotify part 32", { exact: true })).toBeVisible();

  await fewer.scrollIntoViewIfNeeded();
  await fewer.click();
  await expect(list.getByRole("listitem")).toHaveCount(6);
  expect(await inViewport(card.getByRole("button", { name: /^Show all 32/ }))).toBe(true);
  await expect(card.getByRole("button", { name: /^Show all 32/ })).toHaveAttribute("aria-expanded", "false");
});

// The check at the turn of a slot adds a row to Recent changes and clears the "Changed" tags of the one before,
// above the lists. Chrome and Firefox keep the reader's place when that happens (scroll anchoring); Safari has
// none, so the page has to scroll by the distance itself, or the button under the reader's finger moves away
// from it. The "none" pass switches the browser's anchoring off to be Safari, which is the only way to see it
// here. What is asserted is the reader's side: the Show all button stays where it is on screen, on every layout.
// Whether the page scrolled itself follows from whether this browser anchors.
for (const anchoring of ["none", "default"] as const) {
  test(`keeps Show all in place across the turn of a slot (scroll anchoring ${anchoring})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      const scrolled: number[] = [];
      (window as Window & { __scrolledBy?: number[] }).__scrolledBy = scrolled;
      const original = window.scrollBy;
      window.scrollBy = ((...args: unknown[]) => {
        const first = args[0] as ScrollToOptions | number | undefined;
        scrolled.push(typeof first === "object" ? (first?.top ?? 0) : ((args[1] as number | undefined) ?? 0));
        return (original as (...values: unknown[]) => void).apply(window, args);
      }) as typeof window.scrollBy;
    });
    await page.clock.install({ time: Date.now() });
    const board = fixtureBoard(Date.now());
    await openFixture(page, () => board);
    if (anchoring !== "default") {
      await page.evaluate((value) => {
        document.documentElement.style.overflowAnchor = value;
      }, anchoring);
    }
    // What this browser does with the request: Safari ignores "auto" when it has no scroll anchoring.
    const anchors = await page.evaluate(
      () =>
        CSS.supports("overflow-anchor", "auto") && getComputedStyle(document.documentElement).overflowAnchor !== "none",
    );
    const card = page.locator("article#service-spotify");
    await card.locator("summary").click();
    const toggle = card.getByRole("button", { name: /^Show all 32/ });
    await toggle.scrollIntoViewIfNeeded();
    // The feed is above the top of the window.
    await page.evaluate(() => window.scrollBy(0, 200));
    // The reader is about to press it.
    await toggle.hover();
    // Let the hook see where the reader is.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.evaluate(() => {
      (window as Window & { __scrolledBy?: number[] }).__scrolledBy?.splice(0);
    });
    const feed = page.locator('section[aria-labelledby="recent-heading"]');
    const height = () => feed.evaluate((element) => element.getBoundingClientRect().height);
    const topOf = () => toggle.evaluate((element) => element.getBoundingClientRect().top);
    const rows = await feed.locator("li").count();
    const heightBefore = await height();
    const topBefore = await topOf();
    await page.clock.fastForward("03:00");
    await expect(feed.locator("li")).not.toHaveCount(rows);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect((await height()) - heightBefore).toBeGreaterThan(0);
    const scrolled = await page.evaluate(() => (window as Window & { __scrolledBy?: number[] }).__scrolledBy);
    if (anchors) expect(scrolled).toEqual([]);
    else expect(scrolled?.length).toBeGreaterThan(0);
    // Where the browser anchors, it holds its own pick of the page, which on a phone's layout is not always the
    // button under the pointer (a "Changed" tag going out between the two moves it); the wide layout is held.
    if (!anchors || testInfo.project.name === "desktop") {
      expect(Math.abs((await topOf()) - topBefore)).toBeLessThanOrEqual(1);
    }
  });
}

// With the browser's anchoring off (Safari), a check on a board the reader is not working must not move it: with
// the hero or the search field in view, the page stays where it is, and the dock keeps its pose.
for (const scrollY of [40, 190]) {
  test(`leaves a calm board alone when a check lands at scroll ${scrollY} (anchoring off)`, async ({ page }) => {
    await page.addInitScript(() => {
      const scrolled: number[] = [];
      (window as Window & { __scrolledBy?: number[] }).__scrolledBy = scrolled;
      const original = window.scrollBy;
      window.scrollBy = ((...args: unknown[]) => {
        scrolled.push(1);
        return (original as (...values: unknown[]) => void).apply(window, args);
      }) as typeof window.scrollBy;
    });
    await page.clock.install({ time: Date.now() });
    await openFixture(page, () => calmBoard(Date.now()), { id: "aws", label: "Operational" });
    await page.evaluate(() => {
      document.documentElement.style.overflowAnchor = "none";
    });
    const dock = page.locator(".search-dock");
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    // Let the page be still, and the hook see it.
    await page.clock.fastForward(1000);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const state = () =>
      page.evaluate(() => ({
        y: window.scrollY,
        docked: document.querySelector(".search-dock")?.hasAttribute("data-docked") ?? false,
        calls: (window as Window & { __scrolledBy?: number[] }).__scrolledBy?.length ?? 0,
      }));
    const before = await state();
    await page.clock.fastForward("03:00");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const after = await state();
    expect(after.y).toBe(before.y);
    expect(after.docked).toBe(before.docked);
    expect(after.calls).toBe(before.calls);
    await expect(dock).toHaveCount(1);
  });
}

// A tap leaves no pointer and no focus on the board, so the hook holds the first thing in view: the cards under
// the feed, never the feed itself.
test("holds the cards in place after a tap with anchoring off", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "a finger is the phone project's");
  await page.clock.install({ time: Date.now() });
  await openFixture(page, () => fixtureBoard(Date.now()));
  await page.evaluate(() => {
    document.documentElement.style.overflowAnchor = "none";
  });
  const card = page.locator("article#service-spotify");
  await card.locator("summary").click();
  const toggle = card.getByRole("button", { name: /^Show all 32/ });
  await toggle.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 200));
  const box = await toggle.boundingBox();
  if (!box) throw new Error("no box");
  await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
  // The tap opened the list and left focus on a button; let go of it, so only the first thing in view is left.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const fewer = card.getByRole("button", { name: /^Show fewer/ });
  await fewer.scrollIntoViewIfNeeded();
  // The page is still for longer than the hook waits, and it has picked its anchor again.
  await page.clock.fastForward(1000);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const feed = page.locator('section[aria-labelledby="recent-heading"]');
  const rows = await feed.locator("li").count();
  const topOf = () => fewer.evaluate((element) => element.getBoundingClientRect().top);
  const topBefore = await topOf();
  await page.clock.fastForward("03:00");
  await expect(feed.locator("li")).not.toHaveCount(rows);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(Math.abs((await topOf()) - topBefore)).toBeLessThanOrEqual(1);
});

test("operates Show all from the keyboard", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a keyboard is the desktop project's");
  const board = fixtureBoard(Date.now());
  await openFixture(page, () => board);
  const card = page.locator("article#service-spotify");
  await card.locator("summary").focus();
  await page.keyboard.press("Enter");
  const toggle = card.getByRole("button", { name: /^Show all 32/ });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("list", { name: "Components" }).getByRole("listitem")).toHaveCount(32);
  await expect(card.getByRole("button", { name: /^Show fewer/ })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(card.getByRole("list", { name: "Components" }).getByRole("listitem")).toHaveCount(6);
});

test("gives an attention card the same dropdown, with the working components in it", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  await openFixture(page, () => board);
  const card = page.locator("article#service-gcp");
  // The broken components stay in view; the working ones wait in the dropdown.
  await expect(card.locator("[data-component-row]")).toHaveCount(2);
  const dropdown = card.locator("details[data-healthy-components]");
  await expect(dropdown).toHaveCount(1);
  await expect(dropdown.locator("summary")).toContainText("Working components");
  await dropdown.locator("summary").click();
  const list = dropdown.getByRole("list", { name: "Components" });
  await expect(list.getByRole("listitem")).toHaveCount(6);
  await dropdown.getByRole("button", { name: /^Show all 38/ }).click();
  await expect(list.getByRole("listitem")).toHaveCount(38);
  // A service without components has no dropdown on its attention card either.
  await expect(page.locator("article#service-aws details")).toHaveCount(0);
});

test("shows the dropdown for a Statuspage vendor on a healthy row and on an attention card, and a 300-component list expands whole", async ({
  page,
}) => {
  const board = fixtureBoard(Date.now());
  const claude = board.services.find((service) => service.id === "claude");
  const chatgpt = board.services.find((service) => service.id === "chatgpt");
  if (!claude || !chatgpt) throw new Error("the fixture has no Claude or ChatGPT");
  // Claude is broken with one degraded component among 299 working ones, the most a collector keeps.
  claude.health = "degraded";
  claude.summary = "Elevated errors on Claude API";
  claude.components = [
    { name: "Claude API", health: "degraded" },
    ...Array.from({ length: 299 }, (_, index) => ({
      name: `Claude part ${index + 1}`,
      health: "operational" as const,
    })),
  ];
  claude.incidents = [
    {
      id: "claude-1",
      title: "Elevated errors",
      health: "degraded",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
    },
  ];
  await openFixture(page, () => board);

  // The attention card: the broken component in view, the working ones in the dropdown.
  const card = page.locator("article#service-claude");
  await expect(card.locator("[data-component-row]")).toHaveCount(1);
  const dropdown = card.locator("details[data-healthy-components]");
  await expect(dropdown.locator("summary")).toContainText("Working components");
  await dropdown.locator("summary").click();
  const list = dropdown.getByRole("list", { name: "Components" });
  await expect(list.getByRole("listitem")).toHaveCount(6);
  await dropdown.getByRole("button", { name: /^Show all 299/ }).click();
  await expect(list.getByRole("listitem")).toHaveCount(299);
  await expect(list.getByText("Claude part 299", { exact: true })).toBeVisible();
  const fewer = dropdown.getByRole("button", { name: /^Show fewer/ });
  await fewer.scrollIntoViewIfNeeded();
  await fewer.click();
  await expect(list.getByRole("listitem")).toHaveCount(6);
  // A 299-row list closing must not strand the reader far below the button they pressed.
  expect(await inViewport(dropdown.getByRole("button", { name: /^Show all 299/ }))).toBe(true);
  await expect(dropdown.getByRole("button", { name: /^Show all 299/ })).toBeFocused();

  // A healthy Statuspage row keeps the same dropdown.
  const row = page.locator("article#service-chatgpt");
  await expect(group(page, "up").and(row)).toHaveCount(1);
  await row.locator("summary").click();
  await expect(row.getByRole("list", { name: "Components" }).getByRole("listitem")).toHaveCount(5);
  await expect(row.getByRole("button", { name: /^Show all/ })).toHaveCount(0);
});

test("closing a long list of broken rows on an attention card keeps its button in view", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  const gcp = board.services.find((service) => service.id === "gcp");
  if (!gcp) throw new Error("the fixture has no Google Cloud");
  gcp.components = Array.from({ length: 120 }, (_, index) => ({
    name: `Broken ${index + 1}`,
    health: "degraded" as const,
  }));
  await openFixture(page, () => board);
  const card = page.locator("article#service-gcp");
  await card.getByRole("button", { name: /^Show all 120/ }).click();
  const fewer = card.getByRole("button", { name: /^Show fewer/ });
  await fewer.scrollIntoViewIfNeeded();
  await fewer.click();
  const more = card.getByRole("button", { name: /^Show all 120/ });
  await expect(more).toBeFocused();
  expect(await inViewport(more)).toBe(true);
});

test("leads Needs attention with the most urgent service and follows the data", async ({ page }) => {
  let board = fixtureBoard(Date.now());
  await openFixture(page, () => board);

  const attention = group(page, "attention");
  // AWS is an outage, Google Cloud is degraded, Epic is in maintenance. Android could not be read: that is its own group.
  await expect(attention).toHaveCount(3);
  await expect(attention.nth(0)).toHaveAttribute("id", "service-aws");
  await expect(attention.nth(1)).toHaveAttribute("id", "service-gcp");
  await expect(attention.nth(2)).toHaveAttribute("id", "service-epic");
  await expect(group(page, "unread")).toHaveCount(1);
  await expect(group(page, "unread").first()).toHaveAttribute("id", "service-android");

  // Exactly one card is the highlight, and it is the first.
  const highlight = page.locator('article[data-highlight="true"]');
  await expect(highlight).toHaveCount(1);
  await expect(highlight).toHaveAttribute("id", "service-aws");
  // No caption crowns it: the attribute is the whole mark. A service that could not be read never carries it.
  await expect(highlight).not.toContainText("Most urgent");
  await expect(page.locator("article#service-android")).not.toHaveAttribute("data-highlight");
  // It holds the whole card, not a stub of it.
  await expect(highlight.getByText("Outage", { exact: true }).first()).toBeVisible();
  await expect(highlight.locator('a[href^="https://"]')).toBeVisible();

  // Grok's outage began after AWS's, so it takes the lead on the next refresh.
  board = fixtureBoard(Date.now(), { grok: "outage" });
  await pressRefresh(page, page.getByRole("button", { name: "Refresh status now" }).first());
  await expect(attention.first()).toHaveAttribute("id", "service-grok");
  await expect(highlight).toHaveCount(1);
  await expect(highlight).toHaveAttribute("id", "service-grok");

  // With nothing to attend to there is no highlight and no group.
  const now = Date.now();
  board = {
    ...fixtureBoard(now),
    services: fixtureBoard(now).services.map((item) => ({
      ...item,
      health: "operational" as const,
      summary: "All systems operational",
      components: [],
      incidents: [],
      failure: undefined,
    })),
    counts: { operational: SERVICES, degraded: 0, outage: 0, maintenance: 0, unknown: 0 },
  };
  await pressRefresh(page, page.getByRole("button", { name: "Refresh status now" }).first());
  await expect(attention).toHaveCount(0);
  await expect(highlight).toHaveCount(0);
  await expect(cards(page)).toHaveCount(SERVICES);
});

test("keeps keyboard focus on a Star button when its card becomes the most urgent", async ({ page }) => {
  // Google Cloud and Grok are both degraded, with one start time: a tie, so catalog order
  // (Google Cloud first) decides, until a star breaks it.
  const now = Date.now();
  const startedAt = new Date(now - 30 * 60_000).toISOString();
  const base = fixtureBoard(now, { grok: "degraded" });
  const services = base.services.map((item) => {
    if (item.id === "gcp" || item.id === "grok") {
      return { ...item, health: "degraded" as const, incidents: item.incidents.map((i) => ({ ...i, startedAt })) };
    }
    return item.health === "operational" || item.category === "updates"
      ? item
      : {
          ...item,
          health: "operational" as const,
          summary: "All systems operational",
          components: [],
          incidents: [],
          failure: undefined,
        };
  });
  const counts = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const item of services) counts[item.health] += 1;
  const board: BoardSnapshot = { ...base, services, counts };
  await openFixture(page, () => board, { id: "grok", label: "Degraded" });

  const attention = group(page, "attention");
  await expect(attention).toHaveCount(2);
  await expect(attention.nth(0)).toHaveAttribute("id", "service-gcp");
  await expect(attention.nth(1)).toHaveAttribute("id", "service-grok");
  const highlight = page.locator('article[data-highlight="true"]');
  await expect(highlight).toHaveAttribute("id", "service-gcp");

  // Mark the second card's node, to tell a move from a remount afterwards.
  await page.locator("article#service-grok").evaluate((node) => {
    (node as HTMLElement & { __same?: boolean }).__same = true;
  });

  // Star it from the keyboard.
  const star = page.locator("article#service-grok").getByRole("button", { name: "Star Grok", exact: true });
  await star.focus();
  await expect(star).toBeFocused();
  await toggleStar(page, () => page.keyboard.press("Enter"));
  await expect(star).toHaveAttribute("aria-pressed", "true");

  // It is now first and the highlight, and focus never left its button.
  await expect(attention.nth(0)).toHaveAttribute("id", "service-grok");
  await expect(highlight).toHaveCount(1);
  await expect(highlight).toHaveAttribute("id", "service-grok");
  await expect(page.locator("article#service-gcp")).not.toHaveAttribute("data-highlight");
  await expect(star).toBeFocused();
  expect(
    await page.evaluate(() => {
      const active = document.activeElement;
      return {
        label: active?.getAttribute("aria-label"),
        card: active?.closest("article")?.id,
        sameNode: (document.getElementById("service-grok") as (HTMLElement & { __same?: boolean }) | null)?.__same,
      };
    }),
  ).toEqual({ label: "Star Grok", card: "service-grok", sameNode: true });

  // Unstarring hands the lead back, and focus still stays.
  await toggleStar(page, () => page.keyboard.press("Enter"));
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await expect(attention.nth(0)).toHaveAttribute("id", "service-gcp");
  await expect(highlight).toHaveAttribute("id", "service-gcp");
  await expect(star).toBeFocused();
});

test("highlights the board's most urgent service only while it is on screen", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  await openFixture(page, () => board);
  const highlight = page.locator('article[data-highlight="true"]');
  await expect(highlight).toHaveAttribute("id", "service-aws");

  // Searching leaves Google Cloud first, but it is not the board's most urgent: no highlight.
  await page.getByLabel("Search services").fill("Google Cloud");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute("id", "service-gcp");
  await expect(highlight).toHaveCount(0);
});

test("keeps the groups, filters and stars working with full cards", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  await openFixture(page, () => board);

  // Needs a look first, then what could not be read, then one list per category (Cloud is all down here), then Releases.
  await expect(
    page.locator('#attention-heading, #unread-heading, [id^="up-"][id$="-heading"], #releases-heading'),
  ).toHaveText([/Needs a look\s*3/, /Couldn't read\s*1/, /Gaming\s*3/, /Platforms\s*2/, /AI\s*3/, /Releases\s*2/]);

  // Issues only leaves the three that need a look, the highlight among them: the unreadable
  // source in the fixture is not an issue, only a source that could not be read.
  const issues = page.getByRole("button", { name: /Issues only/ });
  await issues.click();
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('article[data-highlight="true"]')).toHaveAttribute("id", "service-aws");
  await issues.click();
  await expect(cards(page)).toHaveCount(SERVICES);

  // A star lifts a healthy row to the head of its category's list, but never above a worse service in Needs a look.
  const starClaude = page.getByRole("button", { name: "Star Claude", exact: true });
  await toggleStar(page, () => starClaude.click());
  await expect(starClaude).toHaveAttribute("aria-pressed", "true");
  await expect(upList(page, "ai").first()).toHaveAttribute("id", "service-claude");
  const starGoogleCloud = page.getByRole("button", { name: "Star Google Cloud", exact: true });
  await toggleStar(page, () => starGoogleCloud.click());
  await expect(starGoogleCloud).toHaveAttribute("aria-pressed", "true");
  await expect(group(page, "attention").first()).toHaveAttribute("id", "service-aws");
  await page.getByRole("button", { name: /^Starred/ }).click();
  await expect(cards(page)).toHaveCount(2);
});

test("glides a starred card to its place without naming the cards for a view transition", async ({ page }) => {
  await recordAnimations(page);
  await openFixture(page, () => fixtureBoard(Date.now()));
  // The AI list holds three rows, so the last one travels more than a row's height to the top.
  const operational = upList(page, "ai");
  const farthest = await operational.last().getAttribute("id");
  const first = await operational.first().getAttribute("id");
  expect(farthest).not.toBe(first);

  // No card carries a view-transition-name: a named card is captured by every transition, and a star pays for all of them.
  expect(
    await cards(page).evaluateAll(
      (nodes) => nodes.filter((node) => getComputedStyle(node).viewTransitionName !== "none").length,
    ),
  ).toBe(0);

  const before = await cardGlides(page);
  const star = page.locator(`article#${farthest}`).locator("button[aria-pressed]").first();
  await toggleStar(page, () => star.click());
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect(operational.first()).toHaveAttribute("id", farthest ?? "");
  expect(await cardGlides(page)).toBeGreaterThan(before);
  await expect(page.locator(`article#${farthest}`)).toHaveCSS("view-transition-name", "none");
});

test("moves a starred card without a glide when the system asks for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await recordAnimations(page);
  await openFixture(page, () => fixtureBoard(Date.now()));
  const operational = upList(page, "ai");
  const farthest = await operational.last().getAttribute("id");
  const before = await cardGlides(page);
  const star = page.locator(`article#${farthest}`).locator("button[aria-pressed]").first();
  await toggleStar(page, () => star.click());
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect(operational.first()).toHaveAttribute("id", farthest ?? "");
  expect(await cardGlides(page)).toBe(before);
  expect(before).toBe(0);
});

/**
 * Serves the fixture with Grok operational until the next Refresh press, and degraded from that press on. The
 * change arrives with the press, not with a poll that happens to land first on a slow machine (which would move
 * the cards unseen and leave the press nothing to glide), and it stays, so a later poll does not undo it.
 */
async function grokDegradesOnPress(page: Page): Promise<void> {
  let pressed = false;
  await serveBoard(
    page,
    () => fixtureBoard(Date.now(), { grok: pressed ? "degraded" : "operational" }),
    () => {
      pressed = true;
      return fixtureBoard(Date.now(), { grok: "degraded" });
    },
  );
}

test("glides the cards a refresh moves", async ({ page }) => {
  await recordAnimations(page);
  await traceGlides(page);
  await openFixture(page, () => fixtureBoard(Date.now()));
  await grokDegradesOnPress(page);
  const before = await cardGlides(page);

  // Grok leaves Operational for Needs attention and pushes the cards below it down. On a phone those start
  // below the fold, and a card nobody sees does not glide, so bring the second attention card up first.
  await page.evaluate(() => {
    const card = document.getElementById("service-gcp");
    if (!card) throw new Error("service-gcp is not on the board");
    window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 100, behavior: "instant" });
  });
  // Clicked from the page, not by the pointer: Playwright scrolls the hero's button back into view to click it.
  const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
  await pressRefresh(page, refresh, () => refresh.evaluate((button) => (button as HTMLElement).click()));
  await expect(page.locator('section[aria-labelledby="attention-heading"] #service-grok')).toHaveCount(1);
  try {
    expect(await cardGlides(page)).toBeGreaterThan(before);
  } catch (error) {
    console.log(`[glide] ${JSON.stringify({ before, ...(await glideTrace(page)) })}`);
    throw error;
  }
});

test("does not count a scroll between measuring and the commit as cards moving", async ({ page }) => {
  await recordAnimations(page);
  await openFixture(page, () => fixtureBoard(Date.now()));
  await grokDegradesOnPress(page);
  const before = await cardGlides(page);
  const first = await group(page, "attention").first().getAttribute("id");

  // The first attention card near the top of the screen, so it and the card below it are both in view whatever
  // the phone's height. The refresh is clicked from the page: Playwright would scroll the hero's button into view.
  await page.evaluate((id) => {
    const card = id ? document.getElementById(id) : null;
    if (!card) throw new Error(`${id} is not on the board`);
    window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 300, behavior: "instant" });
  }, first);
  // withCardMotion cancels running glides right after measuring the cards, ahead of the update. Scrolling
  // then is a page scrolling on its own (a tap focusing a control, WebKit's do) before a deferred commit.
  await page.evaluate(() => {
    const getAnimations = document.getAnimations.bind(document);
    document.getAnimations = () => {
      document.getAnimations = getAnimations;
      window.scrollTo({ top: window.scrollY + 150, behavior: "instant" });
      return getAnimations();
    };
  });
  const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
  await pressRefresh(page, refresh, () => refresh.evaluate((button) => (button as HTMLElement).click()));
  await expect(page.locator('section[aria-labelledby="attention-heading"] #service-grok')).toHaveCount(1);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);

  // The scroll moved every card in the viewport by the same amount and none on the page. The first attention
  // card shifts by a few pixels at most (the hero above it changes), never by the 150 px the page scrolled.
  const glides = await page.evaluate(() =>
    ((window as Window & { __animations?: Animation[] }).__animations ?? [])
      .filter((animation) => animation.id === "card-move")
      .map((animation) => {
        const effect = animation.effect as KeyframeEffect;
        return { id: effect.target?.id, from: String(effect.getKeyframes()[0].transform) };
      }),
  );
  const fromRefresh = glides.slice(before);
  expect(fromRefresh.length).toBeGreaterThan(0);
  for (const glide of fromRefresh.filter((item) => item.id === first)) {
    const dy = Number(/,\s*(-?[\d.]+)px\)/.exec(glide.from)?.[1]);
    expect(Math.abs(dy)).toBeLessThan(100);
  }
});

test("does not glide a filter that follows a star which moved nothing", async ({ page }) => {
  await recordAnimations(page);
  await openFixture(page, () => fixtureBoard(Date.now()));
  const before = await cardGlides(page);

  // The most urgent card is already first: starring it changes no place.
  const lead = group(page, "attention").first();
  const leadId = await lead.getAttribute("id");
  await toggleStar(page, () => lead.locator("button[aria-pressed]").first().click());
  await expect(lead.locator("button[aria-pressed]").first()).toHaveAttribute("aria-pressed", "true");
  await expect(group(page, "attention").first()).toHaveAttribute("id", leadId ?? "");

  // A filter typed at once is not part of that star, so nothing glides against its stale layout.
  await page.getByLabel("Search services").fill("Google Cloud");
  await expect(cards(page)).toHaveCount(1);
  await motionDone(page);
  expect(await longGlides(page, before)).toEqual([]);
});

test("does not glide a resize that follows a star which moved nothing", async ({ page }) => {
  await recordAnimations(page);
  await traceGlides(page);
  await openFixture(page, () => fixtureBoard(Date.now()));
  const before = await cardGlides(page);

  const lead = group(page, "attention").first();
  await toggleStar(page, () => lead.locator("button[aria-pressed]").first().click());
  await expect(lead.locator("button[aria-pressed]").first()).toHaveAttribute("aria-pressed", "true");

  // A rotation relays the cards out with no change to the page's markup...
  const size = page.viewportSize();
  if (!size) throw new Error("no viewport size");
  await page.setViewportSize({ width: size.width > 800 ? 700 : 900, height: size.height });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  // ...and the next unrelated change to the board must not glide the cards across against the old layout.
  await page.evaluate(() => document.getElementById("services")?.appendChild(document.createTextNode(" ")));
  await motionDone(page);
  try {
    expect(await longGlides(page, before)).toEqual([]);
  } catch (error) {
    console.log(`[glide] ${JSON.stringify({ before, ...(await glideTrace(page)) })}`);
    throw error;
  }
});

test("does not glide a resize whose event the board has not seen", async ({ page }) => {
  // The page's resize event is dispatched with the next frame, after a change to the board can already have
  // been seen against the new layout. Swallowing it stands in for that order.
  await page.addInitScript(() => {
    window.addEventListener("resize", (event) => event.stopImmediatePropagation(), true);
  });
  await recordAnimations(page);
  await openFixture(page, () => fixtureBoard(Date.now()));
  const before = await cardGlides(page);

  const lead = group(page, "attention").first();
  await toggleStar(page, () => lead.locator("button[aria-pressed]").first().click());
  await expect(lead.locator("button[aria-pressed]").first()).toHaveAttribute("aria-pressed", "true");

  const size = page.viewportSize();
  if (!size) throw new Error("no viewport size");
  await page.setViewportSize({ width: size.width > 800 ? 700 : 900, height: size.height });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).not.toBe(size.width);
  await page.evaluate(() => document.getElementById("services")?.appendChild(document.createTextNode(" ")));
  await motionDone(page);
  expect(await longGlides(page, before)).toEqual([]);
});

test("does not glide a scroll and filter that follow a refresh which changed nothing", async ({ page }) => {
  await recordAnimations(page);
  await traceGlides(page);
  const now = Date.now();
  await openFixture(page, () => fixtureBoard(now));
  const before = await cardGlides(page);

  const button = page.getByRole("button", { name: "Refresh status now" }).first();
  const answered = page.waitForResponse(
    (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
  );
  await button.click();
  await answered;
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.getByLabel("Search services").fill("Google Cloud");
  await expect(cards(page)).toHaveCount(1);
  await expect(button).toHaveAttribute("aria-busy", "false");
  await motionDone(page);
  try {
    expect(await longGlides(page, before)).toEqual([]);
  } catch (error) {
    console.log(`[glide] ${JSON.stringify({ before, ...(await glideTrace(page)) })}`);
    throw error;
  }
});

test("keeps Reduce glass across a reload", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const html = page.locator("html");
  await expect(html).not.toHaveAttribute("data-reduce-transparency");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Reduce glass" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(html).toHaveAttribute("data-reduce-transparency", "true");
  expect((await backdropFilters(page, PANELS)).filter((value) => value !== "none")).toEqual([]);

  const problems = watchConsole(page);
  await page.reload();
  await expect(html).toHaveAttribute("data-reduce-transparency", "true");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Reduce glass" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("switch", { name: "Reduce glass" }).click();
  await expect(html).not.toHaveAttribute("data-reduce-transparency");
  // The attribute set before hydration must not upset React.
  expect(problems).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`renders the ${colorScheme} appearance with no console errors`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const problems = watchConsole(page);
    await page.goto("/");
    await expect(cards(page)).toHaveCount(SERVICES);
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
}

/**
 * axe cannot measure text over a backdrop-filter or a gradient: it reports
 * those as incomplete rather than failing them. With every blur, gradient
 * and pseudo-element stripped, only the materials' flat fills remain behind
 * the text, so a pass proves those alone keep it at WCAG AA.
 */
async function contrastFailures(page: Page): Promise<string[]> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        background-image: none !important;
        animation: none !important;
        transition: none !important;
      }
      *::before, *::after { display: none !important; }
    `,
  });
  const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${node.target.join(" ")}: ${node.failureSummary ?? ""}`),
  );
}

// On the fixture board, so every status colour, badge, incident time and
// the Stale state are on screen, whatever the vendors say during the run.
// Quiet is the default; Glass makes the panels translucent, so its flat fills are the ones under test too.
for (const background of ["quiet", "glass"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const contrast of ["no-preference", "more"] as const) {
      const name = `${colorScheme}${contrast === "more" ? ", Increase Contrast" : ""}${background === "glass" ? ", Glass" : ""}`;
      test(`keeps every text colour at AA on the flat fills alone (${name})`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem("status-bar:background", value), background);
        await page.clock.install();
        const board = fixtureBoard(Date.now());
        await serveBoard(page, () => board);
        await page.emulateMedia({ colorScheme, contrast, reducedMotion: "reduce" });
        await page.goto("/");
        await expect(cards(page)).toHaveCount(SERVICES);
        await hydrated(page);
        await page.getByRole("button", { name: "Refresh status now" }).first().click();
        for (const label of ["Outage", "Degraded", "Maintenance", "No data", "Operational"]) {
          await expect(page.locator("main [data-card-header]").getByText(label, { exact: true }).first()).toBeVisible();
        }
        // Shortly after midnight UTC the fixture's incidents began the day
        // before, and the card adds their date: "since 27 Sep 21:52 UTC".
        await expect(page.getByText(/^since (\d{1,2} [A-Z][a-z]{2} (\d{4} )?)?\d\d:\d\d\sUTC/).first()).toBeVisible();
        expect(await contrastFailures(page)).toEqual([]);

        // Seven minutes on, the same snapshot again: the board says Stale.
        await page.clock.fastForward("07:00");
        await expect(page.getByText("Stale", { exact: true })).toBeVisible();
        expect(await contrastFailures(page)).toEqual([]);

        // And the settings dialog, with the single-key shortcuts dimmed.
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("switch", { name: "Single-key shortcuts" }).click();
        expect(await contrastFailures(page)).toEqual([]);
      });
    }
  }
}

test("renders cards without requesting persistent uptime history", async ({ page }) => {
  test.skip(process.env.VITE_STATUS_HISTORY === "1", "a history build requests it");
  let historyRequests = 0;
  await page.route("**/api/history.json", async (route) => {
    historyRequests += 1;
    await route.abort();
  });

  const problems = watchConsole(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // The request would come from a query that starts only once React has hydrated.
  await hydrated(page);
  await page.waitForLoadState("networkidle");
  expect(historyRequests).toBe(0);
  await expect(page.getByRole("img", { name: /uptime history/i })).toHaveCount(0);
  expect(problems).toEqual([]);
});

// The board asks for history only in a build made with VITE_STATUS_HISTORY=1
// (nothing collects any today). These run only when the runner is given
// the same VITE_STATUS_HISTORY=1 it built with, and are skipped otherwise;
// the default build is covered by the test above, which a history build skips.
// CI's history job builds with the flag and runs them by their @history tag.
test("shows an uptime strip on a service once /api/history.json has days", { tag: "@history" }, async ({ page }) => {
  test.skip(process.env.VITE_STATUS_HISTORY !== "1", "needs a build with VITE_STATUS_HISTORY=1");
  const today = new Date();
  const days = Array.from({ length: 10 }, (_, index) => {
    const stamp = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (9 - index)));
    return {
      date: stamp.toISOString().slice(0, 10),
      worst: index === 5 ? "degraded" : "operational",
      samples: 2,
      up: 1,
    };
  });
  await page.route("**/api/history.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schema: 1,
        updatedAt: today.toISOString(),
        timezone: "UTC",
        retentionDays: 30,
        services: { aws: { days } },
      }),
    }),
  );

  const problems = watchConsole(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await expect(page.locator("#service-aws").getByRole("img", { name: /uptime history/i })).toBeVisible();
  // Only the service the document lists gets one.
  await expect(page.getByRole("img", { name: /uptime history/i })).toHaveCount(1);
  expect(problems).toEqual([]);
});

/** A /api/history.json with ten quiet days for each of these services. */
function historyFor(ids: string[]) {
  const today = new Date();
  const days = Array.from({ length: 10 }, (_, index) => ({
    date: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (9 - index)))
      .toISOString()
      .slice(0, 10),
    worst: "operational",
    samples: 2,
    up: 1,
  }));
  return {
    schema: 1,
    updatedAt: today.toISOString(),
    timezone: "UTC",
    retentionDays: 30,
    services: Object.fromEntries(ids.map((id) => [id, { days }])),
  };
}

test("draws the strip on an attention card and on a list row", { tag: "@history" }, async ({ page }) => {
  test.skip(process.env.VITE_STATUS_HISTORY !== "1", "needs a build with VITE_STATUS_HISTORY=1");
  // In the fixture AWS is in outage (an attention card) and every service without a problem is a row.
  const body = JSON.stringify(historyFor(["aws", "chatgpt"]));
  await page.route("**/api/history.json", (route) => route.fulfill({ contentType: "application/json", body }));
  await openFixture(page, () => fixtureBoard(Date.now()));
  const card = page.locator("#service-aws");
  await expect(card.getByText("Outage", { exact: true }).first()).toBeVisible();
  await expect(card.getByRole("img", { name: /uptime history/i })).toBeVisible();
  const row = page.locator("#service-chatgpt");
  await expect(row.getByText("Outage", { exact: true })).toHaveCount(0);
  await expect(row.getByRole("img", { name: /uptime history/i })).toBeVisible();
  await expect(page.getByRole("img", { name: /uptime history/i })).toHaveCount(2);
});

test("keeps an open row open, and its summary focused, when the history arrives", { tag: "@history" }, async ({
  page,
}) => {
  test.skip(process.env.VITE_STATUS_HISTORY !== "1", "needs a build with VITE_STATUS_HISTORY=1");
  // Held back, so the board is up with no days and the strip mounts while the row is being used.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let body = "";
  await page.route("**/api/history.json", async (route) => {
    await held;
    await route.fulfill({ contentType: "application/json", body });
  });
  await openFixture(page, () => fixtureBoard(Date.now()));
  // A row that opens (it lists components), whichever one the fixture makes first.
  const row = page.locator("article.row:has(details)").first();
  const id = (await row.getAttribute("id"))?.replace(/^service-/, "") ?? "";
  expect(id, "the fixture has a row that opens").not.toBe("");
  body = JSON.stringify(historyFor([id]));

  const summary = row.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  const details = row.locator("details");
  await expect(details).toHaveJSProperty("open", true);
  await expect(summary).toBeFocused();
  await expect(row.getByRole("img", { name: /uptime history/i })).toHaveCount(0);

  release();
  await expect(row.getByRole("img", { name: /uptime history/i })).toBeVisible();
  // The same <details>, not a new one: it is still open and the focus is still in it.
  await expect(details).toHaveJSProperty("open", true);
  await expect(summary).toBeFocused();
});

test("renders cards without a strip when /api/history.json is the empty document", { tag: "@history" }, async ({
  page,
}) => {
  test.skip(process.env.VITE_STATUS_HISTORY !== "1", "needs a build with VITE_STATUS_HISTORY=1");
  let historyRequests = 0;
  await page.route("**/api/history.json", (route) => {
    historyRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schema: 1,
        updatedAt: new Date().toISOString(),
        timezone: "UTC",
        retentionDays: 30,
        services: {},
      }),
    });
  });

  const problems = watchConsole(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // The history query starts only once React has hydrated, and networkidle can
  // resolve before that on a slow runner: wait for the request itself.
  await hydrated(page);
  await expect.poll(() => historyRequests).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("img", { name: /uptime history/i })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("keeps a long component name whole beside its badge on a narrow card", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "the narrow-card layout is what a phone shows");
  const board = fixtureBoard(Date.now());
  const name = board.services.find((service) => service.id === "aws")?.components[0]?.name;
  expect(name).toBe("Amazon Elastic Compute Cloud");

  await openFixture(page, () => board);
  const label = page.locator("#service-aws [data-component-row]").first().locator("span").first();
  await expect(label).toHaveText(name ?? "");
  // The name wraps onto more lines instead of being cut off with an ellipsis.
  const { overflows, ellipsis } = await label.evaluate((element) => ({
    overflows: element.scrollWidth > element.clientWidth + 1,
    ellipsis: getComputedStyle(element).textOverflow === "ellipsis",
  }));
  expect(overflows).toBe(false);
  expect(ellipsis).toBe(false);
});

test("footer links the source on GitHub and states the MIT License", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  const source = footer.getByRole("link", { name: "Source on GitHub" });
  await expect(source).toHaveAttribute("href", "https://github.com/greenblacked/status-page");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", /noopener/);
  await expect(footer.getByRole("link", { name: "MIT License" })).toHaveAttribute(
    "href",
    "https://github.com/greenblacked/status-page/blob/main/LICENSE",
  );
  await expect(footer).toContainText("Not affiliated with any of these vendors");
  await expect(footer).toContainText("Made and kept by Serhii.");
  await expect(footer).not.toContainText("every two minutes");
  await expect(footer.getByRole("link", { name: "JSON" })).toHaveAttribute("href", "/api/status.json");
  await expect(footer.getByRole("link", { name: "Atom feed" })).toHaveAttribute("href", "/feed.xml");
  await expect(footer.getByRole("link", { name: "Badges" })).toHaveAttribute("href", "/api/badge/board");
});

test("puts the footer in a contentinfo landmark outside main, and names the recent changes", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // The role only exists for a footer that is not inside main, an article or a section.
  const footer = page.getByRole("contentinfo");
  await expect(footer).toHaveCount(1);
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("Not affiliated with any of these vendors");
  await expect(page.locator("main footer, main dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Recent changes" })).toHaveCount(1);
  await hydrated(page);
  // The dialog still opens from the footer's button.
  await footer.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("puts Recent changes right after Needs a look and before the first category", async ({ page }) => {
  await openFixture(page, () => fixtureBoard(Date.now()));
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(page.getByRole("region", { name: /^Needs a look/ })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Recent changes" })).toHaveCount(1);
  // The board's sections as they sit in the page, by the heading each one is named by.
  const headings = await page
    .locator("main section[aria-labelledby]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-labelledby")));
  expect(headings.slice(0, 2)).toEqual(["attention-heading", "recent-heading"]);
  // Every other section, Couldn't read and the categories included, follows the feed.
  const rest = headings.slice(2);
  expect(rest.some((id) => id?.startsWith("up-"))).toBe(true);
  expect(rest).not.toContain("recent-heading");
  expect(rest).not.toContain("attention-heading");
});

test("puts Recent changes first when nothing needs a look", async ({ page }) => {
  await openFixture(page, () => fixtureBoard(Date.now()));
  await expect(cards(page)).toHaveCount(SERVICES);
  // Steam is operational, so the search leaves no Needs a look section.
  await page.getByRole("searchbox").first().fill("steam");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.locator('[data-group="attention"]')).toHaveCount(0);
  const headings = await page
    .locator("main section[aria-labelledby]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-labelledby")));
  expect(headings[0]).toBe("recent-heading");
  expect(headings).toHaveLength(2);
});

test("keeps one Recent changes region, in place, through an empty search", async ({ page }) => {
  await openFixture(page, () => fixtureBoard(Date.now()));
  await expect(cards(page)).toHaveCount(SERVICES);
  const recent = page.getByRole("region", { name: "Recent changes" });
  await expect(recent).toHaveCount(1);
  // A JS property survives only on the same DOM node, so a remount would drop it.
  await recent.evaluate((node) => {
    (node as HTMLElement & { __kept?: boolean }).__kept = true;
  });
  const search = page.getByRole("searchbox").first();
  await search.fill("zzzz-no-such-service");
  await expect(cards(page)).toHaveCount(0);
  await expect(recent).toHaveCount(1);
  // After the empty message, with the same gap as between the sections.
  const order = await page.evaluate(() => {
    // The empty message is the one panel in the board that is in no section.
    const message = [...document.querySelectorAll("main p.surface")].find((node) => !node.closest("section"));
    const feed = document.querySelector('section[aria-labelledby="recent-heading"]');
    if (!message || !feed) return null;
    return {
      after: Boolean(message.compareDocumentPosition(feed) & Node.DOCUMENT_POSITION_FOLLOWING),
      gap: Math.round(feed.getBoundingClientRect().top - message.getBoundingClientRect().bottom),
      rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });
  expect(order).not.toBeNull();
  expect(order?.after).toBe(true);
  expect(order?.gap).toBe(2 * (order?.rem ?? 16));
  await search.fill("");
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(recent).toHaveCount(1);
  expect(await recent.evaluate((node) => (node as HTMLElement & { __kept?: boolean }).__kept)).toBe(true);
});

/**
 * The saved checks of a returning visitor, as local storage holds them: eight
 * checks from the last sixteen minutes, with the board the last one saw. They
 * are as long as real ones get on a phone, where each caption wraps to several
 * lines: changes to several services at once, summaries a sentence long, and
 * a run of quiet checks that is one row. The load adds a quiet ninth in place
 * of the oldest. The board is the one the page itself saved on a first visit,
 * so the check the load makes finds nothing changed, as it does for a real
 * visitor.
 */
async function savedChecks(page: Page): Promise<{ key: string; store: string }> {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PULSE_STORAGE_KEY)).not.toBeNull();
  const first = JSON.parse((await page.evaluate((key) => localStorage.getItem(key), PULSE_STORAGE_KEY)) ?? "null") as {
    lastBoard: BoardSnapshot | null;
  };
  expect(first.lastBoard, "the page saved the board it showed").not.toBeNull();
  const slot = Math.floor(Date.now() / 120_000) * 120_000;
  const counts = { operational: 10, degraded: 3, outage: 1, maintenance: 0, unknown: 0 };
  const aws = "Increased error rates and latency for API requests in US-EAST-1 affecting several services";
  const routerOs = "Elevated connection failures for some users; engineers are investigating a network issue";
  const change = (id: string, name: string, to: string, summary: string, from = "operational") => ({
    id,
    name,
    from,
    to,
    summary,
  });
  const checks = [
    [
      change("gcp", "Google Cloud", "degraded", "Degraded performance"),
      change("aws", "Amazon Web Services", "outage", aws),
      change("android", "Android / Play", "degraded", routerOs),
    ],
    [change("aws", "Amazon Web Services", "degraded", aws)],
    [change("mikrotik", "MikroTik RouterOS", "outage", routerOs)],
    [
      change("gcp", "Google Cloud", "operational", "", "degraded"),
      change("aws", "Amazon Web Services", "operational", "", "outage"),
      change("cs2-europe", "CS2 Europe", "maintenance", "Planned maintenance"),
      change("epic", "Epic Games", "degraded", "Slow logins"),
      change("apple", "Apple", "degraded", "Some services are slow"),
    ],
    [],
    [],
    [change("android", "Android / Play", "outage", aws)],
    [change("chatgpt", "ChatGPT", "degraded", aws), change("mikrotik", "MikroTik RouterOS", "degraded", routerOs)],
  ];
  const pulses = checks.map((changes, index) => ({
    slot: slot - (index + 1) * 120_000,
    at: new Date(slot - (index + 1) * 120_000).toISOString(),
    overall: "degraded",
    counts,
    changes,
    opening: false,
  }));
  return {
    key: PULSE_STORAGE_KEY,
    store: JSON.stringify({ lastSlot: slot - 120_000, lastBoard: first.lastBoard, pulses }),
  };
}

const feedSurface = (page: Page) => page.locator('section[aria-labelledby="recent-heading"] .surface');
const feedRows = (page: Page) => page.locator('section[aria-labelledby="recent-heading"] li');

test("shifts nothing much when saved checks fill Recent changes after hydration", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "layout-shift entries are a Chromium API");
  const saved = await savedChecks(page);
  await page.addInitScript((saved) => {
    localStorage.setItem(saved.key, saved.store);
    const tracked = window as Window & { __cls?: number };
    tracked.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) tracked.__cls = (tracked.__cls ?? 0) + entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  }, saved);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  // The load's own check, then the saved ones with the quiet run as one row.
  await expect(feedRows(page)).toHaveCount(7);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.waitForTimeout(500);
  const shift = await page.evaluate(() => (window as Window & { __cls?: number }).__cls ?? 0);
  expect(shift, "cumulative layout shift").toBeLessThan(0.02);
});

// The reserve is measured from the markup the page draws, so it holds at any
// width and any default font size. 21px is a line of the body text: the one
// thing a wrap that differs by a line (a web font swapped in) moves.
const TOLERANCE_PX = 21;

for (const fontPx of [16, 20]) {
  test(`holds the height of Recent changes for the saved checks, on a phone and a desktop, at a ${fontPx}px default font`, async ({
    page,
    browserName,
  }) => {
    test.skip(
      fontPx !== 16 && browserName !== "chromium",
      "the default font size is set over Chromium's DevTools protocol",
    );
    const saved = await savedChecks(page);
    await page.addInitScript((saved) => localStorage.setItem(saved.key, saved.store), saved);
    if (fontPx !== 16) {
      const session = await page.context().newCDPSession(page);
      await session.send("Page.setFontSizes", { fontSizes: { standard: fontPx } });
    }
    const surface = feedSurface(page);
    const results: string[] = [];
    for (const width of [320, 375, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      // Hold the page's scripts back, so the server's markup (the feed empty)
      // is what paints, and let them go to read the feed once it is drawn.
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/*", async (route) => {
        if (route.request().resourceType() === "script") await gate;
        await route.continue();
      });
      await page.goto("/", { waitUntil: "commit" });
      await expect(surface).toBeVisible();
      await expect(feedRows(page)).toHaveCount(0);
      // The page's own script has measured by the time the surface has its
      // property; the browser then starts on the web font, and the script
      // measures again when it is in. Wait for that: a visitor settles on the
      // paint after it before the page hydrates.
      await page.waitForFunction(
        () =>
          document
            .querySelector<HTMLElement>('section[aria-labelledby="recent-heading"] .surface')
            ?.style.getPropertyValue("--feed-reserve") !== "",
      );
      await page.evaluate(async () => {
        await document.fonts.load("400 15px Inter").catch(() => []);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      const root = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect(root, "the default font size").toBe(fontPx);
      const before = (await surface.boundingBox())?.height ?? 0;
      release();
      await hydrated(page);
      // The load's own check, then the saved ones with the quiet run as one row.
      await expect(feedRows(page)).toHaveCount(7);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const after = (await surface.boundingBox())?.height ?? 0;
      results.push(`${width}px: reserved ${before}px, drawn ${after}px`);
      // What the board below moves by, growing or shrinking.
      expect(before, `${width}px reserves more than the empty card`).toBeGreaterThan(100);
      expect(Math.abs(before - after), results.at(-1)).toBeLessThanOrEqual(TOLERANCE_PX);
      await page.unroute("**/*");
    }
  });
}

test("drops the Operational placeholder from release cards and names a fresh release", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  // The fixture has a fresh channel on both cards; make Apple OS's plain, as
  // it reads on a normal day, and keep MikroTik's fresh Stable channel.
  const appleOs = board.services.find((service) => service.id === "apple-os");
  if (!appleOs) throw new Error("the fixture has no apple-os");
  appleOs.components = appleOs.components.map((component) => ({ ...component, health: "operational" }));
  await openFixture(page, () => board);

  const mikrotik = page.locator("article#service-mikrotik");
  await expect(mikrotik.locator("[data-card-header]").getByText("New release", { exact: true })).toBeVisible();
  await expect(mikrotik.locator("[data-card-header]").getByText("Operational")).toHaveCount(0);
  await expect(mikrotik.getByRole("button", { name: /^Star / })).toBeVisible();

  const apple = page.locator("article#service-apple-os");
  await expect(apple.getByRole("heading", { level: 3 })).toBeVisible();
  await expect(apple.locator("[data-card-header]").getByText("Operational")).toHaveCount(0);
  await expect(apple.locator("[data-card-header]").getByText("New release")).toHaveCount(0);
  await expect(apple.getByRole("button", { name: /^Star / })).toBeVisible();
});

test("gives every control on the page a 44pt target on a touch screen", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  test.skip(!coarse, "the touch sizes are for a coarse pointer, which this project does not have");
  // The fixture board has services that need attention, so its cards and their links are on screen.
  await openFixture(page, () => fixtureBoard(Date.now()));
  const small = await page.evaluate(() => {
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        ["header button", 'section[aria-label="Filter services"] button', "footer a", "footer button"].join(","),
      ),
    ];
    return {
      count: targets.length,
      small: targets
        .map((element) => ({
          name: element.textContent?.trim() || element.ariaLabel,
          box: element.getBoundingClientRect(),
        }))
        .filter(({ box }) => box.height > 0 && (box.height < 43.5 || box.width < 43.5))
        .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`),
    };
  });
  // Not vacuous: two hero buttons (one on an iPhone), the segments and toggles, and the footer's links.
  expect(small.count).toBeGreaterThan(12);
  expect(small.small).toEqual([]);

  // The links in the verdict's sub line sit in running text, so their reach is padding round them (hit-extend)
  // on lines 46pt apart (hit-lines, a hair over the 44pt box so a neighbour's edge never takes the tap), not the
  // words' own box: a tap 21px above or below the middle of the words still lands on the link. (The next test
  // has the sentence wrap, and checks that no two of them overlap.)
  const sentence = await page.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>("header h1 + p a")];
    const boxes = links.map((link) => {
      link.scrollIntoView({ block: "center" });
      const box = link.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      return {
        name: link.textContent?.trim() ?? "",
        x: x + window.scrollX,
        y: y + window.scrollY,
        reaches: [-21.5, 21.5].map((dy) => document.elementFromPoint(x, y + dy) === link),
        // What answers above and below, for the failure message: the link that took the tap, or what else.
        seen: [-21.5, 21.5].map((dy) => {
          const hit = document.elementFromPoint(x, y + dy);
          return hit === link
            ? "itself"
            : (hit?.closest("a")?.textContent?.trim() ?? hit?.tagName.toLowerCase() ?? "nothing");
        }),
      };
    });
    return boxes;
  });
  expect(sentence.length, "the sub line names services").toBeGreaterThan(1);
  for (const link of sentence)
    expect(link.reaches, `${link.name} reaches 44px tall (above and below it saw ${link.seen})`).toEqual([true, true]);
  // Neighbours on one line are well apart (WCAG 2.5.8: 24px between centres).
  for (const [index, link] of sentence.entries()) {
    const next = sentence[index + 1];
    if (next && Math.abs(next.y - link.y) < 4)
      expect(next.x - link.x, `${link.name} to ${next.name}`).toBeGreaterThan(24);
  }
});

test("keeps the tap areas of the verdict's links apart when the sentence wraps", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  test.skip(!coarse, "the tap areas are for a coarse pointer, which this project does not have");
  // Three services need a look, and their names are long, so the sentence wraps at every width below: some of
  // the links land on the line under another, and "Google Cloud Platform" is a link that wraps itself.
  const longNames: Partial<Record<string, string>> = {
    aws: "Amazon Web Services",
    gcp: "Google Cloud Platform",
    grok: "Grok from xAI",
  };
  const board = fixtureBoard(Date.now(), { grok: "outage" });
  await openFixture(page, () => ({
    ...board,
    services: board.services.map((service) => ({ ...service, shortName: longNames[service.id] ?? service.shortName })),
  }));

  let wrapped = false;
  for (const { width, rootPx } of [
    { width: 320, rootPx: 16 },
    { width: 390, rootPx: 16 },
    { width: 390, rootPx: 24 },
    { width: 390, rootPx: 32 },
  ]) {
    const at = `at ${width}px, ${rootPx}px text`;
    // Tall, so the whole sentence is on screen at 200% text: elementFromPoint only answers for what is.
    await page.setViewportSize({ width, height: 2400 });
    await page.evaluate((px) => {
      document.documentElement.style.fontSize = `${px}px`;
    }, rootPx);
    const links = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll<HTMLAnchorElement>("header h1 + p a")];
      anchors[0]?.scrollIntoView({ block: "center" });
      return anchors.map((link, index) => {
        // The words' own boxes, one per line the link is on: Range rects have no padding in them.
        const range = document.createRange();
        range.selectNodeContents(link);
        const fragments = [...range.getClientRects()].filter((box) => box.width > 1);
        const resolve = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y)?.closest("a");
          return hit ? anchors.indexOf(hit) : -1;
        };
        return {
          name: link.textContent?.trim() ?? "",
          fragments: fragments.map((box) => {
            const x = box.left + box.width / 2;
            return {
              top: box.top,
              bottom: box.bottom,
              // Just inside the words, and a little way past them: both are the link's own.
              inside: [box.top + 1.5, box.bottom - 1.5].map((y) => resolve(x, y) === index),
              beyond: [box.top - 8, box.bottom + 8].map((y) => resolve(x, y) === index),
              // What answers 1.5px from either edge, for the failure message.
              seen: [box.top + 1.5, box.bottom - 1.5, box.top - 8, box.bottom + 8].map((y) => resolve(x, y)),
            };
          }),
        };
      });
    });
    expect(links.length, `${at}: the sub line names services`).toBeGreaterThan(1);
    // Not vacuous: the sentence wraps, so some link sits on a line under another, and one link is on two lines.
    const rows = new Set(links.flatMap((link) => link.fragments.map((fragment) => Math.round(fragment.top / 4))));
    expect(rows.size, `${at}: the sentence is on more than one line`).toBeGreaterThan(1);
    wrapped ||= links.some((link) => link.fragments.length > 1);
    for (const link of links) {
      expect(link.fragments.length, `${at}: ${link.name} has a box`).toBeGreaterThan(0);
      for (const fragment of link.fragments) {
        expect(fragment.inside, `${at}: a tap on the words of ${link.name} (saw links ${fragment.seen})`).toEqual([
          true,
          true,
        ]);
        expect(fragment.beyond, `${at}: a tap just above and below ${link.name} (saw links ${fragment.seen})`).toEqual([
          true,
          true,
        ]);
      }
    }
  }
  expect(wrapped, "a link wraps onto a second line at some width").toBe(true);
});

test("lays the hero out at 200% root text on a phone: no overflow, no overlap", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "html { font-size: 32px !important; }";
      document.head.appendChild(style);
    });
  });
  const board = fixtureBoard(Date.now());
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await openFixture(page, () => board);
    const layout = await page.evaluate(() => {
      const box = (element: Element | undefined | null, name: string) => {
        const rect = element?.getBoundingClientRect();
        if (!rect) throw new Error(`no ${name}`);
        return { name, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
      };
      const buttons = [...document.querySelectorAll("header button")].map((button, at) => box(button, `button ${at}`));
      return {
        rootPx: getComputedStyle(document.documentElement).fontSize,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        viewport: window.innerWidth,
        dateline: box(document.querySelector("header time"), "dateline"),
        headline: box(document.querySelector("h1#board-headline"), "headline"),
        sub: box(document.querySelector("header h1 + p"), "sub"),
        live: box(document.querySelector('[data-testid="live-bar"]'), "live line"),
        buttons,
      };
    });
    const at = `at ${width}px`;
    expect(layout.rootPx).toBe("32px");
    expect(layout.overflow, `horizontal overflow ${at}`).toBeLessThanOrEqual(0);
    // Everything stays inside the screen, and the headline and its sub line keep a readable measure.
    for (const part of [layout.dateline, layout.headline, layout.sub, layout.live, ...layout.buttons]) {
      expect(part.right, `${part.name} inside the screen ${at}`).toBeLessThanOrEqual(layout.viewport + 0.5);
      expect(part.left, `${part.name} inside the screen ${at}`).toBeGreaterThanOrEqual(-0.5);
    }
    expect(layout.headline.width, `headline ${at}`).toBeGreaterThan(200);
    // Nothing sits over anything else: the dateline, the two buttons, the headline, the sub line and the live line.
    const parts = [layout.dateline, ...layout.buttons, layout.headline, layout.sub, layout.live];
    for (const [i, a] of parts.entries()) {
      for (const b of parts.slice(i + 1)) {
        const apart =
          a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
        expect(apart, `${a.name} and ${b.name} overlap ${at}`).toBe(true);
      }
    }
  }
});

// Nothing loops on a Quiet board: with the check done, no animation is left running, whatever the motion setting.
for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`keeps nothing moving on a settled board (${reducedMotion === "reduce" ? "Reduce Motion" : "motion allowed"})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await openFixture(page, () => fixtureBoard(Date.now()));
    await expect(page.getByTestId("live-bar")).toContainText("Checked");
    const looping = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY)
        .map((animation) => (animation as CSSAnimation).animationName || animation.id),
    );
    expect(looping).toEqual([]);
  });
}

test("keeps the live bar the same height while checking and live at phone widths", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  const board = fixtureBoard(Date.now());
  await page.setViewportSize({ width: 390, height: 800 });
  await openFixture(page, () => board);
  const bar = page.getByTestId("live-bar");
  const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
  // A later route wins: it holds the forced refresh back, then hands it on to the fixture's route.
  let release: () => void = () => undefined;
  let held: Promise<void> = Promise.resolve();
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.fallback();
  });
  try {
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(bar).toContainText("Live");
      const live = (await bar.boundingBox())?.height ?? 0;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await refresh.click();
      await expect(bar).toContainText("Checking");
      const checking = (await bar.boundingBox())?.height ?? 0;
      release();
      await expect(refresh).toHaveAttribute("aria-busy", "false");
      expect(checking, `checking against live at ${width}px`).toBe(live);
      expect(live, `a measured bar at ${width}px`).toBeGreaterThan(0);
    }
  } finally {
    release();
  }
});

test("reads the board as one sentence in the h1, with the count underlined by hand and the services linked", async ({
  page,
}) => {
  await openFixture(page, () => fixtureBoard(Date.now()));
  const headline = page.getByRole("heading", { level: 1 });
  await expect(headline).toHaveText("Three things need a look.");
  await expect(headline).toHaveAttribute("id", "board-headline");
  // One pen stroke, under the count only, drawn from constants (aria-hidden, no text of its own).
  await expect(headline.locator("svg.pen-underline")).toHaveCount(1);
  await expect(headline.locator("svg.pen-underline")).toHaveAttribute("aria-hidden", "true");
  // The sentence under it names the services and links each to its card.
  const sub = page.locator("h1 + p");
  await expect(sub).toContainText("The other ten are running normally.");
  await expect(sub).toContainText("I couldn't read Android.");
  const links = sub.getByRole("link");
  await expect(links).toHaveText(["AWS", "GCP", "Epic", "Android"]);
  await expect(links.first()).toHaveAttribute("href", "#service-aws");
  // Nothing hand-written while there is something to look at.
  await expect(page.getByText("all quiet")).toHaveCount(0);
  await expect(page.locator("#service-aws svg.pen-loop")).toHaveCount(1);
});

test("writes all quiet by hand, and says so in words, when all fourteen are up", async ({ page }) => {
  await openFixture(page, () => calmBoard(Date.now()), { id: "aws", label: "Operational" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Everything is up.");
  await expect(page.locator("h1 svg.pen-underline")).toHaveCount(0);
  const note = page.getByText("all quiet", { exact: true });
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("aria-hidden", "true");
  expect(await note.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Hand");
  await expect(page.getByText("All fourteen services are running normally.")).toHaveClass(/sr-only/);
  // Nothing needs a look, so the tab title is the plain name and no card sits in that group.
  await expect(page).toHaveTitle("Status");
  await expect(group(page, "attention")).toHaveCount(0);
  await expect(page.locator("[data-highlight]")).toHaveCount(0);
});

test("keeps Alerts and Refresh as icon buttons with a name and a tooltip", async ({ page }) => {
  // Not yet asked: headless Chromium (CI's) reports notifications as denied unless told otherwise, which would
  // make the button the blocked one with another tooltip. Set before the page's scripts read it.
  await page.addInitScript(() => {
    if ("Notification" in window) Object.defineProperty(Notification, "permission", { get: () => "default" });
  });
  await page.goto("/");
  await hydrated(page);
  const refresh = page.locator("header").getByRole("button", { name: "Refresh status now" });
  await expect(refresh).toHaveAttribute("title", "Refresh status now");
  await expect(refresh).toHaveText("");
  const box = await refresh.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(43.5);
  expect(box?.height).toBeGreaterThanOrEqual(43.5);
  const alerts = page.locator("header").getByRole("button", { name: "Notifications" });
  // Where the browser can send them (an iPhone cannot, and has no button at all).
  if (await alerts.count()) {
    await expect(alerts).toHaveText("");
    await expect(alerts).toHaveAttribute("title", "Notify me when a service changes");
    await expect(alerts).toHaveAttribute("aria-pressed", "false");
  }
});

test("shows Alerts as blocked, with the reason, and does nothing when pressed, where notifications are denied", async ({
  page,
}) => {
  // The browser's answer is no, and any request would be seen: nothing should ask.
  await page.addInitScript(() => {
    if (!("Notification" in window)) return;
    Object.defineProperty(Notification, "permission", { get: () => "denied" });
    const asked: string[] = [];
    Object.defineProperty(window, "__permissionRequests", { value: asked });
    Notification.requestPermission = () => {
      asked.push("requestPermission");
      return Promise.resolve("denied");
    };
  });
  await page.goto("/");
  await hydrated(page);
  const alerts = page.locator("header").getByRole("button", { name: "Notifications" });
  test.skip((await alerts.count()) === 0, "this browser has no Alerts button (an iPhone cannot send them)");
  await expect(alerts).toHaveAttribute(
    "title",
    "Notifications are blocked for this site. Allow them in browser settings.",
  );
  await expect(alerts).toHaveAttribute("aria-disabled", "true");
  await expect(alerts).toHaveAttribute("aria-pressed", "false");
  // Still reachable by a screen reader, and it says why.
  const hint = await alerts.getAttribute("aria-describedby");
  expect(hint, "the button points at its reason").toBeTruthy();
  await expect(page.locator(`[id="${hint}"]`)).toHaveText("Blocked in this browser's site settings");

  // Pressing it does nothing: Playwright will not click an aria-disabled button unless forced.
  await alerts.click({ force: true });
  await expect(alerts).toHaveAttribute("aria-pressed", "false");
  await expect(alerts).toHaveAttribute("aria-disabled", "true");
  await expect(alerts).toHaveAttribute(
    "title",
    "Notifications are blocked for this site. Allow them in browser settings.",
  );
  expect(
    await page.evaluate(() => (window as unknown as { __permissionRequests: string[] }).__permissionRequests),
  ).toEqual([]);
});

test("opens the countdown line with a capital in the margin, and keeps it lowercase after the dot on a phone", async ({
  page,
}) => {
  await page.goto("/");
  await hydrated(page);
  const next = page
    .getByTestId("live-bar")
    .locator("span", { hasText: /^next in/ })
    .first();
  await expect(next).toBeAttached();
  const md = await page.evaluate(() => matchMedia("(min-width: 48rem)").matches);
  const { display, transform } = await next.evaluate((element) => ({
    display: getComputedStyle(element).display,
    transform: getComputedStyle(element, "::first-letter").textTransform,
  }));
  // The countdown is a line of its own only from md up, and only then does it begin a line.
  expect(display === "block").toBe(md);
  expect(transform).toBe(md ? "uppercase" : "none");
});

test("shows the period dial only on the Full background, and the live line's words on every one", async ({ page }) => {
  await page.goto("/");
  await hydrated(page);
  await expect(page.locator(".period-dial")).toHaveCount(0);
  const live = page.getByTestId("live-bar");
  await expect(live).toContainText(/Checked \d\d:\d\d\sUTC/);
  await expect(live).toContainText(/next in \d:\d\d/);
  await page.evaluate(() => localStorage.setItem("status-bar:background", "full"));
  await page.reload();
  await hydrated(page);
  await expect(page.locator("html")).toHaveAttribute("data-background", "full");
  const dial = page.locator(".period-dial");
  await expect(dial).toHaveCount(1);
  expect((await dial.boundingBox())?.width).toBe(24);
  await expect(live).toContainText(/Checked \d\d:\d\d\sUTC/);
});

test("puts the floating bar's verdict, check time and countdown beside the docked field", async ({ page }) => {
  await openFixture(page, () => fixtureBoard(Date.now()));
  const bar = controlBar(page);
  await page.locator("footer").scrollIntoViewIfNeeded();
  await expect(bar).toHaveAttribute("data-shown", "true");
  const lead = bar.locator("p[data-bar-lead]");
  await expect(lead).toContainText("3 need a look");
  await expect(lead).toContainText(/Checked \d\d:\d\d\sUTC · next in \d:\d\d/);
  // The bar is a float: the one translucent element on a Quiet page.
  await expect(bar).toHaveClass(/\bfloat\b/);
});

test("shifts nothing much when the self-hosted Inter arrives late", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the fallback faces are what Chromium draws on Android, Windows and Linux");
  // Hold the font back so the page is drawn in its fallback first, and count every layout shift that follows.
  await page.route("**/fonts/inter-var.woff2", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.addInitScript(() => {
    const tracked = window as Window & { __cls?: number };
    tracked.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) tracked.__cls = (tracked.__cls ?? 0) + entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  // Whether this machine has any font the fallback faces name (the local() names in styles.css).
  const fallbackFound = await page.evaluate(async () => {
    // A face whose local() names match no installed font fails to load and matches nothing.
    const loaded = await Promise.all(
      ['"Inter Fallback"', '"Inter Fallback Roboto"'].map((family) =>
        document.fonts.load(`16px ${family}`).catch(() => [] as FontFace[]),
      ),
    );
    return loaded.some((faces) => faces.length > 0);
  });
  test.skip(
    !fallbackFound,
    'this machine has none of the fonts the fallback faces look for, so there is no fallback to resize: local() "Arial", "ArialMT", "Liberation Sans", "LiberationSans", "Arimo" (Inter Fallback) and "Roboto", "Roboto Regular", "Roboto-Regular" (Inter Fallback Roboto)',
  );
  // The first paint was in the fallback; the swap has happened once Inter reports loaded.
  await page.waitForFunction(
    () => [...document.fonts].some((face) => face.family.replaceAll('"', "") === "Inter" && face.status === "loaded"),
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.waitForTimeout(500);
  const shift = await page.evaluate(() => (window as Window & { __cls?: number }).__cls ?? 0);
  expect(shift, "cumulative layout shift").toBeLessThan(0.1);
});

/** The fixture board with twelve services degraded, so the Issues count has two digits. */
function busyBoard(): BoardSnapshot {
  const board = fixtureBoard(Date.now());
  const services = board.services.map((service, index) =>
    index < 12 && service.health === "operational"
      ? { ...service, health: "degraded" as const, summary: "Slower than usual", incidents: [] }
      : service,
  );
  const counts = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const service of services) counts[service.health] += 1;
  return { ...board, services, counts };
}

for (const width of [1024, 1440]) {
  test(`keeps the filter row on one line, and the board still, when a star is added at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page, busyBoard);
    const row = async () =>
      page.evaluate(() => {
        const segments = document.querySelector('[role="group"][aria-label="Category"]') as HTMLElement;
        const toggles = segments.nextElementSibling as HTMLElement;
        const field = document.querySelector(".search-field") as HTMLElement;
        const box = (element: Element) => element.getBoundingClientRect();
        return {
          segmentsBottom: box(segments).bottom,
          togglesTop: box(toggles).top,
          togglesRight: box(toggles).right,
          sectionRight: box(segments.parentElement as Element).right,
          mainTop: box(document.querySelector("main#services") as Element).top,
          fieldMid: box(field).top + box(field).height / 2,
          rowMid: (box(segments).top + box(segments).bottom) / 2,
          togglesText: toggles.textContent ?? "",
        };
      });
    const bare = await row();
    // Not vacuous: two digits on Issues only.
    expect(bare.togglesText).toMatch(/Issues only\s*1\d/);

    const one = page.getByRole("button", { name: /^Star / }).first();
    await toggleStar(page, () => one.click());
    const starred = await row();
    expect(starred.togglesText).toMatch(/Starred\s*1$/);
    // The toggles stay beside the segments: their top is not below the segments' bottom.
    expect(starred.togglesTop).toBeLessThan(starred.segmentsBottom);
    expect(starred.togglesRight).toBeLessThanOrEqual(starred.sectionRight + 0.5);
    // Nothing on the page moves, and the field in the margin still lines up with the row.
    expect(starred.mainTop).toBeCloseTo(bare.mainTop, 0);
    expect(Math.abs(starred.fieldMid - starred.rowMid)).toBeLessThan(2);

    // And with two digits on Starred as well: eleven more stars.
    await page.evaluate(
      (ids) => localStorage.setItem("status-bar:starred", JSON.stringify(ids)),
      CATALOG.slice(0, 11).map((entry) => entry.id),
    );
    await page.reload();
    await hydrated(page);
    await pressRefresh(page, page.getByRole("button", { name: "Refresh status now" }).first());
    const many = await row();
    expect(many.togglesText).toMatch(/Starred\s*11$/);
    expect(many.togglesTop).toBeLessThan(many.segmentsBottom);
    expect(many.togglesRight).toBeLessThanOrEqual(many.sectionRight + 0.5);
    expect(many.mainTop).toBeCloseTo(bare.mainTop, 0);
  });
}
