import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { CATALOG } from "../src/lib/status/catalog.ts";
import { BAR_RISE, DOCK_HYSTERESIS, HIDE_DOWN_PX, REVEAL_UP_PX, WIDE_RANGE } from "../src/lib/status/dock.ts";
import { PULSE_STORAGE_KEY } from "../src/lib/status/pulse.ts";
import type { BoardSnapshot } from "../src/lib/status/types.ts";
import { calmBoard, fixtureBoard, longHeroBoard, serveBoard } from "./fixture-board";
import {
  EXPECTED_RELEASE_LINES,
  firstRenderCarriesReleaseLines,
  MIKROTIK_NOTE,
  releaseLineIds,
} from "./support/first-render";
import { expect, test } from "./test";

const SERVICES = 20;
const cards = (page: Page) => page.locator('article[id^="service-"]');
/** The services of one board group: "attention", "unread" (Couldn't read), "up" (every category's list) or "releases". */
const group = (page: Page, id: "attention" | "unread" | "up" | "releases") =>
  page.locator(`[data-group="${id}"] article[id^="service-"]`);
/** The healthy services of one category's list, such as "ai". */
const upList = (page: Page, category: string) =>
  page.locator(`section[aria-labelledby="up-${category}-heading"] article[id^="service-"]`);

/**
 * Waits until React has hydrated the page and its saved checks are in
 * (data-hydrated, set in board-view.tsx). The server's markup, cards
 * included, paints before that, and a click on it goes nowhere: on a slow
 * device (WebKit on a phone) a test that clicks as soon as the cards are
 * there can beat the handlers, and the click is lost for good. The saved
 * checks add rows to Recent changes in the render after hydration, which
 * moves what is below it, so the attribute waits for them too. That is a
 * few renders after the first, so the wait is longer than the default 5s: on
 * a loaded runner each one takes a while.
 */
async function hydrated(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
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
  await refreshIntoServedBoard(page, ready);
}

/**
 * openFixture, with the page's Date 30 s into a slot (pinToSlot) first, for a test that presses something on the
 * board. At the turn of a slot (every two minutes of the wall clock) the page refetches, adds a row to Recent
 * changes and clears the "Changed" tags, which moves every card under a tag by 36px to 108px, and where the browser
 * has no scroll anchoring (WebKit) useHoldPlace scrolls the page by the same distance a moment later. A press made
 * in the second or two after a turn can find the board moving under it. With the page 30 s in, the next turn is 90 s
 * away, past the end of any of these tests. Tests that install page.clock and fast-forward it pin the page already.
 */
async function openFixtureInSlot(
  page: Page,
  board: () => BoardSnapshot,
  ready?: { id: string; label: string },
): Promise<void> {
  await pinToSlot(page);
  await openFixture(page, board, ready);
}

/** On a loaded page that has a board served (serveBoard), presses Refresh so the board replaces the server's first render. */
async function refreshIntoServedBoard(
  page: Page,
  ready: { id: string; label: string } = { id: "aws", label: "Outage" },
): Promise<void> {
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

/**
 * Moves the page's Date to 30 s into a two-minute slot, and lets it run on from there. The turn of a slot adds a row
 * to Recent changes, which grows the board body and makes the dock measure again (rightly); with the page 30 s in,
 * the next turn and the wall-clock refetch are 90 s or more away. Only Date moves. page.clock.install would do the
 * same, but it also replaces requestAnimationFrame with a timer that fires every 16 ms of clock time whether or not
 * the page has rendered: three of those "frames" can pass before the page has rendered once, and so before a resize
 * reaches it (the resize event is sent in a rendering update, ahead of the frame callbacks).
 */
async function pinToSlot(page: Page): Promise<void> {
  const offset = Math.floor(Date.now() / 120_000) * 120_000 + 30_000 - Date.now();
  await page.addInitScript((shift) => {
    const Native = Date;
    let stopped: number | null = null;
    const now = () => stopped ?? Native.now() + shift;
    (window as Window & { __stopClock?: () => void }).__stopClock = () => {
      stopped ??= now();
    };
    window.Date = new Proxy(Native, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
      apply: (target) => new target(now()).toString(),
      get: (target, key) => (key === "now" ? now : Reflect.get(target, key, target)),
    });
  }, offset);
}

/**
 * Stops the page's Date where it is, on a page that pinToSlot moved (timers and frames run on). Every text on the board
 * that counts from now stands still once the page has drawn the stopped time, which it does on its next one-second
 * tick (useNow), so this waits that tick out and two frames after it: a minute can turn between the last tick and the
 * stop, and the tick after it would draw the new minute under whatever the caller starts watching. What stands still:
 * the running time of an incident, the countdown, the ages. A test of the board's geometry or of its layout shifts
 * is about what its own actions move, and a clock that crosses a minute under it moves text that has nothing to do
 * with them. The e2e payloads make that likely and not rare: the dates of
 * a canned payload are moved to the moment it is read, and several of its incidents began a whole number of hours
 * before, so "since 14:05 UTC (3h)" reads "(3h 1m)", 23px wider, a minute after the board was built, wherever in a
 * test that falls (Chromium counts it as a layout shift of 0.0004).
 */
async function stopClock(page: Page): Promise<void> {
  const stopped = await page.evaluate(() => {
    const stop = (window as Window & { __stopClock?: () => void }).__stopClock;
    stop?.();
    return stop !== undefined;
  });
  expect(stopped, "the page's clock was pinned (pinToSlot) before it could be stopped").toBe(true);
  // useNow redraws on a 1 s interval, whose next run is due within 1 s of now and so runs before this timer does;
  // the frames let what it rendered be laid out and reported.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 1_100),
      ),
  );
}

/**
 * Waits until the bar's lead line has settled to its live words ("Checked 14:05 UTC · next in 1:30"), which it
 * shows only once the page has hydrated and read its clock. A refetch flips the line to "Checking…" and back, and
 * from 40rem the line sits in the flow before the field's slot, so the slot's left edge and width move with it: a
 * docked field follows, a frame or more later. Anything that compares the field or its fill with the slot, or that
 * counts what the dock does, has to start after this and before the next refetch (see steadyBoard).
 *
 * The waits are long on purpose. The page loader serves a snapshot up to two minutes old and starts a vendor sweep
 * behind it; when the page's clock calls that snapshot stale, the refetch on mount is a plain GET that waits for
 * the same sweep, and vendor calls time out at 9 s, so the line can read "Checking…" for well over the default 5 s.
 * pinToSlot moving the clock forward makes that more likely, not less. awayFromRefetch had the same 90 s.
 */
async function leadSteady(page: Page): Promise<void> {
  const lead = page.locator("[data-bar-lead]");
  await expect(lead).toHaveAttribute("data-state", "live", { timeout: 90_000 });
  await expect(lead).toContainText(/next in \d+:\d{2}/, { timeout: 90_000 });
}

/**
 * Waits until the self-hosted Inter's fetch is over (loaded, or failed). Inter is font-display: optional, so a page
 * view keeps the face it was first drawn in (Inter if the file was ready at the first render, the system font if
 * not) and nothing swaps in later; what this wait settles is that no fetch of the font is still in flight when a
 * test reads geometry, and that the hero is drawn. The hero's lede wraps differently in the two faces, and how many
 * lines it takes depends on the board's words (the canned first render has a long one), so tests that read geometry
 * call this before they read any. Not for a test that holds the font back itself: it would wait for the test's own
 * release (an aborted font settles at once).
 */
async function fontsSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.load("400 16px Inter").catch(() => []);
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/**
 * Opens the board with its bar steady: the page's Date is 30 s into a slot (pinToSlot), so the next scheduled
 * refetch and the turn of the slot are 90 s or more away, and the refetch on mount of a snapshot past its
 * staleTime, if there is one, has landed (leadSteady). A test that reads where the field or its fill is against the
 * slot, or counts the dock's work, starts from this instead of a bare goto, so that no change of the bar's lead
 * line moves the slot under it. Tests that install page.clock and fast-forward it do not need it.
 */
async function steadyBoard(page: Page): Promise<void> {
  await pinToSlot(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await fontsSettled(page);
  await leadSteady(page);
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
  const response = await page.goto("/");
  // What is hydrated is not a board of Unknown cards: the preview answers its collectors from the unit tests'
  // payloads (e2e/support/no-vendors.mjs), so the server's markup has outage and degraded cards and an incident's
  // "since" time on them, and a mismatch in any of those fails here as a hydration warning. If the markup were
  // all Unknown, this would say so rather than pass on less.
  const html = (await response?.text()) ?? "";
  expect(html).toContain('data-health="outage"');
  expect(html).toContain('data-health="degraded"');
  // (A start from before 00:00 UTC shows its day too, "3 Oct 19:07 UTC", which is what the first hours of a UTC day see.)
  expect(html).toMatch(/[Ss]ince <time [^>]*>(?:\d{1,2} [A-Z][a-z]{2} )?\d\d:\d\d\sUTC<\/time>/);
  // Nor a board without what is read after the sweep: the release feeds and the MikroTik changelogs join a board one
  // build late, so the global setup waits for them and asks for the page once they are in hand (e2e/support/
  // global-setup.ts). Without that, this markup would have no release line, and the hydration of those lines and of
  // the MikroTik notes in its Details would be untested. That holds while the canned feeds are younger than their
  // 30-minute cache; a longer run (all six projects, WebKit last) may get a board built while they are read again,
  // and then asks only that no line is unexpected.
  if (firstRenderCarriesReleaseLines()) {
    expect(releaseLineIds(html)).toEqual(EXPECTED_RELEASE_LINES);
    expect(html).toContain(MIKROTIK_NOTE);
  } else {
    expect(releaseLineIds(html).filter((id) => !EXPECTED_RELEASE_LINES.includes(id))).toEqual([]);
  }
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
  const audit = async () => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    // Every failing node with axe's own summary (colours and ratio for
    // contrast), so a failure in CI can be read from the log alone.
    return results.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .flatMap((violation) =>
        violation.nodes.map(
          (node) => `${violation.id} ${node.target.join(" ")}: ${node.failureSummary ?? violation.help}`,
        ),
      );
  };
  // The page as the server renders it (the preview's canned vendor payloads: outages, degraded, incidents) ...
  expect(await audit()).toEqual([]);
  // ... and with every state a card can be in: outage, degraded, maintenance, unknown, operational.
  await serveBoard(page, () => fixtureBoard(Date.now()));
  await refreshIntoServedBoard(page);
  expect(await audit()).toEqual([]);
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
  const search = page.getByRole("searchbox", { name: "Search services" }).or(heroSearch(page));
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
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  // The longest cards come with a board that has every state, long summaries and component lists.
  await serveBoard(page, () => fixtureBoard(Date.now()));
  await refreshIntoServedBoard(page);
  expect(await overflow()).toBeLessThanOrEqual(0);
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
 * The search dock, in the hero. From 64rem it carries --dock (0 to 1), the field's progress into the bar, which
 * follows the scroll. Below that the field is ordinary content that scrolls away with the page, and the bar has a
 * copy of it that a scroll up reveals (data-revealed on the bar) and a scroll down hides. Every reading of the dock
 * below is --dock on a wide screen and the bar's data-revealed below it.
 */
const searchDock = (page: Page) => page.locator(".search-dock");

/**
 * The hero's search field and the bar's copy of it. Both are labelled "Search services", so neither is found by
 * its label; the markup says which is which (data-search-input).
 */
const heroSearch = (page: Page) => page.locator('[data-search-input="hero"]');
const barSearch = (page: Page) => page.locator('[data-search-input="bar"]');

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

/** The dock's reading on a wide screen: --dock (0 to 1). Below 64rem nothing is written, and this is 0. */
const dockValue = (page: Page) =>
  searchDock(page).evaluate((element) => Number.parseFloat(element.style.getPropertyValue("--dock") || "0"));

/** Whether the bar's copy of the field is revealed, as the page says it (data-revealed on the bar). */
const isRevealed = (page: Page) => controlBar(page).evaluate((bar) => bar.hasAttribute("data-revealed"));

/** Waits until the page says the bar's field is (or is not) revealed. */
async function expectRevealed(page: Page, revealed: boolean): Promise<void> {
  if (revealed) await expect(controlBar(page)).toHaveAttribute("data-revealed", "");
  else await expect(controlBar(page)).not.toHaveAttribute("data-revealed");
}

/** Waits out the bar's own fade and slide, but not the live ring inside it, which never finishes. */
async function barSettled(page: Page): Promise<void> {
  await controlBar(page).evaluate((bar) => Promise.all(bar.getAnimations().map((animation) => animation.finished)));
}

/** Waits until the bar's copy of the field has finished fading and rising, in or out. */
const barFieldSettled = (page: Page) =>
  page
    .locator(".bar-search")
    .evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));

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
  /** Wide: the dock's reading, --dock. Below 64rem it is never written, and this is 0. */
  dock: number;
  shown: string | null;
  /** Wide: the move is under way (--dock above 0). */
  docking: boolean;
  /** Below 64rem: the bar's copy of the field is revealed (data-revealed). */
  revealed: boolean;
  /** The opacity the bar's copy of the field is drawn at. */
  barFieldOpacity: number;
  liveBottom: number;
  /** Where the hero's last line ends: the live line on a phone, the headline's sentence beside it from 48rem. */
  contentBottom: number;
  barTop: number;
  barBottom: number;
  /** The hero's field. */
  fieldTop: number;
  fieldBottom: number;
  /** The hero's input's placeholder. */
  placeholder: string;
  chipOpacity: number;
  chipsClickable: boolean;
  chipHitByInput: boolean;
  input: { same: boolean; mark?: string; value?: string; caret?: number | null };
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
      const field = document.querySelector<HTMLElement>(".search-dock .search-field");
      const input = document.querySelector<HTMLInputElement>('[data-search-input="hero"]');
      const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
      const barField = document.querySelector<HTMLElement>(".bar-search");
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
        const box = chip?.getBoundingClientRect();
        const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
        const limit = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        const fieldBox = field?.getBoundingClientRect();
        seen.push({
          y,
          target: Math.max(0, Math.min(y, limit)),
          scrollY: window.scrollY,
          frameMs,
          fellBack,
          dock: Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
          shown: bar?.getAttribute("data-shown") ?? null,
          docking: dock?.hasAttribute("data-docking") ?? false,
          revealed: bar?.hasAttribute("data-revealed") ?? false,
          barFieldOpacity: barField ? Number.parseFloat(getComputedStyle(barField).opacity) : 0,
          liveBottom: live?.getBoundingClientRect().bottom ?? 0,
          contentBottom: (hero?.getBoundingClientRect().bottom ?? 0) - heroPad,
          barTop: bar?.getBoundingClientRect().top ?? 0,
          barBottom: bar?.getBoundingClientRect().bottom ?? 0,
          fieldTop: fieldBox?.top ?? 0,
          fieldBottom: fieldBox?.bottom ?? 0,
          placeholder: input?.placeholder ?? "",
          chipOpacity: chips ? Number.parseFloat(getComputedStyle(chips).opacity) : 1,
          chipsClickable: chip ? getComputedStyle(chip).pointerEvents !== "none" : true,
          chipHitByInput: Boolean(hit?.closest(".search-field")),
          input: {
            same: document.activeElement === input,
            mark: (document.activeElement as (HTMLInputElement & { dockMark?: string }) | null)?.dockMark,
            value: input?.value,
            caret: input?.selectionStart,
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
        stops: sweep.stops.map(({ y, target, scrollY, frameMs, fellBack, dock, revealed }) => ({
          y,
          target,
          scrollY,
          frameMs: frameMs.map((ms) => Math.round(ms)),
          fellBack,
          dock,
          revealed,
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
  /** The bar comes up: below 64rem on its own, once the hero's last line has cleared it. */
  barStart: number;
  /** Wide: --dock leaves 0 here, and returns to 1 at moveEnd. Below 64rem: the bar comes up (the same as barStart). */
  moveStart: number;
  /** Wide: the field reaches its pin (--dock is 1 from here). Below 64rem: the hero's field is behind the bar. */
  moveEnd: number;
  /** Below 64rem: where the hero's field has its bottom edge at the bar's, and the bar's field can show. */
  revealFrom: number;
};

async function dockOffsets(page: Page): Promise<DockOffsets> {
  const natural = await dockNatural(page);
  const measured = await page.evaluate(() => {
    const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
    const dock = document.querySelector(".search-dock") as HTMLElement;
    const hero = document.querySelector(".board-body")?.previousElementSibling as HTMLElement;
    return {
      wide: matchMedia("(min-width: 64rem)").matches,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      barTop: Number.parseFloat(getComputedStyle(bar).top),
      barHeight: bar.offsetHeight,
      dockStick: Number.parseFloat(getComputedStyle(dock).top),
      fieldBottom: dock.getBoundingClientRect().bottom + window.scrollY,
      contentBottom:
        hero.getBoundingClientRect().bottom + window.scrollY - Number.parseFloat(getComputedStyle(hero).paddingBottom),
    };
  });
  if (measured.wide) {
    // The field reaches its pin, and --dock its 1, at moveEnd. One move of 48px; the bar comes up about two thirds
    // of the way through it, or at the end when the field snaps.
    const moveEnd = natural - measured.dockStick;
    const moveStart = moveEnd - WIDE_RANGE;
    return {
      wide: true,
      natural,
      barStart: measured.reduced ? moveEnd : moveStart + 0.67 * WIDE_RANGE,
      moveStart,
      moveEnd,
      revealFrom: Number.POSITIVE_INFINITY,
    };
  }
  // Below 64rem the bar is fixed and comes up once the hero's last line has scrolled out from under the highest
  // point the sliding bar reaches. The hero's field is in the flow: the bar's copy can show once its bottom edge
  // is level with the bar's, and the hook turns that on a few px (DOCK_HYSTERESIS) past it.
  const barStart = Math.max(0, measured.contentBottom - (measured.barTop - BAR_RISE));
  const revealFrom = measured.fieldBottom - (measured.barTop + measured.barHeight);
  return {
    wide: false,
    natural,
    barStart,
    moveStart: barStart,
    moveEnd: revealFrom + DOCK_HYSTERESIS,
    revealFrom,
  };
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

/**
 * Opens the board for a test of the bar's field: steady (see steadyBoard), hydrated, and armed (the hook reads a
 * direction only from two frames after the load), and skipped from 64rem, where there is no bar field to reveal.
 * Returns the page's offsets and how far it can scroll.
 */
async function revealBoard(page: Page): Promise<DockOffsets & { limit: number }> {
  await steadyBoard(page);
  await stopClock(page);
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  const offsets = await dockOffsets(page);
  test.skip(offsets.wide, "from 64rem the field shares a row with the chips and there is no copy of it in the bar");
  return { ...offsets, limit: await maxScroll(page) };
}

/**
 * revealBoard on a served board instead of the live one, whose cards (and so what a search leaves of the page) depend
 * on what the vendors say that day. Pinned to a slot like steadyBoard, so the bar's lead is steady too.
 */
async function revealServedBoard(
  page: Page,
  board: (now: number) => BoardSnapshot,
  ready?: { id: string; label: string },
): Promise<DockOffsets & { limit: number }> {
  await pinToSlot(page);
  await openFixture(page, () => board(Date.now()), ready);
  await fontsSettled(page);
  await leadSteady(page);
  await stopClock(page);
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  const offsets = await dockOffsets(page);
  test.skip(offsets.wide, "from 64rem the field shares a row with the chips and there is no copy of it in the bar");
  return { ...offsets, limit: await maxScroll(page) };
}

/**
 * Takes the page down past the point where the hero's field is behind the bar, with the bar's field hidden: the
 * way a reader arrives. Returns the position: 200px past it, and at least 160px short of the end of the page, so a
 * test has room to scroll further down from there.
 */
async function scrollDeep(page: Page, offsets: DockOffsets & { limit: number }): Promise<number> {
  const y = Math.min(Math.ceil(offsets.revealFrom) + 200, offsets.limit - 160);
  expect(y, "the page is long enough to scroll down in").toBeGreaterThan(
    offsets.revealFrom + DOCK_HYSTERESIS + 2 * REVEAL_UP_PX,
  );
  await scrollAndSettle(page, y);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  expect(await isRevealed(page)).toBe(false);
  return y;
}

test("keeps the floating bar clear of the live bar as it appears", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await fontsSettled(page);
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
        // The bar is 3rem tall: once it is, the layout has taken the size, and the dock measures on the frame after.
        await expect.poll(() => controlBar(page).evaluate((bar) => (bar as HTMLElement).offsetHeight)).toBe(3 * rootPx);
      }
      // The page's own refetch changes the live line's height for a moment: sweep clear of it.
      await awayFromRefetch(page);
      // Measure at the top of the page, not where the last width left the scroll.
      await scrollAndSettle(page, 0);
      const { natural, barStart, revealFrom } = await dockOffsets(page);
      // The bar is up alone for a stretch of scrolling before the hero's field is behind it: the spacing under the
      // live line (the page's padding and the field's margin, less the bar's room) is 36px at a 16px root.
      expect(revealFrom - barStart, `${at}: the bar alone`).toBeGreaterThanOrEqual(30 * (rootPx / 16) - 1);

      const { up } = await dockPath(page, 2);
      const stops = await sweepDock(page, up);
      const shown = stops.filter((stop) => stop.shown === "true");
      const first = shown[0];
      expect(first, `${at}: the bar never showed`).toBeDefined();
      // The bar never sits over the hero's last line, from the first stop it shows at.
      for (const stop of shown) expect(stop.contentBottom, `${at}, ${stop.y}`).toBeLessThanOrEqual(stop.barTop + 0.5);
      // Nothing in the bar to cover the line with: the field is hidden going down, at every stop.
      for (const stop of stops) {
        expect(stop.revealed, `${at}, ${stop.y}`).toBe(false);
        expect(stop.barFieldOpacity, `${at}, ${stop.y}`).toBe(0);
      }
      // The field is the page's own, in the flow: it rises 1:1 with the scrolling the whole way, never pinned.
      for (const stop of stops) {
        expect(stop.fieldTop, `${at}, ${stop.y}`).toBeCloseTo(natural - stop.scrollY, 0);
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
    // This answer is meant to take the bar down, and a bar that is down is out of the accessibility tree (it is
    // visibility: hidden once its fade ends), so a role query would stop finding its button before the button
    // reports that the refresh is over. The button is found by its label instead, which a hidden bar keeps.
    await pressRefresh(page, controlBar(page).locator('button[aria-label="Refresh status now"]'));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Five are down, five are degraded and five are in maintenance.",
    );
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

test("keeps the bar up while the page hovers just above where it appears", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await fontsSettled(page);
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
): Promise<{ y: number; dock: number; shown: string | null; revealed: boolean; fieldTop: number }[]> {
  return page.evaluate(async (ys) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const original = Object.getOwnPropertyDescriptor(window, "scrollY");
    const dock = document.querySelector<HTMLElement>(".search-dock");
    const field = document.querySelector<HTMLElement>(".search-dock .search-field");
    const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
    const seen: { y: number; dock: number; shown: string | null; revealed: boolean; fieldTop: number }[] = [];
    try {
      for (const y of ys) {
        Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
        window.dispatchEvent(new Event("scroll"));
        await frame();
        await frame();
        seen.push({
          y,
          dock: Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
          shown: bar?.getAttribute("data-shown") ?? null,
          revealed: bar?.hasAttribute("data-revealed") ?? false,
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
// position with thresholds, and a position past either end of the page reads as that end (the reveal clamps it
// to the page), so they pass without any special handling of the overshoot in the test. They fail if a change
// makes the dock follow the overshoot (a progress that extrapolates, a threshold that flips on a negative
// position, a recoil from the bottom that reads as a scroll up).
test("search reveal: a rubber band above the top of the page changes nothing", async ({ page }) => {
  // From a steady board (see steadyBoard): a refetch or a late font that moves the bar's slot makes the dock measure
  // again, and a measure that lands among the positions below reads the mocked scrollY against a page that did not
  // move with it, which puts every threshold out (a real rubber band moves the page too).
  await steadyBoard(page);
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  await expect(controlBar(page)).toHaveAttribute("data-shown", "false");
  const [at] = await overscroll(page, [0]);
  const seen = await overscroll(page, [-4, -90, -1, -320, 0, -40, -2000, 0]);
  // The field does not move on its own account, and the bar never comes up for a position above the page.
  for (const stop of seen) {
    expect(stop.dock, `at ${stop.y}`).toBe(0);
    expect(stop.shown, `at ${stop.y}`).toBe("false");
    expect(stop.revealed, `at ${stop.y}`).toBe(false);
    expect(stop.fieldTop, `at ${stop.y}`).toBeCloseTo(at.fieldTop, 0);
  }
});

test("search reveal: a rubber band below the end of the page, and its recoil, reveal nothing", async ({ page }) => {
  test.slow();
  // A steady board, as above: no measure may land among the mocked positions.
  await steadyBoard(page);
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  const { wide } = await dockOffsets(page);
  const limit = await maxScroll(page);
  await scrollAndSettle(page, limit);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  // Wide: the field is in the bar. Below 64rem: the page went down, so the bar's field is hidden.
  expect(await dockValue(page)).toBe(wide ? 1 : 0);
  expect(await isRevealed(page)).toBe(false);
  const [at] = await overscroll(page, [limit]);
  // The bounce past the end and back: iOS reads the way back as a scroll up, but the position is clamped to the end.
  const seen = await overscroll(page, [limit + 6, limit + 120, limit + 2, limit + 600, limit, limit + 60, limit - 1]);
  for (const stop of seen) {
    expect(stop.dock, `at ${stop.y}`).toBe(wide ? 1 : 0);
    expect(stop.shown, `at ${stop.y}`).toBe("true");
    expect(stop.revealed, `at ${stop.y}`).toBe(false);
    expect(stop.fieldTop, `at ${stop.y}`).toBeCloseTo(at.fieldTop, 0);
  }
});

test("search reveal: does not move the dock or the reveal when only the viewport's height changes, as iOS's toolbar does", async ({
  page,
}) => {
  test.slow();
  // Well inside a slot, with the page's frames its own, and past the refetch on mount of a snapshot past its TTL
  // (see steadyBoard): that refetch changes the live line, and with it the hero and the slot, so the dock measures
  // again, rightly, and the count below would take that for a resize.
  await steadyBoard(page);
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  const { wide, moveStart, moveEnd, revealFrom } = await dockOffsets(page);
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
      const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
      // The field that is in use: the hero's, moving into the bar, on a wide screen; the bar's copy below it.
      const field = document.querySelector<HTMLElement>(
        matchMedia("(min-width: 64rem)").matches ? ".search-dock .search-field" : ".bar-search .search-field",
      );
      const box = field?.getBoundingClientRect();
      return {
        scrollY: window.scrollY,
        dock: Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
        shown: bar?.getAttribute("data-shown") ?? null,
        revealed: bar?.hasAttribute("data-revealed") ?? false,
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

  if (wide) {
    // Part way through the move, where the dock is most sensitive to being measured again.
    await scrollAndSettle(page, Math.round((moveStart + moveEnd) / 2));
  } else {
    // With the bar's field revealed: well down the page, and then a little way up.
    await scrollAndSettle(page, Math.ceil(revealFrom) + 300);
    await scrollAndSettle(page, Math.ceil(revealFrom) + 300 - 2 * REVEAL_UP_PX);
    await expectRevealed(page, true);
    await barFieldSettled(page);
  }
  const before = await look();
  if (wide) {
    expect(before.dock).toBeGreaterThan(0);
    expect(before.dock).toBeLessThan(1);
  } else {
    expect(before.revealed).toBe(true);
  }
  const measuredBefore = await measured();

  // The toolbar collapses (the page gets taller by about 80px), comes back, and does it again.
  for (const height of [size.height + 80, size.height, size.height + 80, size.height]) {
    await page.setViewportSize({ width: size.width, height });
    await frames(3);
    const after = await look();
    expect(after.scrollY, `height ${height}`).toBeCloseTo(before.scrollY, 0);
    expect(after.dock, `height ${height}`).toBe(before.dock);
    expect(after.shown, `height ${height}`).toBe(before.shown);
    expect(after.revealed, `height ${height}`).toBe(before.revealed);
    expect(after.box?.y, `height ${height}`).toBeCloseTo(before.box?.y ?? 0, 0);
    expect(after.box?.x, `height ${height}`).toBeCloseTo(before.box?.x ?? 0, 0);
    expect(after.box?.width, `height ${height}`).toBeCloseTo(before.box?.width ?? 0, 0);
    expect(after.box?.height, `height ${height}`).toBeCloseTo(before.box?.height ?? 0, 0);
  }
  expect(await measured(), "a change of height alone measures the page again").toBe(measuredBefore);

  // A change of width does (a rotation), so the guard is not just deaf to resizes. Wait for the measure rather than
  // for a count of frames: a slow browser may take longer than three to deliver the resize.
  await page.setViewportSize({ width: size.width - 20, height: size.height });
  await expect
    .poll(measured, { message: "a change of width does not measure the page again", timeout: 10_000 })
    .toBeGreaterThan(measuredBefore ?? 0);
});

test("search reveal: a fast scroll down and back up reveals the bar's field once and hides it once", async ({
  page,
}) => {
  test.slow();
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await fontsSettled(page);
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  await lightenPaint(page);
  const { wide, natural, barStart, moveStart, moveEnd } = await dockOffsets(page);
  const limit = await maxScroll(page);
  const from = Math.max(0, Math.round(Math.min(barStart, moveStart) - 80));
  const to = Math.min(limit, Math.round(moveEnd + (wide ? 80 : 160)));
  // A long stride a stop: a flick, not the sweeps' careful steps. Two frames a stop: the dock writes what a scroll
  // means in a requestAnimationFrame of its own, queued after this one's, so it is read in the frame after.
  const run = (ys: number[]) =>
    page.evaluate(async (stops) => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const dock = document.querySelector<HTMLElement>(".search-dock");
      const field = document.querySelector<HTMLElement>(".search-dock .search-field");
      const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
      const seen: { scrollY: number; fieldTop: number; dock: number; shown: string | null; revealed: boolean }[] = [];
      for (const y of stops) {
        window.scrollTo(0, y);
        await frame();
        await frame();
        seen.push({
          scrollY: window.scrollY,
          fieldTop: field?.getBoundingClientRect().top ?? 0,
          dock: Number.parseFloat(dock?.style.getPropertyValue("--dock") || "0"),
          shown: bar?.getAttribute("data-shown") ?? null,
          revealed: bar?.hasAttribute("data-revealed") ?? false,
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
  const changes = (stops: { revealed: boolean }[]) =>
    stops.filter((s, i) => i > 0 && s.revealed !== stops[i - 1].revealed).map((s) => s.revealed);
  // Down: the page goes only one way, so the field only rises (it stops at its pin, wide), the dock only grows and
  // the bar comes up once. Up is the same run backwards. Not one stop goes back and forth.
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
  // Below 64rem it has no pin.
  const pin = wide ? natural - moveEnd : Number.NEGATIVE_INFINITY;
  for (const stop of [...downward, ...upward].filter((stop) => natural - stop.scrollY > pin + 1)) {
    expect(stop.fieldTop, `at ${stop.scrollY}`).toBeCloseTo(natural - stop.scrollY, 0);
  }
  if (wide) {
    expect(downward.at(-1)?.dock).toBe(1);
    expect(upward.at(-1)?.dock).toBe(0);
  } else {
    // Going down reveals nothing. Coming back it reveals once, 24px into the way up, and takes the field away once,
    // where the hero's field comes back from behind the bar: one reveal and one hide, whatever the stride.
    expect(changes(downward), "the bar's field changed on the way down").toEqual([]);
    expect(changes(upward), "the bar's field on the way up").toEqual([true, false]);
  }
});

test("draws the search field's fill behind a see-through input, the size of the field, at every width", async ({
  page,
}) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  // The hero's field, and (below 64rem, where it is laid out) the bar's copy of it.
  const wide = await page.evaluate(() => matchMedia("(min-width: 64rem)").matches);
  for (const selector of wide
    ? [".search-dock .search-field"]
    : [".search-dock .search-field", ".bar-search .search-field"]) {
    const { chrome, field, input, style } = await page.evaluate((fieldSelector) => {
      const rect = (element: Element | null) => {
        const { left, top, width, height } = (element as Element).getBoundingClientRect();
        return { left, top, width, height };
      };
      const fieldElement = document.querySelector(fieldSelector) as Element;
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
    }, selector);
    // The fill is the field, edge to edge, and unscaled, so its corners are the .control radius.
    for (const key of ["left", "top", "width", "height"] as const) {
      expect(chrome[key], `${selector}: fill ${key}`).toBeCloseTo(field[key], 0);
      expect(input[key], `${selector}: input ${key}`).toBeCloseTo(field[key], 0);
    }
    expect(style.transform, selector).toBe("none");
    expect(style.hidden, selector).toBe("true");
    expect(style.inputFill, `${selector}: the input shows the fill, not a fill of its own`).toBe("rgba(0, 0, 0, 0)");
    expect(style.chromeFill, `${selector}: the fill is drawn`).not.toBe("rgba(0, 0, 0, 0)");
  }
});

/**
 * Scrolls to `y` inside the page and, the moment the bar's field has been revealed or hidden (data-revealed
 * changes), reads what the browser is about to run for it, before a frame is drawn: the transitions on the bar's
 * copy of the field (their property and length), its computed transition length, and its opacity right then. That is
 * the start of the move whatever the speed of the browser, and under Reduce Motion it is the finished step.
 */
async function revealObserved(
  page: Page,
  y: number,
): Promise<{
  revealed: boolean;
  animations: { property: string; ms: number }[];
  duration: string;
  opacity: number;
}> {
  return page.evaluate(
    (top) =>
      new Promise((resolve, reject) => {
        const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
        const field = document.querySelector(".bar-search") as HTMLElement;
        const was = bar.hasAttribute("data-revealed");
        const timer = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error(`the bar's field did not change for ${top}`));
        }, 10_000);
        const observer = new MutationObserver(() => {
          if (bar.hasAttribute("data-revealed") === was) return;
          observer.disconnect();
          window.clearTimeout(timer);
          // Reading the animations lets the browser start the ones this change calls for, in this very frame.
          const animations = field.getAnimations().map((animation) => ({
            property: (animation as CSSTransition).transitionProperty,
            ms: Number(animation.effect?.getComputedTiming().duration),
          }));
          const style = getComputedStyle(field);
          resolve({
            revealed: !was,
            animations,
            duration: style.transitionDuration,
            opacity: Number.parseFloat(style.opacity),
          });
        });
        observer.observe(bar, { attributes: true, attributeFilter: ["data-revealed"] });
        window.scrollTo(0, top);
      }),
    y,
  );
}

test("search reveal: scrolling down keeps one field in the page and none in the bar", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const ys: number[] = [];
  for (let y = 0; y <= Math.min(offsets.limit, Math.ceil(offsets.revealFrom) + 300); y += 24) ys.push(y);
  const stops = await sweepDock(page, ys);
  for (const stop of stops) {
    // The hero's field rises 1:1 with the page, as ordinary content does...
    expect(stop.fieldTop, `at ${stop.y}`).toBeCloseTo(offsets.natural - stop.scrollY, 0);
    // ...and the bar's copy is not there: not revealed, not drawn.
    expect(stop.revealed, `at ${stop.y}`).toBe(false);
    expect(stop.barFieldOpacity, `at ${stop.y}`).toBe(0);
  }
  expect(
    stops.some((stop) => stop.shown === "true"),
    "the bar came up on the way",
  ).toBe(true);
  // Nothing in the bar takes a tap: at the middle of its slot the bar answers, not an input.
  const hit = await page.evaluate(() => {
    const slot = (document.querySelector(".bar-search") as HTMLElement).parentElement as HTMLElement;
    const box = slot.getBoundingClientRect();
    const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
    return { inBar: Boolean(element && bar.contains(element)), isInput: element instanceof HTMLInputElement };
  });
  expect(hit).toEqual({ inBar: true, isInput: false });
});

test("search reveal: scrolling up shows the field in the floating bar", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  // Short of REVEAL_UP_PX it stays hidden, whatever the finger does up to there; past it, it comes in.
  await scrollAndSettle(page, y0 - (REVEAL_UP_PX - 4));
  expect(await isRevealed(page), "4px short").toBe(false);
  await scrollAndSettle(page, y0 - (REVEAL_UP_PX + 4));
  await expectRevealed(page, true);
  await barFieldSettled(page);
  expect(
    await page.locator(".bar-search").evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
  ).toBe(1);
  // Keeps going up: it stays.
  await scrollAndSettle(page, y0 - 3 * REVEAL_UP_PX);
  expect(await isRevealed(page)).toBe(true);
});

test("search reveal: scrolling down again hides it", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  const low = y0 - 2 * REVEAL_UP_PX;
  await scrollAndSettle(page, low);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  // Short of HIDE_DOWN_PX it stays; past it, it goes.
  await scrollAndSettle(page, low + (HIDE_DOWN_PX - 4));
  expect(await isRevealed(page), "4px short").toBe(true);
  await scrollAndSettle(page, low + (HIDE_DOWN_PX + 4));
  await expectRevealed(page, false);
  await barFieldSettled(page);
  expect(
    await page.locator(".bar-search").evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
  ).toBe(0);
  expect(await page.locator(".bar-search").evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
});

test("search reveal: jitter and reversals do not flip it", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  // Every change of the bar's data-revealed from here on, in order.
  await page.evaluate(() => {
    const flips: boolean[] = [];
    (window as Window & { __flips?: boolean[] }).__flips = flips;
    const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
    let was = bar.hasAttribute("data-revealed");
    new MutationObserver(() => {
      const now = bar.hasAttribute("data-revealed");
      if (now !== was) flips.push(now);
      was = now;
    }).observe(bar, { attributes: true, attributeFilter: ["data-revealed"] });
  });
  const flips = () => page.evaluate(() => (window as Window & { __flips?: boolean[] }).__flips ?? []);
  const y0 = await scrollDeep(page, offsets);
  // Hidden: small steps up and down around the highest point, none of them REVEAL_UP_PX from it.
  for (const y of [y0 - 10, y0 + 6, y0 - 14, y0 + 8, y0 - 8, y0 + 2]) await scrollAndSettle(page, y);
  expect(await flips(), "jitter while hidden").toEqual([]);
  // A real scroll up reveals it once.
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  expect(await flips()).toEqual([true]);
  // Shown: steps down and up around the lowest point, none of them HIDE_DOWN_PX from it.
  const low = y0 - 2 * REVEAL_UP_PX;
  for (const y of [low + 6, low - 5, low + 5, low - 8, low + 2, low - 2]) await scrollAndSettle(page, y);
  expect(await flips(), "jitter while shown").toEqual([true]);
  // A real scroll down hides it once; a small step back up does not bring it back.
  await scrollAndSettle(page, low - 8 + HIDE_DOWN_PX + 4);
  await expectRevealed(page, false);
  await scrollAndSettle(page, low - 8 + HIDE_DOWN_PX + 4 - 10);
  expect(await isRevealed(page), "a step back up of 10px").toBe(false);
  expect(await flips()).toEqual([true, false]);
});

test("search reveal: back at the top there is only the hero's field, and never two together", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const { path } = await dockPath(page, 12);
  const stops = await sweepDock(page, path);
  const viewportHeight = page.viewportSize()?.height ?? 0;
  for (const stop of stops) {
    // The hero's field can be seen when its bottom edge is below the bar's and its top is on screen.
    const heroSeen = stop.fieldBottom > stop.barBottom + 1 && stop.fieldTop < viewportHeight;
    expect(heroSeen && stop.revealed, `both fields at ${stop.y}`).toBe(false);
  }
  expect(
    stops.some((stop) => stop.revealed),
    "the bar's field showed on the way back",
  ).toBe(true);
  expect(
    stops.some((stop) => stop.fieldBottom > stop.barBottom + 1 && !stop.revealed),
    "the hero's showed too",
  ).toBe(true);
  // At the top: the bar is down, nothing is revealed, and the bar's copy is not drawn once its fade has run.
  await scrollAndSettle(page, 0);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "false");
  expect(await isRevealed(page)).toBe(false);
  await barFieldSettled(page);
  expect(
    await page.locator(".bar-search").evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity)),
  ).toBe(0);
  expect(offsets.natural).toBeGreaterThan(0);
});

test("search reveal: back at the top with the bar's field focused, only one field is on screen", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  const bar = barSearch(page);
  await bar.evaluate((input) => (input as HTMLInputElement).focus({ preventScroll: true }));
  await expect(bar).toBeFocused();
  await page.keyboard.type("a");
  await expect(bar).toHaveValue("a");
  // Up the page in steps, with the bar's field focused and a query in it, to the top.
  const viewportHeight = page.viewportSize()?.height ?? 0;
  const path = [Math.ceil(offsets.revealFrom) + 60, Math.ceil(offsets.revealFrom) + 4, offsets.revealFrom - 4, 150, 0];
  for (const y of path.map((step) => Math.max(0, Math.round(step)))) {
    await scrollAndSettle(page, y);
    const seen = await page.evaluate(() => {
      const hero = document.querySelector('[data-search-input="hero"]') as HTMLElement;
      const field = document.querySelector(".search-dock .search-field") as HTMLElement;
      const barEl = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
      const box = field.getBoundingClientRect();
      return {
        revealed: barEl.hasAttribute("data-revealed"),
        fieldTop: box.top,
        fieldBottom: box.bottom,
        barBottom: barEl.getBoundingClientRect().bottom,
        heroTab: hero.tabIndex,
      };
    });
    const heroSeen = seen.fieldBottom > seen.barBottom + 1 && seen.fieldTop < viewportHeight;
    expect(heroSeen && seen.revealed, `both fields at ${y}`).toBe(false);
    // While the hero's field is in view it is in the Tab order, and the bar's copy has let go of focus.
    if (heroSeen) expect(seen.heroTab, `the hero's field is reachable at ${y}`).toBe(0);
  }
  await expectRevealed(page, false);
  await expect(bar).not.toBeFocused();
  // The hero's field keeps the query, and the bar is down again: nothing holds it up.
  await expect(heroSearch(page)).toHaveValue("a");
  await expect(controlBar(page)).toHaveAttribute("data-shown", "false");
});

test("search reveal: the revealed field takes the tap and the page behind it does not", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  const hit = () =>
    page.evaluate(() => {
      const input = document.querySelector('[data-search-input="bar"]') as HTMLElement;
      const box = input.getBoundingClientRect();
      const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
      return { isInput: element === input, inBar: Boolean(element && bar.contains(element)) };
    });
  // Hidden, it takes nothing: the tap lands on the bar (or, where the bar has nothing, the page), never the input.
  expect((await hit()).isInput, "hidden").toBe(false);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  expect(await hit(), "revealed").toEqual({ isInput: true, inBar: true });
  // Hidden again, it gives the tap back.
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX + 2 * HIDE_DOWN_PX);
  await expectRevealed(page, false);
  await barFieldSettled(page);
  expect((await hit()).isInput, "hidden again").toBe(false);
});

test("search reveal: opens a page that is already scrolled past the field with the bar's field hidden, and plays no move", async ({
  page,
  browserName,
}) => {
  test.slow();
  // Every transition that starts on the bar's field, from before the page's own script runs. And where the page was
  // when the browser left it. Chromium's headless shell (the build CI runs) switches the emulated touch screen off as
  // a navigation starts, before the page's own pagehide, so a page whose layout has touch-only sizes (the lede's
  // links are 44px targets on a touch screen and 19px lines without one) shrinks while it is being left: the
  // browser's scroll anchoring moves the position with it, and the router snapshots that position (TanStack's, in
  // pagehide) and restores it. So what the reload restores is where the page was left, which is not always the
  // place the test scrolled to.
  await page.addInitScript(() => {
    const runs: string[] = [];
    (window as Window & { __runs?: string[] }).__runs = runs;
    document.addEventListener(
      "transitionrun",
      (event) => {
        if ((event.target as Element).closest(".bar-search")) runs.push(`${event.propertyName}`);
      },
      true,
    );
    window.addEventListener(
      "pagehide",
      () => {
        try {
          sessionStorage.setItem("e2e:left-at", String(window.scrollY));
        } catch {}
      },
      true,
    );
  });
  // The reload draws the server's own first render, the canned payloads' board, whatever board a test served to the
  // page (a served board reaches the page only by a refetch, and its hero is not the first render's), so this test
  // opens that same board, and the position it leaves is measured on it. Inter is font-display: optional, so a page
  // view is drawn in Inter only if the file is ready at its first render, a race with the preview that would make
  // the view that leaves a position and the one that restores it differ in the lede's wrap and so in the page's
  // height. On Chromium both views are therefore drawn in the system font: the first has the Inter file refused,
  // the reload has it held until the restored position has been read, then let in (it is cached and never swapped
  // in, so nothing moves under the restored position). WebKit restores at the end of the load, which waits for the
  // font, so there is no race to order there and the font is left alone.
  type FontMode = "pass" | "refuse" | "hold";
  let fontMode: FontMode = browserName === "chromium" ? "refuse" : "pass";
  let releaseFont = () => {};
  const fontHeld = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  await page.route("**/inter-var*.woff2", async (route) => {
    if (fontMode === "refuse") return route.abort();
    if (fontMode === "hold") await fontHeld;
    await route.continue().catch(() => {});
  });
  const offsets = await revealBoard(page);
  await scrollDeep(page, offsets);
  // Back to the same place the way a reload or a return to the tab does: the browser restores the scroll.
  fontMode = browserName === "chromium" ? "hold" : "pass";
  try {
    // The held font keeps the load event from firing; the position is restored without waiting for it.
    await page.reload({ waitUntil: fontMode === "hold" ? "domcontentloaded" : "load" });
    // Where the old page was left (see the init script): still well past the field, and what the reload must restore.
    const leftAt = Number(await page.evaluate(() => sessionStorage.getItem("e2e:left-at")));
    expect(leftAt, "the page was left past the field").toBeGreaterThan(offsets.revealFrom + DOCK_HYSTERESIS);
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { message: "the browser restores the position" })
      .toBeGreaterThan(leftAt - 40);
  } finally {
    releaseFont();
  }
  await page.waitForLoadState("load");
  await hydrated(page);
  await leadSteady(page);
  await fontsSettled(page);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  // The reader is where the restored page is now.
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  // It opens hidden, and nothing about it moved.
  expect(await isRevealed(page)).toBe(false);
  const runs = () => page.evaluate(() => (window as Window & { __runs?: string[] }).__runs ?? []);
  expect(await runs(), "the field's move played on load").toEqual([]);
  // The first real scroll up after the load reveals it, and that one is a move.
  await scrollAndSettle(page, (await page.evaluate(() => window.scrollY)) - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await expect.poll(async () => (await runs()).length, { message: "the reveal plays" }).toBeGreaterThan(0);
});

test("search reveal: takes the pose a scroll gives it before the page has loaded without playing a move", async ({
  page,
}) => {
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
        if ((event.target as Element).closest(".bar-search")) runs.push(`${event.propertyName}`);
      },
      true,
    );
    new Image().src = "/__held.png";
  });
  // Well inside a slot, as steadyBoard has it; the load is held open here, so the page is not waited for.
  await pinToSlot(page);
  await page.goto("/", { waitUntil: "commit" });
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await leadSteady(page);
  expect(await page.evaluate(() => document.readyState), "the load is still open").not.toBe("complete");
  const offsets = await dockOffsets(page);
  test.skip(offsets.wide, "from 64rem there is no field in the bar");
  const deep = Math.ceil(offsets.revealFrom) + 400;
  await page.evaluate((to) => window.scrollTo(0, to), deep);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  // Before the load has finished a scroll is a restored position, not a direction: even a scroll up reveals nothing.
  await page.evaluate((to) => window.scrollTo(0, to), deep - 3 * REVEAL_UP_PX);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  expect(await isRevealed(page)).toBe(false);
  const played = () => page.evaluate(() => (window as Window & { __runs?: string[] }).__runs ?? []);
  expect(await played(), "the field's move played before the load").toEqual([]);
  release();
  await page.waitForLoadState("load");
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  // Armed, the page is where the restored scroll left it, with nothing revealed and nothing played; the baseline is
  // here, so the next scroll up counts from here.
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  expect(await isRevealed(page)).toBe(false);
  expect(await played(), "the field's move played on load").toEqual([]);
  await scrollAndSettle(page, deep - 6 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await expect
    .poll(async () => (await played()).length, { message: "the reveal plays after the load" })
    .toBeGreaterThan(0);
});

test("search reveal: the revealed field keeps still when the bar's lead text changes", async ({ page }) => {
  test.slow();
  // A served board, as in the 'mirrors the query' and 'layout alone' tests: the live board's cards change height with
  // what the vendors say that day, and the Refresh below fetches it again, so a card that grew or shrank moved the
  // page (its height, and on WebKit the scroll position, which follows it) under this test's checks of the field.
  const offsets = await revealServedBoard(page, calmBoard, { id: "aws", label: "Operational" });
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  // From here on, everything that could start a transition on the bar's field, and the field's box in every frame.
  // Refreshing changes the bar's lead text ("Checking..."), which from 40rem sits in the flow before the slot: the
  // lead has a width of its own, so the slot, and the field in it, stay where they are. The field's CSS transition
  // starts only when the bar's data-revealed flips (opacity and translate both follow it), and that follows the
  // dock store's `revealed`, which only a scroll the rule reads, or heroAway / barShown turning off, can flip. So
  // the page also keeps a log of those: the marks on the bar and on the field's wrapper (data-revealed, data-shown,
  // inert), every scroll event with its position, the page's height, and each transition that runs anywhere in the
  // bar, with its target. A failure prints the log, which says which of them moved first.
  await page.evaluate(() => {
    type Tracked = Window & {
      __runs?: string[];
      __log?: string[];
      __boxes?: { left: number; width: number }[];
      __watching?: boolean;
    };
    const tracked = window as Tracked;
    const runs: string[] = [];
    const log: string[] = [];
    const boxes: { left: number; width: number }[] = [];
    const t0 = performance.now();
    const stamp = () => `${(performance.now() - t0).toFixed(0)}ms`;
    tracked.__runs = runs;
    tracked.__log = log;
    tracked.__boxes = boxes;
    tracked.__watching = true;
    const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}`;
    document.addEventListener(
      "transitionrun",
      (event) => {
        const target = event.target as Element;
        if (!bar.contains(target)) return;
        log.push(`${stamp()} transitionrun ${event.propertyName} on ${describe(target)}`);
        if (target.closest(".bar-search")) runs.push(event.propertyName);
      },
      true,
    );
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as Element;
        log.push(
          `${stamp()} ${record.attributeName}=${JSON.stringify(target.getAttribute(record.attributeName as string))} on ${describe(target)}`,
        );
      }
    }).observe(bar, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-revealed", "data-shown", "inert", "data-state"],
    });
    let height = document.documentElement.scrollHeight;
    window.addEventListener("scroll", () => log.push(`${stamp()} scroll to ${window.scrollY}`), { passive: true });
    const input = document.querySelector('[data-search-input="bar"]') as HTMLElement;
    const watch = () => {
      const box = input.getBoundingClientRect();
      boxes.push({ left: box.left, width: box.width });
      if (document.documentElement.scrollHeight !== height) {
        log.push(`${stamp()} page height ${height} -> ${document.documentElement.scrollHeight}`);
        height = document.documentElement.scrollHeight;
      }
      if (tracked.__watching) requestAnimationFrame(watch);
    };
    watch();
  });
  const refresh = controlBar(page).getByRole("button", { name: "Refresh status now" });
  await pressRefresh(page, refresh);
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  const { runs, log, boxes } = await page.evaluate(() => {
    const tracked = window as Window & {
      __runs?: string[];
      __log?: string[];
      __boxes?: { left: number; width: number }[];
      __watching?: boolean;
    };
    tracked.__watching = false;
    return {
      runs: tracked.__runs ?? [],
      log: tracked.__log ?? [],
      boxes: tracked.__boxes ?? [],
    };
  });
  const story = `\n${log.join("\n")}`;
  // The marks the field's state is written to, and the position, never moved: the lead's text is "data-state" and is
  // the only mark that may change.
  expect(
    log.filter((line) => /(data-revealed|data-shown|inert)=|scroll to|page height/.test(line)),
    `the field's state or the page's position moved${story}`,
  ).toEqual([]);
  expect(runs, `the field moved when its slot changed${story}`).toEqual([]);
  expect(boxes.length).toBeGreaterThan(3);
  const lefts = boxes.map((box) => box.left);
  const widths = boxes.map((box) => box.width);
  expect(Math.max(...lefts) - Math.min(...lefts), "the field's left edge").toBeLessThanOrEqual(0.5);
  expect(Math.max(...widths) - Math.min(...widths), "the field's width").toBeLessThanOrEqual(0.5);
  expect(await isRevealed(page)).toBe(true);
});

test("search reveal: a reorder above the reader that keeps the board's height does not flip the field", async ({
  page,
}) => {
  test.slow();
  const offsets = await revealBoard(page);
  // A tall block after the last card, so that there are cards above the viewport whatever the board holds (offline
  // it is short). It is also what gives the 40px back below.
  await page.evaluate(() => {
    const filler = document.createElement("div");
    filler.id = "test-filler";
    filler.style.height = "2400px";
    document.getElementById("services")?.appendChild(filler);
  });
  await expect.poll(() => maxScroll(page)).toBeGreaterThan(offsets.limit + 2000);
  const y0 = offsets.revealFrom + 1000;
  await scrollAndSettle(page, y0);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  expect(await isRevealed(page)).toBe(false);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  await page.evaluate(() => {
    const tracked = window as Window & { __flips?: boolean[] };
    const flips: boolean[] = [];
    tracked.__flips = flips;
    const bar = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
    let was = bar.hasAttribute("data-revealed");
    new MutationObserver(() => {
      const now = bar.hasAttribute("data-revealed");
      if (now !== was) flips.push(now);
      was = now;
    }).observe(bar, { attributes: true, attributeFilter: ["data-revealed"] });
  });
  // A card above the viewport gains 40px and the block after the last card gives 40px back, in one style change: the board
  // reorders above the reader's anchor and its total height stays the same, so nothing resizes for the dock to
  // notice. Where the browser anchors scrolling, it moves the page by the shift; the dock must not read it as the
  // reader (which would hide the revealed field, a scroll down of 40px, with no input).
  const shifted = await page.evaluate(
    () =>
      new Promise<{ before: number; after: number; heightBefore: number; heightAfter: number; anchors: boolean }>(
        (resolve, reject) => {
          const all = [...document.querySelectorAll<HTMLElement>('article[id^="service-"]')];
          const above = all.filter((card) => card.getBoundingClientRect().bottom < 0).at(-1);
          const filler = document.getElementById("test-filler");
          if (!above || !filler) {
            reject(new Error("no card to shift"));
            return;
          }
          const before = window.scrollY;
          const heightBefore = document.documentElement.scrollHeight;
          above.style.marginTop = "40px";
          filler.style.height = "2360px";
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                resolve({
                  before,
                  after: window.scrollY,
                  heightBefore,
                  heightAfter: document.documentElement.scrollHeight,
                  anchors:
                    CSS.supports("overflow-anchor", "auto") &&
                    getComputedStyle(document.documentElement).overflowAnchor !== "none",
                }),
              ),
            ),
          );
        },
      ),
  );
  expect(shifted.heightAfter, "the board's height is unchanged").toBe(shifted.heightBefore);
  // Chromium and Firefox anchor, so the page really moved by the shift; where the browser does not, there is no
  // adjustment to read and the field must still be where it was.
  if (shifted.anchors)
    expect(Math.abs(shifted.after - shifted.before), "the page was moved by the browser").toBeGreaterThan(20);
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  expect(await isRevealed(page), "the revealed field stayed").toBe(true);
  expect(
    await page.evaluate(() => (window as Window & { __flips?: boolean[] }).__flips ?? []),
    "data-revealed did not change",
  ).toEqual([]);
  // The reader's own scroll counts from here: HIDE_DOWN_PX down still hides it.
  const here = await page.evaluate(() => window.scrollY);
  await scrollAndSettle(page, here + HIDE_DOWN_PX + 4);
  await expectRevealed(page, false);
});

test("search reveal: the bar's verdict gives way while the field is revealed and returns when it hides", async ({
  page,
}) => {
  test.slow();
  const offsets = await revealBoard(page);
  test.skip((page.viewportSize()?.width ?? 0) >= 640, "the verdict only gives way to the field under 640px");
  const opacity = () =>
    page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.querySelector("[data-bar-verdict]") as Element).opacity),
    );
  const verdictSettled = () =>
    page.evaluate(() =>
      Promise.allSettled(
        (document.querySelector("[data-bar-verdict]") as Element)
          .getAnimations()
          .map((animation) => animation.finished),
      ),
    );
  const y0 = await scrollDeep(page, offsets);
  await barSettled(page);
  expect(await opacity(), "the verdict shows while the field is hidden").toBe(1);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await verdictSettled();
  expect(await opacity(), "and is gone while the field shows").toBe(0);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX + 2 * HIDE_DOWN_PX);
  await expectRevealed(page, false);
  await verdictSettled();
  expect(await opacity(), "it returns when the field hides").toBe(1);
});

test("search reveal: the bar's copy of the field always has the short placeholder", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const bar = barSearch(page);
  const short = "Search…";
  const placeholders = async () => ({
    bar: await bar.getAttribute("placeholder"),
    hero: await heroSearch(page).getAttribute("placeholder"),
  });
  // At rest, scrolled down, revealed and hidden again: the bar's is the same text, so it never changes under the eye.
  const seen = [(await placeholders()).bar];
  const y0 = await scrollDeep(page, offsets);
  seen.push((await placeholders()).bar);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  seen.push((await placeholders()).bar);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX + 2 * HIDE_DOWN_PX);
  await expectRevealed(page, false);
  seen.push((await placeholders()).bar);
  expect(seen).toEqual([short, short, short, short]);
  // The hero's keeps its own rule: the long text where there is room for it at rest, and it does not follow the scroll.
  const hero = (await placeholders()).hero;
  expect(["Search GCP, CS2 Europe, RouterOS…", short]).toContain(hero);
  await scrollAndSettle(page, 0);
  expect((await placeholders()).hero).toBe(hero);
});

test("never clips the search placeholder, at any width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const search = heroSearch(page);
  const bar = barSearch(page);
  const long = "Search GCP, CS2 Europe, RouterOS…";
  /** The placeholder's text against the room the input has for it. */
  const room = (input: Locator) =>
    input.evaluate((element: HTMLInputElement) => {
      const style = getComputedStyle(element);
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font}`;
      probe.textContent = element.placeholder;
      document.body.appendChild(probe);
      const text = probe.getBoundingClientRect().width;
      probe.remove();
      return {
        text,
        room: element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
      };
    });
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
    const hero = await room(search);
    expect(hero.text, `the placeholder fits the field at ${width}px`).toBeLessThanOrEqual(hero.room);
    // The bar's copy, where there is one (below 64rem), has the short text in a slot of 134px at 320px wide.
    if (width < 1024) {
      await expect(bar, `the bar's placeholder at ${width}px`).toHaveAttribute("placeholder", "Search…");
      const copy = await room(bar);
      expect(copy.room, `the bar's field has room at ${width}px`).toBeGreaterThan(0);
      expect(copy.text, `the bar's placeholder fits its field at ${width}px`).toBeLessThanOrEqual(copy.room);
    }
  }
});

// A served board, not the live one, with room to stand on and no scroll anchoring: what "ab" leaves of the page
// depends on what the vendors say that day, and on CI (with the network) it was the page's end, or the browser's
// scroll anchoring, that decided whether the page stayed behind the hero's field. Here it does, so that the bar's
// field is the one being typed in (the test after this one is the layout putting the hero's field back in view).
test("search reveal: mirrors the query in both fields and keeps focus, text and caret in the one being typed in", async ({
  page,
}) => {
  test.slow();
  const offsets = await revealServedBoard(page, calmBoard, { id: "aws", label: "Operational" });
  await page.addStyleTag({
    content: ".board-body { min-height: 3000px !important; } * { overflow-anchor: none !important; }",
  });
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  const bar = barSearch(page);
  const hero = heroSearch(page);
  await bar.evaluate((input) => {
    (input as HTMLInputElement & { dockMark?: string }).dockMark = "the bar's input";
  });
  await bar.evaluate((input) => (input as HTMLInputElement).focus({ preventScroll: true }));
  await page.keyboard.type("ab");
  await expect(bar).toHaveValue("ab");
  await expect(hero).toHaveValue("ab");
  // Caret into the middle of the bar's text, and one more character typed there.
  await bar.evaluate((input) => (input as HTMLInputElement).setSelectionRange(1, 1));
  await page.keyboard.type("c");
  await expect(bar).toHaveValue("acb");
  await expect(hero).toHaveValue("acb");
  const state = () =>
    page.evaluate(() => {
      const barInput = document.querySelector('[data-search-input="bar"]') as HTMLInputElement & { dockMark?: string };
      const heroInput = document.querySelector('[data-search-input="hero"]') as HTMLInputElement;
      return {
        focusedIsBar: document.activeElement === barInput,
        mark: (document.activeElement as (HTMLInputElement & { dockMark?: string }) | null)?.dockMark,
        barCaret: barInput.selectionStart,
        barValue: barInput.value,
        heroValue: heroInput.value,
        heroFocused: document.activeElement === heroInput,
        inputs: document.querySelectorAll('input[type="search"]').length,
      };
    });
  // The copy is updated, the one being typed in keeps focus, its text and its caret (after the "c").
  expect(await state()).toEqual({
    focusedIsBar: true,
    mark: "the bar's input",
    barCaret: 2,
    barValue: "acb",
    heroValue: "acb",
    heroFocused: false,
    inputs: 2,
  });
  // The filter is applied once, from the one value.
  await expect(page).toHaveURL(/q=acb/);
});

/** What is on screen of the two search fields, and which of them has focus. */
async function fieldsNow(page: Page) {
  return page.evaluate(() => {
    const hero = document.querySelector('[data-search-input="hero"]') as HTMLInputElement;
    const field = document.querySelector(".search-dock .search-field") as HTMLElement;
    const barEl = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
    const active = document.activeElement as HTMLElement | null;
    const box = field.getBoundingClientRect();
    return {
      active: active?.dataset.searchInput ?? active?.tagName ?? null,
      revealed: barEl.hasAttribute("data-revealed"),
      shown: barEl.getAttribute("data-shown"),
      heroSeen: box.bottom > barEl.getBoundingClientRect().bottom + 1 && box.top < window.innerHeight,
      heroTab: hero.tabIndex,
      heroCaret: [hero.selectionStart, hero.selectionEnd],
    };
  });
}

test("search reveal: when the layout alone puts the hero's field back in view, the typing moves to it", async ({
  page,
}) => {
  test.slow();
  const offsets = await revealServedBoard(page, calmBoard, { id: "aws", label: "Operational" });
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  const bar = barSearch(page);
  const hero = heroSearch(page);
  // A board that gives the page nothing to stand on once the filter has taken its cards away: the page ends up
  // above the line where the hero's field is behind the bar, however the browser then moves it (it clamps it
  // to the new end; Chromium's scroll anchoring may take it further). The reader did not scroll.
  await page.addStyleTag({
    content: ".board-body { min-height: 0 !important; } .board-body footer { display: none !important; }",
  });
  await bar.evaluate((input) => (input as HTMLInputElement).focus({ preventScroll: true }));
  await page.keyboard.type("ab");
  await expect
    .poll(() => page.evaluate(() => window.scrollY), "the filter took the page above the hero's field")
    .toBeLessThan(offsets.revealFrom);
  // The reader is still typing, and the two fields are not on screen together: the focus, the text and the caret
  // went to the hero's field, which is reachable again, and the bar is down.
  await expect(hero).toBeFocused();
  await expect(hero).toHaveValue("ab");
  await expect(bar).toHaveValue("ab");
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  expect(await fieldsNow(page)).toEqual({
    active: "hero",
    revealed: false,
    shown: "false",
    heroSeen: true,
    heroTab: 0,
    heroCaret: [2, 2],
  });
  await page.keyboard.type("c");
  await expect(hero).toHaveValue("abc");
  await expect(bar).toHaveValue("abc");
  // Nothing finds the page held by the bar's field any more, with results, with none, or with the search cleared.
  await page.keyboard.type("zzzzq");
  await expect(hero).toHaveValue("abczzzzq");
  await expect(hero).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(hero).toHaveValue("");
  await expect(hero).toBeFocused();
  const cleared = await fieldsNow(page);
  expect(cleared).toMatchObject({ revealed: false, shown: "false", heroSeen: true, heroTab: 0 });
});

test("search reveal: the reader's scroll up to the hero lets the bar's field go, whatever else the page does", async ({
  page,
}) => {
  test.slow();
  const offsets = await revealServedBoard(page, calmBoard, { id: "aws", label: "Operational" });
  await page.addStyleTag({ content: ".board-body { min-height: 3000px !important; }" });
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  const bar = barSearch(page);
  await bar.evaluate((input) => (input as HTMLInputElement).focus({ preventScroll: true }));
  await page.keyboard.type("a");
  await expect(bar).toHaveValue("a");
  await scrollAndSettle(page, Math.ceil(offsets.revealFrom) + 40);
  await expectRevealed(page, true);
  // In the frame the reader scrolls up past the hero's field the page also gets 2px longer (a row of Recent changes,
  // the live line): the reader's travel is not the layout's, and the bar's field is let go of as it would be alone.
  await page.evaluate(
    (top) =>
      new Promise<void>((resolve) => {
        document.body.style.paddingBottom = "2px";
        window.scrollTo(0, top);
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }),
    Math.max(0, Math.floor(offsets.revealFrom) - 30),
  );
  await expect(bar).not.toBeFocused();
  expect(await fieldsNow(page)).toMatchObject({
    active: "BODY",
    revealed: false,
    heroSeen: true,
    heroTab: 0,
  });
  await expect(heroSearch(page)).toHaveValue("a");
});

// An iPad turned between upright and sideways crosses 64rem (the lg breakpoint) with the reader's hand in a field:
// the field that was in use is hidden or out of reach in the other layout, so the typing goes to the one that is not.
// Served board, room to stand on and no scroll anchoring, as above; each test opens the page at the width it starts at.
const UPRIGHT = { width: 820, height: 900 };
const SIDEWAYS = { width: 1280, height: 900 };

/** Opens the served board at one size (and motion setting), armed, with room to scroll. */
async function openCrossingBoard(page: Page, view: { width: number; height: number }, reduced: boolean): Promise<void> {
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.setViewportSize(view);
  await pinToSlot(page);
  await openFixture(page, () => calmBoard(Date.now()), { id: "aws", label: "Operational" });
  await leadSteady(page);
  await expect(searchDock(page)).toHaveAttribute("data-armed", "");
  await page.addStyleTag({
    content: ".board-body { min-height: 3000px !important; } * { overflow-anchor: none !important; }",
  });
}

/** Turns the device: resizes the viewport across 64rem and lets three frames pass. */
async function turnTo(page: Page, view: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(view);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      ),
  );
}

/** Types "abc" into the field in `focusable`, which gets focus, and selects the "b" backwards: a caret to carry over. */
async function typeAndSelect(field: Locator): Promise<void> {
  await field.evaluate((input) => (input as HTMLInputElement).focus({ preventScroll: true }));
  await field.page().keyboard.type("abc");
  await field.evaluate((input) => (input as HTMLInputElement).setSelectionRange(1, 2, "backward"));
}

/** Both search fields, as a reader would find them: which has focus, what they hold and whether they can be used. */
async function searchFields(page: Page) {
  return page.evaluate(() => {
    const hero = document.querySelector('[data-search-input="hero"]') as HTMLInputElement;
    const bar = document.querySelector('[data-search-input="bar"]') as HTMLInputElement;
    const section = document.querySelector('section[aria-label="Board controls"]') as HTMLElement;
    const active = document.activeElement as HTMLElement | null;
    const reachable = (input: HTMLInputElement) =>
      input.closest("[inert]") === null && input.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const onScreen = (input: HTMLInputElement) => {
      const box = input.getBoundingClientRect();
      return box.width > 0 && box.bottom > 0 && box.top < window.innerHeight;
    };
    const selection = (input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection];
    return {
      active: active?.dataset?.searchInput ?? active?.tagName ?? null,
      wide: matchMedia("(min-width: 64rem)").matches,
      scrollY: window.scrollY,
      heroValue: hero.value,
      barValue: bar.value,
      heroSelection: selection(hero),
      barSelection: selection(bar),
      heroOnScreen: onScreen(hero),
      heroReachable: reachable(hero),
      barReachable: reachable(bar),
      barRevealed: section.hasAttribute("data-revealed"),
      barShown: section.getAttribute("data-shown"),
    };
  });
}

for (const reduced of [false, true]) {
  const motion = reduced ? ", under Reduce Motion" : "";

  test(`search reveal: turning sideways with the bar's field in use moves the typing to the docked field${motion}`, async ({
    page,
  }) => {
    test.slow();
    await openCrossingBoard(page, UPRIGHT, reduced);
    const offsets = await dockOffsets(page);
    const y0 = await scrollDeep(page, { ...offsets, limit: await maxScroll(page) });
    await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
    await expectRevealed(page, true);
    await barFieldSettled(page);
    await typeAndSelect(barSearch(page));
    await expect(barSearch(page)).toBeFocused();
    await turnTo(page, SIDEWAYS);
    // The bar's copy is hidden in the wide layout (lg:hidden): the docked field has the focus, the text and the caret.
    await expect(heroSearch(page)).toBeFocused();
    expect(await searchFields(page)).toMatchObject({
      active: "hero",
      wide: true,
      heroValue: "abc",
      barValue: "abc",
      heroSelection: [1, 2, "backward"],
      heroOnScreen: true,
      heroReachable: true,
      barRevealed: false,
    });
    expect(await dockValue(page)).toBe(1);
    // Typing goes on where the caret was: the selected "b" is replaced.
    await page.keyboard.type("d");
    await expect(heroSearch(page)).toHaveValue("adc");
    await expect(barSearch(page)).toHaveValue("adc");
  });

  test(`search reveal: turning upright with the docked field in use moves the typing to the bar's, which is revealed${motion}`, async ({
    page,
  }) => {
    test.slow();
    await openCrossingBoard(page, SIDEWAYS, reduced);
    const y = 900;
    await scrollAndSettle(page, y);
    expect(await dockValue(page)).toBe(1);
    await typeAndSelect(heroSearch(page));
    await expect(heroSearch(page)).toBeFocused();
    await turnTo(page, UPRIGHT);
    // Upright, the hero's field is far above the page's position: the bar's copy is the one in reach.
    const upright = await dockOffsets(page);
    expect(y, "the page is past the hero's field in the upright layout").toBeGreaterThan(
      upright.revealFrom + DOCK_HYSTERESIS,
    );
    await expect(barSearch(page)).toBeFocused();
    await barFieldSettled(page);
    expect(await searchFields(page)).toMatchObject({
      active: "bar",
      wide: false,
      heroValue: "abc",
      barValue: "abc",
      barSelection: [1, 2, "backward"],
      barReachable: true,
      barRevealed: true,
      barShown: "true",
    });
    await page.keyboard.type("d");
    await expect(barSearch(page)).toHaveValue("adc");
    await expect(heroSearch(page)).toHaveValue("adc");
    // And it stays: the field in use is not let go of by the frames after the turn.
    await scrollAndSettle(page, y);
    await expect(barSearch(page)).toBeFocused();
    await expectRevealed(page, true);
  });
}

test("search reveal: turning sideways at the top of the page keeps the typing in the hero's field", async ({
  page,
}) => {
  test.slow();
  await openCrossingBoard(page, UPRIGHT, false);
  await typeAndSelect(heroSearch(page));
  await turnTo(page, SIDEWAYS);
  await expect(heroSearch(page)).toBeFocused();
  expect(await searchFields(page)).toMatchObject({
    active: "hero",
    wide: true,
    heroValue: "abc",
    heroSelection: [1, 2, "backward"],
    heroOnScreen: true,
    barRevealed: false,
    scrollY: 0,
  });
  await page.keyboard.type("d");
  await expect(heroSearch(page)).toHaveValue("adc");
});

test("search reveal: turning upright at the top of the page keeps the typing in the hero's field, in view", async ({
  page,
}) => {
  test.slow();
  await openCrossingBoard(page, SIDEWAYS, false);
  await typeAndSelect(heroSearch(page));
  await turnTo(page, UPRIGHT);
  await expect(heroSearch(page)).toBeFocused();
  const upright = await searchFields(page);
  expect(upright).toMatchObject({
    active: "hero",
    wide: false,
    heroValue: "abc",
    heroSelection: [1, 2, "backward"],
    heroOnScreen: true,
    barRevealed: false,
    barReachable: false,
    scrollY: 0,
  });
  await page.keyboard.type("d");
  await expect(heroSearch(page)).toHaveValue("adc");
  await expect(barSearch(page)).toHaveValue("adc");
  expect(await searchFields(page)).toMatchObject({ active: "hero", barRevealed: false, barReachable: false });
});

test("search reveal: turning the device takes no focus when neither search field has it", async ({ page }) => {
  test.slow();
  await openCrossingBoard(page, SIDEWAYS, false);
  await scrollAndSettle(page, 900);
  // The Refresh that loaded the served board is still focused: let go, so that nothing is.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await turnTo(page, UPRIGHT);
  await barFieldSettled(page);
  expect(await searchFields(page)).toMatchObject({ active: "BODY", wide: false, barRevealed: false });
  await turnTo(page, SIDEWAYS);
  expect(await searchFields(page)).toMatchObject({ active: "BODY", wide: true, barRevealed: false });
  // Nor does it leave the dock or the bar in a state a scroll has to repair: a scroll up upright reveals as usual.
  await turnTo(page, UPRIGHT);
  const y = await page.evaluate(() => window.scrollY);
  await scrollAndSettle(page, y - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  expect((await searchFields(page)).active).toBe("BODY");
});

test("search reveal: a query typed in the hero's field shows in the bar's, which then stays revealed", async ({
  page,
}) => {
  test.slow();
  const offsets = await revealBoard(page);
  await heroSearch(page).fill("a");
  await heroSearch(page).blur();
  const limit = await maxScroll(page);
  const y = Math.min(Math.ceil(offsets.revealFrom) + 120, limit);
  await scrollAndSettle(page, y);
  await expect(barSearch(page)).toHaveValue("a");
  // The field is shown as soon as the hero's is behind the bar, without a scroll up: a filter is applied.
  await expectRevealed(page, true);
});

test("search reveal: a focused field is never hidden", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  const bar = barSearch(page);
  await bar.evaluate((input) => (input as HTMLInputElement).focus({ preventScroll: true }));
  await expect(bar).toBeFocused();
  // Well beyond HIDE_DOWN_PX of travel down: a field in use stays.
  await scrollAndSettle(page, y0 + 150);
  expect(await isRevealed(page), "while focused").toBe(true);
  await expect(bar).toBeFocused();
  // It does not hide when focus leaves either: tapping outside the field would make it vanish. Hide takes travel.
  const here = await page.evaluate(() => window.scrollY);
  await bar.evaluate((input) => (input as HTMLInputElement).blur());
  await scrollAndSettle(page, here);
  expect(await isRevealed(page), "right after blur").toBe(true);
  await scrollAndSettle(page, here + HIDE_DOWN_PX - 4);
  expect(await isRevealed(page), "short of HIDE_DOWN_PX after blur").toBe(true);
  await scrollAndSettle(page, here + HIDE_DOWN_PX + 4);
  await expectRevealed(page, false);
});

test("search reveal: a field with a query written in it stays revealed until the query is cleared", async ({
  page,
}) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barFieldSettled(page);
  const bar = barSearch(page);
  await bar.evaluate((input) => (input as HTMLInputElement).focus({ preventScroll: true }));
  await page.keyboard.type("a");
  await expect(bar).toHaveValue("a");
  await bar.evaluate((input) => (input as HTMLInputElement).blur());
  // The results shrink the page; go down as far as it now lets us, with room left below for the scroll further down.
  const down = Math.max(0, Math.min((await maxScroll(page)) - 60, y0 + 100));
  await scrollAndSettle(page, down);
  expect(await isRevealed(page), "scrolled down with a query").toBe(true);
  // Cleared, the field is let go of from here: it does not flip at once, and a scroll down then takes it away.
  await bar.fill("");
  await bar.evaluate((input) => (input as HTMLInputElement).blur());
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  expect(await isRevealed(page), "right after the query is cleared").toBe(true);
  const here = await page.evaluate(() => window.scrollY);
  await scrollAndSettle(page, here + HIDE_DOWN_PX + 4);
  await expectRevealed(page, false);
});

for (const [name, board, ready] of [
  ["with services to look at", fixtureBoard, { id: "aws", label: "Outage" }],
  ["on a calm board", calmBoard, { id: "aws", label: "Operational" }],
] as const) {
  test(`search reveal: keeps a revealed field revealed, and the page tall enough, when a search leaves almost nothing to scroll (${name})`, async ({
    page,
  }) => {
    await openFixture(page, () => board(Date.now()), ready);
    await expect(cards(page)).toHaveCount(SERVICES);
    await expect(searchDock(page)).toHaveAttribute("data-armed", "");
    const offsets = await dockOffsets(page);
    test.skip(offsets.wide, "from 64rem the field shares a row with the chips and there is no copy of it in the bar");
    const limit = await maxScroll(page);
    const deep = Math.min(Math.ceil(offsets.revealFrom) + 200, limit - 40);
    await scrollAndSettle(page, deep);
    await scrollAndSettle(page, deep - 2 * REVEAL_UP_PX);
    await expectRevealed(page, true);

    await barSearch(page).fill("zzzzqq");
    await expect(cards(page)).toHaveCount(0);
    await barSearch(page).blur();
    // The page has to stay tall enough to hold the field in the bar: the hero's field stays behind it.
    await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
    expect(await maxScroll(page)).toBeGreaterThan(offsets.revealFrom + DOCK_HYSTERESIS);
    await expectRevealed(page, true);
    await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  });
}

test("search reveal: puts the revealed field inside the bar, between its dot and its buttons", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const bar = controlBar(page);
  await expect(bar).toHaveAttribute("data-shown", "false");
  // In the hero it sits below the summary.
  const before = await page.locator(".search-dock .search-field").boundingBox();
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barSettled(page);
  await barFieldSettled(page);

  const boxes = await page.evaluate(() => {
    const rect = (element: Element | null) => {
      const { left, right, top, bottom } = (element as Element).getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const bar = document.querySelector('section[aria-label="Board controls"]');
    return {
      bar: rect(bar),
      field: rect(document.querySelector(".bar-search .search-field")),
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
  // The hero's field was below the bar, where the page puts it.
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

test("search reveal: Shift+Tab reaches the field from the bar's buttons without moving the page, and the hero's field is out of the way", async ({
  page,
}) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  await barSettled(page);
  const bar = controlBar(page);
  const refresh = bar.getByRole("button", { name: "Refresh status now" });
  await refresh.evaluate((button) => (button as HTMLElement).focus({ preventScroll: true }));
  // The field is before the buttons in the bar (Notifications, where the browser has them, then Refresh): going
  // back never leaves the bar for the hero's controls far above, and focus shows the field.
  for (let press = 0; press < 3; press++) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate(() => document.activeElement?.closest('section[aria-label="Board controls"]') !== null),
      "still in the bar",
    ).toBe(true);
    if (await barSearch(page).evaluate((input) => input === document.activeElement)) break;
  }
  await expect(barSearch(page)).toBeFocused();
  await expectRevealed(page, true);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - y0)).toBeLessThan(2);
  // While the bar is up, the hero's own copies are out of the tab order.
  await expect(page.locator("header").getByRole("button", { name: "Refresh status now" })).toHaveAttribute(
    "tabindex",
    "-1",
  );
  await expect(heroSearch(page)).toHaveAttribute("tabindex", "-1");
});

test("search reveal: Tab reaches the field without moving the page", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  await barSettled(page);
  // The stop before the bar's field in the tab order, whatever it is (the hero's controls, left of the bar in the markup).
  const found = await page.evaluate(() => {
    const target = document.querySelector('[data-search-input="bar"]');
    const stops = [
      ...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.closest("[inert]") &&
        !(element as HTMLButtonElement).disabled &&
        getComputedStyle(element).visibility !== "hidden",
    );
    const before = stops[stops.indexOf(target as HTMLElement) - 1];
    if (!before) return false;
    before.focus({ preventScroll: true });
    return true;
  });
  expect(found, "a stop before the field").toBe(true);
  await page.keyboard.press("Tab");
  await expect(barSearch(page)).toBeFocused();
  await expectRevealed(page, true);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - y0)).toBeLessThan(2);
});

test("search reveal: / brings the bar's field up and focuses it without moving the page", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  await page.keyboard.press("/");
  await expect(barSearch(page)).toBeFocused();
  await expectRevealed(page, true);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - y0)).toBeLessThan(2);
  // At the top, with the hero's field in view, it is the hero's field that takes the key.
  await barSearch(page).evaluate((input) => (input as HTMLInputElement).blur());
  await scrollAndSettle(page, 0);
  await page.keyboard.press("/");
  await expect(heroSearch(page)).toBeFocused();
});

test("search reveal: Escape clears the query in the bar's field and then leaves it", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  await scrollDeep(page, offsets);
  await page.keyboard.press("/");
  await expect(barSearch(page)).toBeFocused();
  await page.keyboard.type("aws");
  await expect(heroSearch(page)).toHaveValue("aws");
  await page.keyboard.press("Escape");
  await expect(barSearch(page)).toHaveValue("");
  await expect(barSearch(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(barSearch(page)).not.toBeFocused();
});

test("search reveal: moves with opacity and translate only", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const css = await page.evaluate(() => {
    const field = document.querySelector(".bar-search") as HTMLElement;
    const style = getComputedStyle(field);
    const root = getComputedStyle(document.documentElement);
    /** A CSS time ("0.15s", ".15s" or "150ms") in ms. */
    const ms = (value: string) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000);
    return {
      properties: style.transitionProperty.split(",").map((value) => value.trim()),
      durations: style.transitionDuration.split(",").map(ms),
      quick: ms(root.getPropertyValue("--t-quick")),
      reveal: ms(root.getPropertyValue("--t-reveal")),
    };
  });
  // Hidden, what is timed is the way out: opacity and translate, over --t-quick, and nothing else.
  expect([...css.properties].sort()).toEqual(["opacity", "translate"]);
  for (const duration of css.durations) expect(duration).toBeCloseTo(css.quick, 0);
  const y0 = await scrollDeep(page, offsets);
  const shown = await revealObserved(page, y0 - 2 * REVEAL_UP_PX);
  expect(shown.revealed).toBe(true);
  expect(shown.animations.length, "the field moves").toBeGreaterThan(0);
  for (const animation of shown.animations) {
    expect(["opacity", "translate"]).toContain(animation.property);
    expect(animation.ms, "coming in takes --t-reveal").toBeCloseTo(css.reveal, 0);
  }
  expect(new Set(shown.animations.map((animation) => animation.property))).toEqual(new Set(["opacity", "translate"]));
  expect(shown.opacity, "it starts from hidden").toBeLessThan(0.5);
  await barFieldSettled(page);
  const hidden = await revealObserved(page, y0 - 2 * REVEAL_UP_PX + 2 * HIDE_DOWN_PX);
  expect(hidden.revealed).toBe(false);
  expect(hidden.animations.length, "the field moves").toBeGreaterThan(0);
  for (const animation of hidden.animations) {
    expect(["opacity", "translate"]).toContain(animation.property);
    expect(animation.ms, "going out takes --t-quick").toBeCloseTo(css.quick, 0);
  }
  expect(hidden.opacity, "it starts from shown").toBeGreaterThan(0.5);
});

test("search reveal: no layout shift", async ({ page, browserName }) => {
  test.slow();
  const offsets = await revealBoard(page);
  if (browserName === "chromium") {
    await page.evaluate(async () => {
      const tracked = window as Window & { __cls?: number };
      tracked.__cls = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
          if (!entry.hadRecentInput) tracked.__cls = (tracked.__cls ?? 0) + entry.value;
        }
      });
      observer.observe({ type: "layout-shift", buffered: false });
      // A shift is worked out when the page makes its next frame, and reported with it, which on a busy machine can
      // be a while after what moved the page. Let a few frames come, drop what they report, and count from there.
      for (let frame = 0; frame < 3; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
      observer.takeRecords();
      tracked.__cls = 0;
    });
  }
  const layout = () =>
    page.evaluate(() => ({
      services: (document.querySelector("#services") as Element).getBoundingClientRect().top + window.scrollY,
      height: document.documentElement.scrollHeight,
      hero: (document.querySelector(".search-dock") as Element).getBoundingClientRect().top + window.scrollY,
    }));
  const y0 = await scrollDeep(page, offsets);
  const before = await layout();
  const same = async (label: string) => {
    const now = await layout();
    expect(Math.abs(now.services - before.services), `${label}: #services`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(now.height - before.height), `${label}: the page's height`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(now.hero - before.hero), `${label}: the hero's field`).toBeLessThanOrEqual(0.5);
  };
  for (let round = 0; round < 2; round++) {
    await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
    await expectRevealed(page, true);
    await barFieldSettled(page);
    await same(`revealed ${round}`);
    await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX + 2 * HIDE_DOWN_PX);
    await expectRevealed(page, false);
    await barFieldSettled(page);
    await same(`hidden ${round}`);
  }
  if (browserName === "chromium") {
    expect(await page.evaluate(() => (window as Window & { __cls?: number }).__cls ?? 0), "layout shift").toBe(0);
  }
});

test("search reveal: breakpoint", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  test.slow();
  await page.setViewportSize({ width: 1023, height: 900 });
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  // Below 64rem the dock never writes the wide progress, nor marks the move.
  const written = () =>
    page.evaluate(() => ({
      dock: (document.querySelector(".search-dock") as HTMLElement).style.getPropertyValue("--dock"),
      chips: (document.querySelector(".board-chips") as HTMLElement).style.getPropertyValue("--dock"),
      docking: document.querySelectorAll("[data-docking]").length,
      barField: getComputedStyle(document.querySelector(".bar-search") as Element).display,
    }));
  expect(await written()).toEqual({ dock: "", chips: "", docking: 0, barField: "block" });

  // At 64rem the field is the hero's again, and moves into the bar with the scroll: --dock is written and reaches 1.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expectRevealed(page, false);
  await scrollAndSettle(page, 0);
  const wide = await dockOffsets(page);
  expect(wide.wide).toBe(true);
  await scrollAndSettle(page, Math.ceil(wide.moveEnd) + 80);
  await expect.poll(() => dockValue(page)).toBe(1);
  await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
  expect((await written()).barField, "the bar has no copy of the field from 64rem").toBe("none");
  // And scrolling up again never reveals a copy in the bar: it is not there.
  await scrollAndSettle(page, Math.ceil(wide.moveEnd) + 20);
  expect(await isRevealed(page)).toBe(false);

  // Back below it: the wide marks are gone and the reveal is back.
  await page.setViewportSize({ width: 1023, height: 900 });
  await expect.poll(async () => (await written()).dock).toBe("");
  expect((await written()).docking).toBe(0);
  expect((await written()).barField).toBe("block");
});

test("search reveal: axe, with exactly one search landmark, after a reveal", async ({ page }) => {
  test.slow();
  const offsets = await revealBoard(page);
  const y0 = await scrollDeep(page, offsets);
  await scrollAndSettle(page, y0 - 2 * REVEAL_UP_PX);
  await expectRevealed(page, true);
  await barSettled(page);
  await barFieldSettled(page);
  expect(await page.locator('[role="search"]').count(), "one search landmark").toBe(1);
  expect(await page.getByRole("search").count(), "one search landmark for a screen reader").toBe(1);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .flatMap((violation) =>
      violation.nodes.map(
        (node) => `${violation.id} ${node.target.join(" ")}: ${node.failureSummary ?? violation.help}`,
      ),
    );
  expect(blocking).toEqual([]);
});

test("search reveal: real wheel input reaches the hook", async ({ page, browserName, isMobile }, testInfo) => {
  test.skip(
    testInfo.project.name === "iPhone 17 Pro" || testInfo.project.name === "iPad Pro 11",
    "WebKit has neither a wheel to send on a touch screen nor a CDP gesture to send",
  );
  test.slow();
  // A desktop window narrower than 64rem has the same layout as a phone, and the wheel is how it scrolls.
  if (!isMobile) await page.setViewportSize({ width: 900, height: 800 });
  const offsets = await revealBoard(page);
  const size = page.viewportSize();
  if (!size) throw new Error("no viewport");
  const cdp = browserName === "chromium" && isMobile ? await page.context().newCDPSession(page) : null;
  /** Scrolls the page `dy` px down (negative: up), the way this project's person would. */
  const scrollBy = async (dy: number) => {
    if (cdp) {
      // The browser's own gesture for the device (a touch drag on a phone); a negative yDistance scrolls down.
      await cdp.send("Input.synthesizeScrollGesture", {
        x: Math.round(size.width / 2),
        y: Math.round(size.height / 2),
        yDistance: -dy,
        gestureSourceType: "default",
        speed: 1200,
      });
    } else {
      await page.mouse.move(size.width / 2, size.height / 2);
      await page.mouse.wheel(0, dy);
    }
  };
  /** Waits until the page has stopped moving (a wheel or a fling scrolls over more than a frame). */
  const still = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let last = window.scrollY;
          let quiet = 0;
          const next = () => {
            if (window.scrollY === last) quiet++;
            else {
              quiet = 0;
              last = window.scrollY;
            }
            if (quiet >= 8) resolve(last);
            else requestAnimationFrame(next);
          };
          requestAnimationFrame(next);
        }),
    );
  await scrollBy(Math.ceil(offsets.revealFrom) + 500);
  const down = await still();
  expect(down, "the wheel scrolled the page").toBeGreaterThan(offsets.revealFrom + DOCK_HYSTERESIS + 40);
  await expectRevealed(page, false);
  await scrollBy(-3 * REVEAL_UP_PX);
  const up = await still();
  expect(up).toBeLessThan(down - REVEAL_UP_PX - 4);
  await expectRevealed(page, true);
});

test("search reveal: lands a link to #services below the bar, not part way into it", async ({ page }) => {
  await page.goto("/#services");
  await hydrated(page);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await scrollAndSettle(page, await page.evaluate(() => window.scrollY));
  const { barBottom, servicesTop } = await page.evaluate(() => ({
    barBottom: (document.querySelector('section[aria-label="Board controls"]') as Element).getBoundingClientRect()
      .bottom,
    servicesTop: (document.querySelector("#services") as Element).getBoundingClientRect().top,
  }));
  expect(servicesTop).toBeGreaterThanOrEqual(barBottom - 0.5);
});

test("shows a clear button once there is a search, and it keeps the field focused", async ({ page }) => {
  await page.goto("/?q=aws");
  await hydrated(page);
  const search = heroSearch(page);
  // The hero's Clear: the bar's copy has one too, hidden with it.
  const clear = page.locator(".search-dock").getByRole("button", { name: "Clear search" });
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

  test("search reveal: steps the bar's field in and out in the same frame, with no transition", async ({ page }) => {
    test.slow();
    const offsets = await revealBoard(page);
    // Nothing on it is timed, and nothing is left running.
    const timed = await page.evaluate(() =>
      [".bar-search", "[data-bar-verdict]"].map(
        (selector) => getComputedStyle(document.querySelector(selector) as Element).transitionDuration,
      ),
    );
    for (const duration of timed) {
      for (const part of duration.split(",")) expect(Number.parseFloat(part)).toBe(0);
    }
    const y0 = await scrollDeep(page, offsets);
    // Read in the very frame the attribute changes: already in its place, with no animation to get there.
    const shown = await revealObserved(page, y0 - 2 * REVEAL_UP_PX);
    expect(shown.revealed).toBe(true);
    expect(shown.animations, "no transition plays under Reduce Motion").toEqual([]);
    expect(shown.opacity, "in at once").toBe(1);
    const hidden = await revealObserved(page, y0 - 2 * REVEAL_UP_PX + 2 * HIDE_DOWN_PX);
    expect(hidden.revealed).toBe(false);
    expect(hidden.animations, "no transition plays under Reduce Motion").toEqual([]);
    expect(hidden.opacity, "out at once").toBe(0);
  });

  test("search reveal: snaps the search field into the bar and out again, never part way", async ({ page }) => {
    test.slow();
    await steadyBoard(page);
    await expect(searchDock(page)).toHaveAttribute("data-armed", "");
    const { wide } = await dockOffsets(page);
    const { path } = await dockPath(page);
    const stops = await sweepDock(page, path);
    if (wide) {
      expect([...new Set(stops.map((stop) => stop.dock))].sort()).toEqual([0, 1]);
      // The bar never shows over a field that has not snapped into it, going down or coming back up.
      for (const stop of stops.filter((stop) => stop.shown === "true")) {
        expect(stop.dock, `at ${stop.y}`).toBe(1);
      }
      return;
    }
    // Below 64rem the bar's field is at one of its two poses at every stop, never between them.
    for (const stop of stops) expect(stop.barFieldOpacity, `at ${stop.y}`).toBe(stop.revealed ? 1 : 0);
    expect(
      stops.some((stop) => stop.revealed),
      "the field was revealed on the way back",
    ).toBe(true);
    expect(
      stops.some((stop) => !stop.revealed && stop.shown === "true"),
      "and hidden with the bar up",
    ).toBe(true);
  });
});

test("marks the search field for an iPhone keyboard: search key, no autocorrect", async ({ page }) => {
  await page.goto("/");
  await hydrated(page);
  // The hero's field and the bar's copy of it are the same field to the keyboard.
  for (const input of [heroSearch(page), barSearch(page)]) {
    await expect(input).toHaveAttribute("type", "search");
    await expect(input).toHaveAttribute("enterkeyhint", "search");
    await expect(input).toHaveAttribute("autocapitalize", "off");
    await expect(input).toHaveAttribute("autocorrect", "off");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveAttribute("spellcheck", "false");
  }
});

test("sets the search field at 16px on a touch screen, so iPhone does not zoom in", async ({ page }) => {
  await page.goto("/");
  await hydrated(page);
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  test.skip(!coarse, "the zoom guard is for a coarse pointer, which this project does not have");
  for (const input of [heroSearch(page), barSearch(page)]) {
    const size = await input.evaluate((element) => getComputedStyle(element).fontSize);
    expect(Number.parseFloat(size)).toBeGreaterThanOrEqual(16);
  }
});

test("renders healthy services as rows, alike whether or not the vendor lists components", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  await openFixtureInSlot(page, () => board);

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
      // The dropdown itself says whether the press opened it; a list that never shows could be anything.
      await expect(card.locator("details")).toHaveAttribute("open", "");
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
  await openFixtureInSlot(page, () => board);
  const card = page.locator("article#service-spotify");
  await card.locator("summary").click();
  await expect(card.locator("details")).toHaveAttribute("open", "");
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
    // Pin the page clock well inside a slot: a boundary before the baseline is read would add the row early, and
    // the 3:00 jump would then cross a boundary that changes no row count.
    await page.clock.install({ time: Math.floor(Date.now() / 120_000) * 120_000 + 30_000 });
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
    await expect(card.locator("details")).toHaveAttribute("open", "");
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
    // Pin the page clock well inside a slot: a boundary before the baseline is read would add the row early, and
    // the 3:00 jump would then change nothing, so the test would pass without checking anything.
    await page.clock.install({ time: Math.floor(Date.now() / 120_000) * 120_000 + 30_000 });
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
        revealed:
          document.querySelector('section[aria-label="Board controls"]')?.hasAttribute("data-revealed") ?? false,
        calls: (window as Window & { __scrolledBy?: number[] }).__scrolledBy?.length ?? 0,
      }));
    const before = await state();
    await page.clock.fastForward("03:00");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const after = await state();
    expect(after.y).toBe(before.y);
    expect(after.revealed).toBe(before.revealed);
    expect(after.calls).toBe(before.calls);
    await expect(dock).toHaveCount(1);
  });
}

// A tap leaves no pointer and no focus on the board, so the hook holds the first thing in view: the cards under
// the feed, never the feed itself.
test("scrolls to hold the cards after a tap with anchoring off", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "a finger is the phone project's");
  await page.addInitScript(() => {
    const scrolled: number[] = [];
    (window as Window & { __scrolledBy?: number[] }).__scrolledBy = scrolled;
    const original = window.scrollBy;
    window.scrollBy = ((...args: unknown[]) => {
      const first = args[0] as ScrollToOptions | number | undefined;
      scrolled.push(typeof first === "object" ? (first?.top ?? 0) : ((args[1] as number | undefined) ?? 0));
      return (original as (...values: unknown[]) => void).apply(window, args);
    }) as typeof window.scrollBy;
    // The scroll events delivered so far: an event comes a frame after the scroll that makes it.
    const events = { count: 0 };
    (window as Window & { __scrollEvents?: { count: number } }).__scrollEvents = events;
    window.addEventListener(
      "scroll",
      () => {
        events.count += 1;
      },
      true,
    );
  });
  // Pin the page clock well inside a slot: a boundary before the baseline is read would add the row and clear the
  // tags early, and the 3:00 jump would then cross a boundary that changes no row count.
  await page.clock.install({ time: Math.floor(Date.now() / 120_000) * 120_000 + 30_000 });
  await openFixture(page, () => fixtureBoard(Date.now()));
  await page.evaluate(() => {
    document.documentElement.style.overflowAnchor = "none";
  });
  const card = page.locator("article#service-spotify");
  await card.locator("summary").click();
  await expect(card.locator("details")).toHaveAttribute("open", "");
  const toggle = card.getByRole("button", { name: /^Show all 32/ });
  await toggle.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 200));
  const box = await toggle.boundingBox();
  if (!box) throw new Error("no box");
  await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
  // The tap opened the list and left focus on a button; let go of it, so only the first thing in view is left.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const fewer = card.getByRole("button", { name: /^Show fewer/ });
  const scrollEvents = () =>
    page.evaluate(() => (window as Window & { __scrollEvents?: { count: number } }).__scrollEvents?.count ?? 0);
  const eventsBefore = await scrollEvents();
  const yBefore = await page.evaluate(() => window.scrollY);
  await fewer.scrollIntoViewIfNeeded();
  // The hook starts its wait for the page to be still when the scroll event arrives, a frame after the scroll, and
  // a clock jump made before that would find the wait not started and the anchor the one from before the scroll.
  if ((await page.evaluate(() => window.scrollY)) !== yBefore) {
    await expect.poll(scrollEvents, { message: "the scroll event arrives" }).toBeGreaterThan(eventsBefore);
  }
  // The page is still for longer than the hook waits, and it has picked its anchor again.
  await page.clock.fastForward(1000);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.evaluate(() => {
    (window as Window & { __scrolledBy?: number[] }).__scrolledBy?.splice(0);
  });
  const feed = page.locator('section[aria-labelledby="recent-heading"]');
  const rows = await feed.locator("li").count();
  const topOf = () => fewer.evaluate((element) => element.getBoundingClientRect().top);
  // Where the button is on the page, which the scroll position does not change.
  const placeOf = () => fewer.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  const topBefore = await topOf();
  const placeBefore = await placeOf();
  await page.clock.fastForward("03:00");
  await expect(feed.locator("li")).not.toHaveCount(rows);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  // The check adds a row to the feed (the cards drop) and clears the "Changed" tags of the cards above them (the
  // cards rise). Which of the two is more depends on the layout: the fixture differs from the server's board on
  // most of its cards, so most of them wear a tag. The new row adds 63px; clearing the tags frees 36px where their
  // text wraps one way (a headed Chromium) and 108px where it wraps the other (the headless shell CI runs), so the
  // cards may net drop or net rise. Holding them means scrolling by exactly the distance they moved, whichever way,
  // and never a step the other way; and the button the page was scrolled to is where it was in the window.
  const moved = (await placeOf()) - placeBefore;
  expect(Math.abs(moved), "the check moved the cards").toBeGreaterThan(1);
  const scrolled = await page.evaluate(() => (window as Window & { __scrolledBy?: number[] }).__scrolledBy ?? []);
  expect(scrolled.length).toBeGreaterThan(0);
  expect(
    scrolled.every((by) => Math.sign(by) === Math.sign(moved)),
    `every step of ${scrolled.join(", ")} goes the way the cards moved (${moved})`,
  ).toBe(true);
  const followed = scrolled.reduce((sum, by) => sum + by, 0);
  expect(
    Math.abs(followed - moved),
    `the page followed the cards by ${followed}, which moved ${moved}`,
  ).toBeLessThanOrEqual(1);
  expect(Math.abs((await topOf()) - topBefore)).toBeLessThanOrEqual(1);
});

test("operates Show all from the keyboard", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a keyboard is the desktop project's");
  const board = fixtureBoard(Date.now());
  await openFixtureInSlot(page, () => board);
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
  await openFixtureInSlot(page, () => board);
  const card = page.locator("article#service-gcp");
  // The broken components stay in view; the working ones wait in the dropdown.
  await expect(card.locator("[data-component-row]")).toHaveCount(2);
  const dropdown = card.locator("details[data-healthy-components]");
  await expect(dropdown).toHaveCount(1);
  await expect(dropdown.locator("summary")).toContainText("Working components");
  await dropdown.locator("summary").click();
  // The dropdown itself says whether the press opened it; a list that never shows could be anything.
  await expect(dropdown).toHaveAttribute("open", "");
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
  await openFixtureInSlot(page, () => board);

  // The attention card: the broken component in view, the working ones in the dropdown.
  const card = page.locator("article#service-claude");
  await expect(card.locator("[data-component-row]")).toHaveCount(1);
  const dropdown = card.locator("details[data-healthy-components]");
  await expect(dropdown.locator("summary")).toContainText("Working components");
  await dropdown.locator("summary").click();
  // The dropdown itself says whether the press opened it; a list that never shows could be anything.
  await expect(dropdown).toHaveAttribute("open", "");
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
  await expect(row.locator("details")).toHaveAttribute("open", "");
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
  await openFixtureInSlot(page, () => board);
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
  await heroSearch(page).fill("Google Cloud");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute("id", "service-gcp");
  await expect(highlight).toHaveCount(0);
});

test("keeps the groups, filters and stars working with full cards", async ({ page }) => {
  const board = fixtureBoard(Date.now());
  await openFixture(page, () => board);

  // Needs a look first, then what could not be read, then one list per category (Cloud lists only Azure, the one healthy row), then Releases.
  await expect(
    page.locator('#attention-heading, #unread-heading, [id^="up-"][id$="-heading"], #releases-heading'),
  ).toHaveText([
    /Needs a look\s*3/,
    /Couldn't read\s*1/,
    /Cloud\s*1/,
    /Gaming\s*3/,
    /Platforms\s*5/,
    /AI\s*3/,
    /Releases\s*4/,
  ]);

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
  await heroSearch(page).fill("Google Cloud");
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
  await heroSearch(page).fill("Google Cloud");
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

test("a press between Settings shutting and the page being told still opens it", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const button = page.getByRole("button", { name: "Settings", exact: true });
  await button.click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  // A modal <dialog> that Escape shuts is closed at once, and its `close` event, which the page learns it from, is a
  // task of its own. Here the press comes inside that gap, as one does on a busy page: the dialog is shut by `close()`
  // and the button is pressed in the same task, so the event can only arrive after the press. Then the page is given
  // the event and two frames to act on it.
  const open = await page.evaluate(async () => {
    const shut = document.querySelector<HTMLDialogElement>("dialog.settings-dialog");
    const press = [...document.querySelectorAll<HTMLButtonElement>("footer button")].find(
      (one) => one.textContent?.trim() === "Settings",
    );
    if (!shut || !press) throw new Error("no dialog or no button");
    const told = new Promise((resolve) => shut.addEventListener("close", resolve, { once: true }));
    shut.close();
    press.click();
    await told;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return shut.open;
  });
  expect(open, "the press opened Settings, and the late `close` of the shut one did not shut it again").toBe(true);
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
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
  await expect(footer).toContainText("not affiliated with or endorsed by any of the vendors listed");
  await expect(footer).toContainText("Made by greenblacked.");
  const signature = footer.getByRole("link", { name: "greenblacked", exact: true });
  await expect(signature).toHaveAttribute("href", "https://github.com/greenblacked");
  await expect(signature).toHaveAttribute("target", "_blank");
  await expect(signature).toHaveAttribute("rel", /noopener/);
  await expect(footer).not.toContainText("every two minutes");
  await expect(footer.getByRole("link", { name: "JSON" })).toHaveAttribute("href", "/api/status.json");
  await expect(footer.getByRole("link", { name: "Atom feed" })).toHaveAttribute("href", "/feed.xml");
  await expect(footer.getByRole("link", { name: "Badges" })).toHaveCount(0);
  await expect(footer).not.toContainText("TanStack");
  await expect(footer).not.toContainText("Cloudflare Workers");
});

test("puts the footer in a contentinfo landmark outside main, and names the recent changes", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  // The role only exists for a footer that is not inside main, an article or a section.
  const footer = page.getByRole("contentinfo");
  await expect(footer).toHaveCount(1);
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("not affiliated with or endorsed by any of the vendors listed");
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
  await heroSearch(page).fill("steam");
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
  const search = heroSearch(page);
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
 * with its services taken out: the check the load makes compares only the
 * services both boards list, so it finds nothing changed whatever the vendors
 * say. With the services in, a vendor that flips between the first visit and
 * a later load (a timeout reads as Unknown) makes the load's check a change
 * with a caption of its own, a few lines taller than the quiet row the
 * reserve counts on, which the page cannot know before it has the board.
 * The board's own fetches are held back for the same reason, until a test has
 * read what it measures: the server may hand a load a board up to a sweep old,
 * which the page then refetches on mount, and a vendor that flipped in between
 * turns the load's quiet check into a change row. A held request reads as a
 * slow network (the page keeps its board and shows no error), where aborting
 * it would show the error line.
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
    store: JSON.stringify({ lastSlot: slot - 120_000, lastBoard: { ...first.lastBoard, services: [] }, pulses }),
  };
}

const feedSurface = (page: Page) => page.locator('section[aria-labelledby="recent-heading"] .surface');
const feedRows = (page: Page) => page.locator('section[aria-labelledby="recent-heading"] li');

/**
 * Holds the board's GETs (the page's refetches) until the returned function is
 * called, then lets them go on to any route registered before this one.
 */
async function holdBoardFetches(page: Page): Promise<() => Promise<void>> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().method() === "GET") await held;
    await route.fallback();
  });
  return async () => {
    release();
    await page.unroute("**/_serverFn/**");
  };
}

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
  const releaseBoard = await holdBoardFetches(page);
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
  await releaseBoard();
  expect(shift, "cumulative layout shift").toBeLessThan(0.02);
});

// The saved checks arrive in the render after hydration. On a first visit they add the first row to Recent changes
// (the empty state is shorter), and when a two-minute slot turns between the page being parsed and hydrating they add
// another past what the page reserved, so everything below moves, the footer's Settings button included. A tap that
// straddles that move (the press lands on the button, the page shifts, the release lands elsewhere) is lost, and a
// WebKit run of tilt.spec.ts tapped Settings and found no dialog (the cause is inferred from the measured move; the
// lost tap itself was not reproduced). So the page says it has hydrated only once the rows are in. A slot that turns
// later, or a refetch that rewords a row, can still move the page after that, as it can for a visitor.
for (const visit of ["a first visit", "a slot that turns while the page loads"] as const) {
  test(`is done moving the footer when the page says it has hydrated, on ${visit}`, async ({ page }) => {
    const releaseBoard = await holdBoardFetches(page);
    await page.goto("/");
    await hydrated(page);
    await expect(feedRows(page)).toHaveCount(1);
    await page.addInitScript(() => {
      const seen = window as Window & { __atHydration?: { height: number; rows: number } };
      new MutationObserver(() => {
        if (seen.__atHydration === undefined && document.documentElement.hasAttribute("data-hydrated")) {
          seen.__atHydration = {
            height: document.documentElement.scrollHeight,
            rows: document.querySelectorAll('section[aria-labelledby="recent-heading"] li').length,
          };
        }
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-hydrated"] });
    });
    if (visit === "a first visit") {
      await page.evaluate(() => localStorage.clear());
    } else {
      // The clock is two minutes on from the moment the feed's script ran, which saw the slot the page saved.
      await page.addInitScript(() => {
        const real = Date.now.bind(Date);
        const ran = () =>
          document
            .querySelector<HTMLElement>('section[aria-labelledby="recent-heading"] .surface')
            ?.style.getPropertyValue("--feed-reserve");
        Date.now = () => real() + (ran() ? 130_000 : 0);
      });
    }
    await page.reload();
    await hydrated(page);
    await expect(feedRows(page)).toHaveCount(visit === "a first visit" ? 1 : 2);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const { atHydration, settled } = await page.evaluate(() => ({
      atHydration: (window as Window & { __atHydration?: { height: number; rows: number } }).__atHydration,
      settled: {
        height: document.documentElement.scrollHeight,
        rows: document.querySelectorAll('section[aria-labelledby="recent-heading"] li').length,
      },
    }));
    await releaseBoard();
    // The rows are the exact claim. The height allows for the browser's own rounding only: the moves this guards
    // against are 10px (the first row) and a whole row (63px).
    expect(atHydration?.rows, "the rows of Recent changes when the page said it had hydrated").toBe(settled.rows);
    expect(
      Math.abs((atHydration?.height ?? Number.NaN) - settled.height),
      "the page's height change after it said it had hydrated",
    ).toBeLessThanOrEqual(2);
  });
}

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
        await route.fallback();
      });
      const releaseBoard = await holdBoardFetches(page);
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
      await releaseBoard();
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
  // on lines 48pt apart (hit-lines, over the tallest box so a neighbour's edge never takes the tap), not the
  // words' own box: a tap 21.5px above or below the middle of the words still lands on the link. (The next test
  // has the sentence wrap, and checks that no two of them overlap.) The box is the face's content area plus the
  // padding, and the content area is the face's own (at 15px: 19px in Inter, 18px in DejaVu Sans, 17px in
  // Liberation Sans, and in Inter Fallback 19px where the overrides apply and its own face's 17 to 18px where they
  // do not). Inter is font-display: optional and a page view keeps the face it was first drawn in,
  // so which of them this view drew is up to the timing of the font, and it must not decide the result: the
  // sentence is measured in the page's own face and then in each of the others the font stack can end in.
  const sentence = await page.evaluate(() => {
    const paragraph = document.querySelector<HTMLElement>("header h1 + p");
    const links = [...document.querySelectorAll<HTMLAnchorElement>("header h1 + p a")];
    const own = paragraph?.style.fontFamily ?? "";
    const faces = ["", "system-ui", "sans-serif", '"Inter Fallback"', '"Liberation Sans"', '"DejaVu Sans"'];
    const boxes = faces.flatMap((face) => {
      if (paragraph) paragraph.style.fontFamily = face || own;
      return links.map((link) => {
        link.scrollIntoView({ block: "center" });
        const box = link.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return {
          name: `${link.textContent?.trim() ?? ""}${face ? ` in ${face}` : ""}`,
          x: x + window.scrollX,
          y: y + window.scrollY,
          face,
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
    });
    if (paragraph) paragraph.style.fontFamily = own;
    return boxes;
  });
  const own = sentence.filter((link) => link.face === "");
  expect(own.length, "the sub line names services").toBeGreaterThan(1);
  for (const link of sentence)
    expect(link.reaches, `${link.name} reaches 44px tall (above and below it saw ${link.seen})`).toEqual([true, true]);
  // Neighbours on one line are well apart (WCAG 2.5.8: 24px between centres).
  for (const [index, link] of own.entries()) {
    const next = own[index + 1];
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

test("centres the wordmark in the header at md and up, clear of the dateline and the controls", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  const board = fixtureBoard(Date.now());
  // A root font-size from a style tag does not move rem media queries, so md is still 768px; 200% text is the
  // hardest case for overlap at the narrow end.
  for (const [width, rootPx] of [
    [768, 16],
    [1024, 16],
    [1280, 16],
    [1440, 16],
    [768, 32],
    [1024, 32],
    [1600, 32],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page, () => board);
    await page.addStyleTag({ content: `html { font-size: ${rootPx}px !important; }` });
    const layout = await page.evaluate(() => {
      const header = document.querySelector("header");
      const mark = document.querySelector('header [data-testid="wordmark"]');
      if (!header || !mark) throw new Error("no header or wordmark");
      const inner = header.getBoundingClientRect();
      const style = getComputedStyle(header);
      const box = (element: Element | null, name: string) => {
        const rect = element?.getBoundingClientRect();
        if (!rect) throw new Error(`no ${name}`);
        return { name, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      const left = inner.left + Number.parseFloat(style.paddingLeft);
      const right = inner.right - Number.parseFloat(style.paddingRight);
      return {
        text: mark.textContent,
        shown: getComputedStyle(mark).display !== "none",
        headerCentre: (left + right) / 2,
        markCentre: (mark.getBoundingClientRect().left + mark.getBoundingClientRect().right) / 2,
        parts: [
          box(mark, "wordmark"),
          box(document.querySelector("header time"), "dateline"),
          ...[...document.querySelectorAll("header button")]
            .slice(0, 2)
            .map((button, at) => box(button, `button ${at}`)),
        ],
      };
    });
    const at = `at ${width}px, ${rootPx}px text`;
    expect(layout.text).toBe("Status Page");
    expect(layout.shown, `wordmark shown ${at}`).toBe(true);
    expect(Math.abs(layout.markCentre - layout.headerCentre), `wordmark centre ${at}`).toBeLessThanOrEqual(1);
    const [mark, ...others] = layout.parts;
    for (const other of others) {
      const apart = mark.right <= other.left + 0.5 || other.right <= mark.left + 0.5;
      expect(apart, `wordmark and ${other.name} overlap ${at}`).toBe(true);
    }
  }
});

test("hides the wordmark below md, where the dateline and the controls have the row", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
  await page.setViewportSize({ width: 390, height: 800 });
  await openFixture(page, () => fixtureBoard(Date.now()));
  await expect(page.locator('header [data-testid="wordmark"]')).toBeHidden();
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
  await expect(headline).toHaveText("One is down, one is degraded and one is in maintenance.");
  await expect(headline).toHaveAttribute("id", "board-headline");
  // One pen stroke, under the count only, drawn from constants (aria-hidden, no text of its own).
  await expect(headline.locator("svg.pen-underline")).toHaveCount(1);
  await expect(headline.locator("svg.pen-underline")).toHaveAttribute("aria-hidden", "true");
  // The sentence under it names the services and links each to its card.
  const sub = page.locator("h1 + p");
  await expect(sub).toContainText(
    "AWS is down. GCP is degraded. Epic is in maintenance. The other sixteen are running normally.",
  );
  await expect(sub).toContainText("I couldn't read Android.");
  const links = sub.getByRole("link");
  await expect(links).toHaveText(["AWS", "GCP", "Epic", "Android"]);
  await expect(links.first()).toHaveAttribute("href", "#service-aws");
  // Nothing hand-written while there is something to look at.
  await expect(page.getByText("all quiet")).toHaveCount(0);
  await expect(page.locator("#service-aws svg.pen-loop")).toHaveCount(1);
});

test("writes all quiet by hand, and says so in words, when all twenty are up", async ({ page }) => {
  await openFixture(page, () => calmBoard(Date.now()), { id: "aws", label: "Operational" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Everything is up.");
  await expect(page.locator("h1 svg.pen-underline")).toHaveCount(0);
  const note = page.getByText("all quiet", { exact: true });
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("aria-hidden", "true");
  expect(await note.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Hand");
  await expect(page.getByText("All twenty services are running normally.")).toHaveClass(/sr-only/);
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
  await expect(lead).toContainText("1 down · 1 degraded · 1 in maintenance");
  await expect(lead).toContainText(/Checked \d\d:\d\d\sUTC · next in \d:\d\d/);
  // The bar is a float: the one translucent element on a Quiet page.
  await expect(bar).toHaveClass(/\bfloat\b/);
});

for (const [name, makeBoard] of [
  ["the plain fixture", fixtureBoard],
  ["the longest hero", longHeroBoard],
] as const) {
  test(`never cuts the floating bar's verdict short on ${name}`, async ({ page }) => {
    await openFixture(page, () => makeBoard(Date.now()));
    const bar = controlBar(page);
    await page.locator("footer").scrollIntoViewIfNeeded();
    await expect(bar).toHaveAttribute("data-shown", "true");
    // The drawn form: the compact one below 1024px, the short one from there up. Its text must fit its box.
    const drawn = await bar
      .locator("[data-bar-verdict] > span:not(:last-child)")
      .evaluateAll((spans) =>
        spans
          .filter((span) => span.getBoundingClientRect().width > 1)
          .map((span) => ({ text: span.textContent, clipped: span.scrollWidth > span.clientWidth })),
      );
    expect(drawn).toHaveLength(1);
    expect(drawn[0].clipped, `"${drawn[0].text}" fits its slot`).toBe(false);
  });
}

/** The local() names the fallback faces in styles.css look for, which this machine may have none of. */
const NO_FALLBACK_FONT =
  'this machine has none of the fonts the fallback faces look for, so there is no fallback to resize: local() "Arial", "ArialMT", "Liberation Sans", "LiberationSans", "Arimo" (Inter Fallback) and "Roboto", "Roboto Regular", "Roboto-Regular" (Inter Fallback Roboto)';

/** Whether this machine has any font the fallback faces name (the local() names in styles.css). */
async function fallbackFaceFound(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    // A face whose local() names match no installed font fails to load and matches nothing.
    const loaded = await Promise.all(
      ['"Inter Fallback"', '"Inter Fallback Roboto"'].map((family) =>
        document.fonts.load(`16px ${family}`).catch(() => [] as FontFace[]),
      ),
    );
    return loaded.some((faces) => faces.length > 0);
  });
}

/** Whether a platform font family from drawnFonts is the self-hosted Inter (its file's own name is "Inter Variable"). */
const isInter = (family: string) => family.startsWith("Inter");

/** The status of the page's Inter FontFace: "loading" while the file is on its way, "loaded" once it is in. */
async function interStatus(page: Page): Promise<string> {
  return page.evaluate(
    () => [...document.fonts].find((face) => face.family.replaceAll('"', "") === "Inter")?.status ?? "missing",
  );
}

/** The font families Chromium really drew the text of the first element matching the selector in (Chrome DevTools). */
async function drawnFonts(page: Page, selector: string): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((font) => font.familyName);
  } finally {
    await cdp.detach();
  }
}

// The self-hosted Inter is font-display: optional (src/styles.css). Chromium uses an optional font that was not
// preloaded only if it is ready when the page starts to render (in practice, already cached); Inter that comes later
// is fetched and cached, but the page view keeps the system font it was drawn in, so nothing re-wraps and the hero's
// links do not jump. A later load can draw in Inter from the first paint (e2e/font-cache.spec.ts covers a return
// visit in a new browser session; the second view below stays in one session, where the font is in memory). The page
// is a phone, a tablet and a desktop in turn, over a board with no line to move (calm), the plain fixture and the
// longest hero (the most lines on a phone).
//
// A shift of "none" is under 0.0005: a relative time that ticks over while the test waits ("since 4 min") moves its
// chip by 0.00002 to 0.00012, and a swap to Inter (font-display: swap) moves these boards by 0.0013 to 0.0023.
const NO_SHIFT = 0.0005;
const FONT_BOARDS = [
  ["a calm board", calmBoard, { id: "aws", label: "Operational" }],
  ["the plain fixture", fixtureBoard, { id: "aws", label: "Outage" }],
  ["the longest hero", longHeroBoard, { id: "aws", label: "Outage" }],
] as const;

for (const [name, makeBoard, ready] of FONT_BOARDS) {
  test(`keeps the system font and the hero in place when the self-hosted Inter arrives late on ${name}`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "the fallback faces are what Chromium draws on Android, Windows and Linux");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/inter-var*.woff2", async (route) => {
      await held;
      await route.continue();
    });
    await page.addInitScript(() => {
      const tracked = window as Window & {
        __cls?: number;
        __ignored?: number;
        __lastInput?: number;
        __shifts?: PerformanceObserver;
      };
      tracked.__cls = 0;
      tracked.__ignored = 0;
      tracked.__lastInput = 0;
      // A shift within 500ms of a click or a key press is flagged and dropped from the score; note the last input,
      // to measure only once that window is over.
      for (const type of ["pointerdown", "keydown"]) {
        addEventListener(type, () => (tracked.__lastInput = performance.now()), true);
      }
      tracked.__shifts = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
          if (entry.hadRecentInput) tracked.__ignored = (tracked.__ignored ?? 0) + entry.value;
          else tracked.__cls = (tracked.__cls ?? 0) + entry.value;
        }
      });
      tracked.__shifts.observe({ type: "layout-shift", buffered: true });
    });
    await serveBoard(page, () => makeBoard(Date.now()));
    // Not "load": a font that is still being fetched holds the load event back.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(cards(page)).toHaveCount(SERVICES);
    await hydrated(page);
    test.skip(!(await fallbackFaceFound(page)), NO_FALLBACK_FONT);
    await pressRefresh(page, page.getByRole("button", { name: "Refresh status now" }).first());
    await expect(page.locator(`#service-${ready.id}`).getByText(ready.label, { exact: true }).first()).toBeVisible();
    // Not vacuous: Inter is still on its way, long past the page's first render, and the board is drawn without it.
    expect(await interStatus(page)).toBe("loading");
    const before = await drawnFonts(page, "h1");
    expect(before.length, "the headline is drawn in some font").toBeGreaterThan(0);
    expect(before.some(isInter), "the headline before Inter arrives is drawn in Inter").toBe(false);
    const heroBefore = await page.locator("h1").boundingBox();
    // The click's 500ms window must be over before Inter lands, or a shift in it would not count and the test would
    // pass whatever the arrival did.
    await page.waitForFunction(
      () => performance.now() - ((window as Window & { __lastInput?: number }).__lastInput ?? 0) > 600,
    );
    // Count only what the arrival does: drop what the first draws and the refresh moved.
    await page.evaluate(() => {
      const tracked = window as Window & { __cls?: number; __ignored?: number; __shifts?: PerformanceObserver };
      tracked.__shifts?.takeRecords();
      tracked.__cls = 0;
      tracked.__ignored = 0;
    });
    release();
    await page.waitForFunction(
      () => [...document.fonts].some((face) => face.family.replaceAll('"', "") === "Inter" && face.status === "loaded"),
      undefined,
      { timeout: 15_000 },
    );
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await page.waitForTimeout(500);
    const { shift, ignored } = await page.evaluate(() => {
      const tracked = window as Window & { __cls?: number; __ignored?: number };
      return { shift: tracked.__cls ?? 0, ignored: tracked.__ignored ?? 0 };
    });
    expect(shift, "cumulative layout shift once Inter has arrived").toBeLessThan(NO_SHIFT);
    expect(ignored, "layout shift left out of the score as a reaction to an input").toBe(0);
    // Inter is in (loaded, and cached for the next load), and the page view still does not use it.
    expect(await drawnFonts(page, "h1"), "the headline after Inter arrived").toEqual(before);
    expect((await page.locator("h1").boundingBox()) ?? null).toEqual(heroBefore);
    // Text laid out after Inter landed stays in the fallback too: a refresh redraws the cards.
    await pressRefresh(page, page.getByRole("button", { name: "Refresh status now" }).first());
    expect(await drawnFonts(page, "h1"), "the headline after another refresh").toEqual(before);
  });

  test(`draws ${name} in the cached self-hosted Inter from the first paint`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "the fallback faces are what Chromium draws on Android, Windows and Linux");
    // No route yet: a routed page has its HTTP cache switched off, and the cache is what this test is about.
    // The first view fetches Inter (and may draw without it); the second finds it in the cache.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await hydrated(page);
    await page.evaluate(() => document.fonts.load("400 16px Inter"));
    expect(await interStatus(page)).toBe("loaded");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await hydrated(page);
    expect((await drawnFonts(page, "h1")).some(isInter), "the second view's headline is drawn in Inter").toBe(true);
    // And it stays so once the board is the one under test.
    await serveBoard(page, () => makeBoard(Date.now()));
    await pressRefresh(page, page.getByRole("button", { name: "Refresh status now" }).first());
    await expect(page.locator(`#service-${ready.id}`).getByText(ready.label, { exact: true }).first()).toBeVisible();
    expect((await drawnFonts(page, "h1")).some(isInter), "the board's headline is drawn in Inter").toBe(true);
  });
}

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

// The filter row is one line at the widths the desktop layout guarantees it (1024px and up), in Inter and in the
// fallback a first-time visitor is drawn in (Inter is font-display: optional, and a cold browser has not got it ready
// at the first render). Inter is the wider of the two by some 14px at 1024px, so the row has little to spare in
// either, and a machine that rasterizes the text a little wider (hinting) is enough to tip it. Each face is pinned,
// so the test measures both on any machine: "fallback" aborts the Inter file, so the page keeps the system face,
// and "Inter" re-declares the face with font-display: block (what the cached case draws in, without the race
// optional has with a file that arrives within the first 100ms). The last two cases stress the guarantee itself:
// the row's text spaced out far past either face, which must scroll the segments and keep the toggles beside them,
// not drop the toggles below. The first two cases also assert that every category is visible (the segments do not
// scroll), since the toggles cannot wrap and a row too wide would otherwise pass with its last option clipped.
const FILTER_ROW_CASES = [
  { face: "fallback", spacing: "", note: "" },
  { face: "Inter", spacing: "", note: "" },
  { face: "fallback", spacing: "1px", note: " with the text spaced out" },
  { face: "Inter", spacing: "1px", note: " with the text spaced out" },
] as const;

for (const width of [1024, 1440]) {
  for (const { face, spacing, note } of FILTER_ROW_CASES) {
    test(`keeps the filter row on one line, and the board still, when a star is added at ${width}px in ${face}${note}`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "the widths are set here, so one project measures them");
      if (face === "fallback") await page.route("**/inter-var*.woff2", (route) => route.abort());
      await page.setViewportSize({ width, height: 900 });
      await openFixture(page, busyBoard);
      /** Pins the face: Inter drawn (declared again, as block, so that it is used whenever it arrives) or never. */
      const pinFace = async () => {
        if (face === "fallback") {
          test.skip(!(await fallbackFaceFound(page)), NO_FALLBACK_FONT);
          expect(await interStatus(page), "Inter never arrives").toBe("error");
          return;
        }
        await page.evaluate(async () => {
          const rule = [...document.styleSheets]
            .flatMap((sheet) => [...sheet.cssRules])
            .find((r) => r instanceof CSSFontFaceRule && r.style.getPropertyValue("font-family").includes("Inter"));
          const src = (rule as CSSFontFaceRule).style.getPropertyValue("src");
          const style = document.createElement("style");
          style.textContent = `@font-face { font-family: "Inter"; src: ${src}; font-weight: 400 700; font-display: block; }`;
          document.head.appendChild(style);
          await Promise.all([document.fonts.load("400 16px Inter"), document.fonts.load("600 16px Inter")]);
        });
        await expect
          .poll(() =>
            page.evaluate(() => [...document.fonts].some((f) => f.family.includes("Inter") && f.status === "loaded")),
          )
          .toBe(true);
      };
      await pinFace();
      const stress = async () => {
        if (spacing) {
          await page.addStyleTag({
            content: `.board-chips, .board-chips * { letter-spacing: ${spacing} !important; }`,
          });
        }
      };
      const toggleFonts = () => drawnFonts(page, '[role="group"][aria-label="Category"] + div button');
      const row = async () =>
        page.evaluate(() => {
          const segments = document.querySelector('[role="group"][aria-label="Category"]') as HTMLElement;
          const toggles = segments.nextElementSibling as HTMLElement;
          const field = document.querySelector(".search-dock .search-field") as HTMLElement;
          const box = (element: Element) => element.getBoundingClientRect();
          return {
            segmentsBottom: box(segments).bottom,
            segmentsRight: box(segments).right,
            segmentsScrollWidth: segments.scrollWidth,
            segmentsClientWidth: segments.clientWidth,
            togglesTop: box(toggles).top,
            togglesLeft: box(toggles).left,
            togglesRight: box(toggles).right,
            sectionRight: box(segments.parentElement as Element).right,
            mainTop: box(document.querySelector("main#services") as Element).top,
            fieldMid: box(field).top + box(field).height / 2,
            rowMid: (box(segments).top + box(segments).bottom) / 2,
            togglesText: toggles.textContent ?? "",
          };
        });
      await stress();
      /**
       * Unspaced, the row has to fit with every category visible (the toggles cannot wrap, so a face too wide
       * for it would only show as clipped segments).
       */
      const expectFits = (state: Awaited<ReturnType<typeof row>>) => {
        if (!spacing) expect(state.segmentsScrollWidth).toBeLessThanOrEqual(state.segmentsClientWidth + 0.5);
      };
      const bare = await row();
      expectFits(bare);
      // Not vacuous: two digits on Issues only.
      expect(bare.togglesText).toMatch(/Issues only\s*1\d/);

      const one = page.getByRole("button", { name: /^Star / }).first();
      await toggleStar(page, () => one.click());
      const starred = await row();
      expectFits(starred);
      expect(starred.togglesText).toMatch(/Starred\s*1$/);
      // The toggles stay beside the segments: their top is not below the segments' bottom.
      expect(starred.togglesTop).toBeLessThan(starred.segmentsBottom);
      expect(starred.togglesLeft).toBeGreaterThanOrEqual(starred.segmentsRight);
      expect(starred.togglesRight).toBeLessThanOrEqual(starred.sectionRight + 0.5);
      // Nothing on the page moves, and the field in the margin still lines up with the row.
      expect(starred.mainTop).toBeCloseTo(bare.mainTop, 0);
      expect(Math.abs(starred.fieldMid - starred.rowMid)).toBeLessThan(2);

      // And with two digits on Starred as well: eleven more stars, on a page drawn afresh.
      await page.evaluate(
        (ids) => localStorage.setItem("status-bar:starred", JSON.stringify(ids)),
        CATALOG.slice(0, 11).map((entry) => entry.id),
      );
      await page.reload();
      await hydrated(page);
      await pinFace();
      await pressRefresh(page, page.getByRole("button", { name: "Refresh status now" }).first());
      await expect(page.getByRole("button", { name: /^Starred\s*11$/ })).toBeVisible();
      // Not vacuous: the row was drawn in the face under test.
      const drawn = await toggleFonts();
      expect(drawn.some(isInter), `the toggles are drawn in ${drawn}`).toBe(face === "Inter");
      await stress();
      const many = await row();
      expectFits(many);
      // Spaced out, the widest state (two digits on both toggles) has to have overflowed the segments.
      if (spacing) expect(many.segmentsScrollWidth).toBeGreaterThan(many.segmentsClientWidth);
      expect(many.togglesText).toMatch(/Starred\s*11$/);
      expect(many.togglesTop).toBeLessThan(many.segmentsBottom);
      expect(many.togglesLeft).toBeGreaterThanOrEqual(many.segmentsRight);
      expect(many.togglesRight).toBeLessThanOrEqual(many.sectionRight + 0.5);
      expect(many.mainTop).toBeCloseTo(bare.mainTop, 0);
    });
  }
}
