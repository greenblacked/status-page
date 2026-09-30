import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { BoardSnapshot } from "../src/lib/status/types.ts";
import { fixtureBoard, serveBoard } from "./fixture-board";

const SERVICES = 14;
const cards = (page: Page) => page.locator('article[id^="service-"]');
/** The cards of one board group: "attention", "operational" or "releases". */
const group = (page: Page, id: "attention" | "operational" | "releases") =>
  page.locator(`section[aria-labelledby="${id}-heading"] article[id^="service-"]`);

/**
 * Waits out every card's fade-in. A card mid-animation is partly transparent,
 * and axe would measure its text at that opacity instead of the colour it
 * settles on.
 */
async function cardsSettled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => (animation as CSSAnimation).animationName === "rise-in")
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

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
    for (const type of ["pointerdown", "keydown", "input"]) {
      window.addEventListener(type, (event) => note({ type, trusted: event.isTrusted }), true);
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
  // After hydration the title leads with how many services need attention: "(2) Status Page".
  await expect(page).toHaveTitle(/^(\(\d+\) )?Status Page$/);
  await expect(cards(page)).toHaveCount(SERVICES);
  // Hydration runs after the first paint; give React time to complain.
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});

test("has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await cardsSettled(page);
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

test("starts the tab order with a skip link that moves focus to the services", async ({
  page,
  isMobile,
  browserName,
}) => {
  test.skip(isMobile, "no Tab key on a touch device");
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // Unhydrated, Enter follows the link's href and puts #services in the address.
  await hydrated(page);
  const skip = page.getByRole("link", { name: "Skip to services" });
  // First in the tab order by the markup itself: nothing before it can take
  // focus, and the compact header, hidden at the top, is inert.
  const first = await page.evaluate(() => {
    const focusable = [...document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]")].find(
      (element) => element.tabIndex >= 0 && !element.closest("[inert]"),
    );
    return focusable?.textContent?.trim();
  });
  expect(first).toBe("Skip to services");
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
  await expect(page.getByRole("status").filter({ hasText: "services shown" })).toHaveText(
    `${SERVICES} of ${SERVICES} services shown`,
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
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Status Page");
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

test("blurs the glass panels and never the whisper surfaces", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  const glass = await backdropFilters(page, ".glass");
  expect(glass.some((value) => value.includes("blur("))).toBe(true);
  const whisper = await backdropFilters(page, ".glass-whisper");
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

/** The search dock, which carries --dock (0 to 1), the search field's progress into the bar. */
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

/** The dock's --dock as a number. */
const dockValue = (page: Page) =>
  searchDock(page).evaluate((element) => Number.parseFloat(element.style.getPropertyValue("--dock") || "0"));

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
  dock: number;
  shown: string | null;
  docking: boolean;
  liveBottom: number;
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
          dock: Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
          shown: bar?.getAttribute("data-shown") ?? null,
          docking: dock?.hasAttribute("data-docking") ?? false,
          liveBottom: live?.getBoundingClientRect().bottom ?? 0,
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

/** The scroll offsets at which the dock changes, worked out from the page the way useSearchDock does. */
type DockOffsets = {
  /** From 64rem the field shares a row with the chips and moves in one go. */
  wide: boolean;
  natural: number;
  /** The bar comes up: on a phone by itself, with the field waiting below it. */
  barStart: number;
  /** --dock leaves 0, and returns to 1 at moveEnd. */
  moveStart: number;
  moveEnd: number;
};

async function dockOffsets(page: Page): Promise<DockOffsets> {
  const natural = await dockNatural(page);
  const { wide, barStick, dockStick } = await page.evaluate(() => ({
    wide: matchMedia("(min-width: 64rem)").matches,
    barStick: Number.parseFloat(
      getComputedStyle(document.querySelector('section[aria-label="Board controls"]') as Element).top,
    ),
    dockStick: Number.parseFloat(getComputedStyle(document.querySelector(".search-dock") as Element).top),
  }));
  if (wide) {
    // One move of 48px, ending where the field sticks; the bar comes up about two thirds of the way through.
    const moveStart = natural - dockStick - 48;
    return { wide, natural, barStart: moveStart + 0.67 * 48, moveStart, moveEnd: moveStart + 48 };
  }
  // The bar sits at the top of the board body, two pixels above the field, until it sticks; 24px later the field
  // starts to merge into it, over 56px.
  const barStart = natural - 2 - barStick;
  return { wide, natural, barStart, moveStart: barStart + 24, moveEnd: barStart + 24 + 56 };
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
  await expect(page.getByTestId("live-bar")).toContainText("last check");

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

test("brings the bar up on its own first, then merges the field into it", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { wide, barStart, moveStart, moveEnd } = await dockOffsets(page);
  test.skip(wide, "from 64rem the field shares a row with the chips and moves in one go");

  const { up } = await dockPath(page);
  const stops = await sweepDock(page, up);
  const firstShown = stops.findIndex((stop) => stop.shown === "true");
  const firstMoving = stops.findIndex((stop) => stop.dock > 0);
  expect(firstShown, "the bar never showed").toBeGreaterThanOrEqual(0);
  expect(firstMoving, "the field never moved").toBeGreaterThanOrEqual(0);
  // Phase one: the bar is up while the field has not moved at all.
  const alone = stops.filter((stop) => stop.shown === "true" && stop.dock === 0);
  expect(alone.length, "the bar never showed by itself").toBeGreaterThan(1);
  for (const stop of alone) {
    expect(stop.docking, `at ${stop.y}`).toBe(false);
    // The field waits below the bar, not under it.
    expect(stop.fieldTop, `at ${stop.y}`).toBeGreaterThanOrEqual(stop.barBottom - 0.5);
  }
  // Waiting, the field stands still: it is pinned below the bar.
  const waiting = alone.map((stop) => stop.fieldTop);
  expect(Math.max(...waiting) - Math.min(...waiting)).toBeLessThanOrEqual(0.5);
  // --dock rises only once the bar is up, and each phase sits at its own offsets.
  expect(firstMoving).toBeGreaterThan(firstShown);
  for (const stop of stops) {
    if (stop.dock > 0) expect(stop.shown, `at ${stop.y}`).toBe("true");
    if (stop.scrollY < barStart) expect(stop.shown, `at ${stop.y}`).toBe("false");
    if (stop.scrollY >= barStart + 1) expect(stop.shown, `at ${stop.y}`).toBe("true");
    if (stop.scrollY <= moveStart) expect(stop.dock, `at ${stop.y}`).toBe(0);
    if (stop.scrollY >= moveEnd + 1) expect(stop.dock, `at ${stop.y}`).toBe(1);
  }
  // The merge itself is monotonic, and the field ends up inside the bar.
  const merging = stops.filter((stop) => stop.dock > 0 && stop.dock < 1);
  expect(merging.length).toBeGreaterThan(2);
  for (const [index, stop] of merging.entries()) {
    expect(stop.docking, `at ${stop.y}`).toBe(true);
    const previous = merging[index - 1];
    if (previous) {
      expect(stop.dock).toBeGreaterThanOrEqual(previous.dock);
      expect(stop.fieldTop).toBeLessThanOrEqual(previous.fieldTop + 0.5);
    }
  }
  const docked = stops.find((stop) => stop.dock === 1);
  expect(docked?.fieldTop).toBeGreaterThanOrEqual((docked?.barTop ?? 0) - 0.5);
  expect(docked?.fieldTop).toBeLessThanOrEqual((docked?.barBottom ?? 0) + 0.5);
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

test("changes the search placeholder only where the field is at rest", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const { path } = await dockPath(page);
  const stops = await sweepDock(page, path);
  const half = stops.length / 2;
  const long = "Search GCP, CS2 Europe, RouterOS…";
  // Down, it is the long one until the field is in the bar; back up, the short one until it is out.
  for (const stop of stops.slice(0, half)) {
    expect(stop.placeholder, `going down, at ${stop.y}`).toBe(stop.dock === 1 ? "Search…" : long);
  }
  for (const stop of stops.slice(half)) {
    expect(stop.placeholder, `coming up, at ${stop.y}`).toBe(stop.dock === 0 ? long : "Search…");
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

test("keeps a docked field docked when a search leaves almost nothing to scroll", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
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

  test("snaps the search field into the bar and out again, never part way", async ({ page }) => {
    test.slow();
    await page.goto("/");
    await expect(cards(page)).toHaveCount(SERVICES);
    await hydrated(page);
    const { path } = await dockPath(page);
    const stops = await sweepDock(page, path);
    expect([...new Set(stops.map((stop) => stop.dock))].sort()).toEqual([0, 1]);
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

test("renders healthy services as full cards, alike whether or not the vendor lists components", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  await openFixture(page, () => board);

  // The heading's count and the cards under it agree.
  const operational = group(page, "operational");
  const total = await operational.count();
  expect(total).toBeGreaterThan(0);
  await expect(page.locator("#operational-heading")).toContainText(String(total));

  for (const id of ["chatgpt", "claude", "grok"] as const) {
    const service = board.services.find((item) => item.id === id);
    if (!service) throw new Error(`the fixture has no ${id}`);
    const card = page.locator(`article#service-${id}`);
    // In the Operational group, not a one-line tile in a group of its own.
    await expect(operational.and(card), `${id} sits in Operational`).toHaveCount(1);
    // The same parts on every one: name, badge, star, link to the official source.
    await expect(card.getByRole("heading", { level: 3, name: service.name })).toBeVisible();
    // The badge in the card header, not the component list's screen-reader-only state words.
    await expect(card.locator("[data-card-header]").getByText("Operational", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: `Star ${service.name}` })).toBeVisible();
    await expect(card.locator(`a[href="${service.sourceUrl}"]`)).toBeVisible();
    // The component list is there when the vendor reports components, and only then.
    const list = card.getByRole("list", { name: "Components" });
    if (service.components.length === 0) {
      await expect(list).toHaveCount(0);
    } else {
      await expect(list).toHaveCount(1);
      await expect(list.getByRole("listitem")).toHaveCount(service.components.length);
      for (const component of service.components) {
        await expect(list.getByText(component.name, { exact: true })).toBeVisible();
      }
    }
  }
});

test("leads Needs attention with the most urgent service and follows the data", async ({ page }) => {
  let board = fixtureBoard(Date.now());
  await openFixture(page, () => board);

  const attention = group(page, "attention");
  // AWS is an outage, Google Cloud is degraded, Epic is in maintenance, Android is unknown.
  await expect(attention).toHaveCount(4);
  await expect(attention.nth(0)).toHaveAttribute("id", "service-aws");
  await expect(attention.nth(1)).toHaveAttribute("id", "service-gcp");
  await expect(attention.nth(2)).toHaveAttribute("id", "service-epic");
  await expect(attention.nth(3)).toHaveAttribute("id", "service-android");

  // Exactly one card is the highlight, and it is the first.
  const highlight = page.locator('article[data-highlight="true"]');
  await expect(highlight).toHaveCount(1);
  await expect(highlight).toHaveAttribute("id", "service-aws");
  await expect(highlight).toContainText("Most urgent");
  // The caption is the card's own first line, not a wrapper around it.
  await expect(highlight.locator("> p").first()).toHaveText("Most urgent");
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
  await expect(highlight).toContainText("Most urgent");
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

  // Attention first, then Operational, then Releases, each with its count.
  await expect(page.locator("#attention-heading, #operational-heading, #releases-heading")).toHaveText([
    /Needs attention\s*4/,
    /Operational\s*\d+/,
    /Releases\s*\d+/,
  ]);

  // Issues only leaves the four attention cards, the highlight among them.
  const issues = page.getByRole("button", { name: /Issues only/ });
  await issues.click();
  await expect(cards(page)).toHaveCount(4);
  await expect(page.locator('article[data-highlight="true"]')).toHaveAttribute("id", "service-aws");
  await issues.click();
  await expect(cards(page)).toHaveCount(SERVICES);

  // A star lifts a healthy card to the head of Operational, but never above a worse service in Needs attention.
  const starClaude = page.getByRole("button", { name: "Star Claude", exact: true });
  await toggleStar(page, () => starClaude.click());
  await expect(starClaude).toHaveAttribute("aria-pressed", "true");
  await expect(group(page, "operational").first()).toHaveAttribute("id", "service-claude");
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
  const operational = group(page, "operational");
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
  const operational = group(page, "operational");
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

  await page.getByRole("button", { name: "Settings and shortcuts" }).click();
  const toggle = page.getByRole("switch", { name: "Reduce glass" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(html).toHaveAttribute("data-reduce-transparency", "true");
  expect((await backdropFilters(page, ".glass")).filter((value) => value !== "none")).toEqual([]);

  const problems = watchConsole(page);
  await page.reload();
  await expect(html).toHaveAttribute("data-reduce-transparency", "true");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await page.getByRole("button", { name: "Settings and shortcuts" }).click();
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
for (const colorScheme of ["light", "dark"] as const) {
  for (const contrast of ["no-preference", "more"] as const) {
    const name = `${colorScheme}${contrast === "more" ? ", Increase Contrast" : ""}`;
    test(`keeps every text colour at AA on the flat fills alone (${name})`, async ({ page }) => {
      await page.clock.install();
      const board = fixtureBoard(Date.now());
      await serveBoard(page, () => board);
      await page.emulateMedia({ colorScheme, contrast, reducedMotion: "reduce" });
      await page.goto("/");
      await expect(cards(page)).toHaveCount(SERVICES);
      await hydrated(page);
      await page.getByRole("button", { name: "Refresh status now" }).first().click();
      for (const label of ["Outage", "Degraded", "Maintenance", "Unknown", "Operational"]) {
        await expect(page.locator("main").getByText(label, { exact: true }).first()).toBeVisible();
      }
      // Shortly after midnight UTC the fixture's incidents began the day
      // before, and the card adds their date: "since 27 Sep 21:52 UTC".
      await expect(page.getByText(/^since (\d{1,2} [A-Z][a-z]{2} (\d{4} )?)?\d\d:\d\d UTC/).first()).toBeVisible();
      expect(await contrastFailures(page)).toEqual([]);

      // Seven minutes on, the same snapshot again: the board says Stale.
      await page.clock.fastForward("07:00");
      await expect(page.getByText("Stale", { exact: true })).toBeVisible();
      expect(await contrastFailures(page)).toEqual([]);

      // And the settings dialog, with the single-key shortcuts dimmed.
      await page.getByRole("button", { name: "Settings and shortcuts" }).click();
      await page.getByRole("switch", { name: "Single-key shortcuts" }).click();
      expect(await contrastFailures(page)).toEqual([]);
    });
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
// (nothing collects any today). These two run only when the runner is given
// the same VITE_STATUS_HISTORY=1 it built with, and are skipped otherwise;
// the default build is covered by the test above, which a history build skips.
// CI's history job builds with the flag and runs them by their @history tag.
test("shows an uptime strip on a card once /api/history.json has days", { tag: "@history" }, async ({ page }) => {
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
  await expect(footer).toContainText(
    "MIT License: free to use, copy, modify and share, with the copyright notice kept.",
  );
  await expect(footer).toContainText("This page checks every two minutes; the server reads the official vendor feeds");
});

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
