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

// Starring a card and a refresh move cards inside a view transition
// (withViewTransition in src/components/status/effects.ts). The browser
// first snapshots every named card and holds the update until then; with the
// glass blur that can block a software-rendered WebKit for seconds, and the
// page then plays a transition that takes the pointer. Every transition is
// recorded here, capture and play alike, so tests can wait for the whole of it.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const tracked = window as Window & { __vts?: Promise<unknown>[] };
    tracked.__vts = [];
    if (typeof document.startViewTransition !== "function") return;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((...args: Parameters<typeof start>) => {
      const transition = start(...args);
      tracked.__vts?.push(transition.finished.catch(() => undefined));
      return transition;
    }) as typeof document.startViewTransition;
  });
});

/** How long a view transition may take before the wait gives up with a clear message. */
const TRANSITION_LIMIT_MS = 20_000;

/**
 * Waits until every view transition the page has started, including any
 * started meanwhile, has finished. A software-rendered browser can take
 * seconds over one, so a wait past a second is recorded on the test and
 * logged, where a CI log shows it; one that never ends fails with its own
 * message instead of running into the test's timeout.
 */
async function transitionsDone(page: Page): Promise<void> {
  const began = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const finished = page.evaluate(async () => {
    const tracked = window as Window & { __vts?: Promise<unknown>[] };
    for (let seen = 0; tracked.__vts && seen < tracked.__vts.length; ) {
      seen = tracked.__vts.length;
      await Promise.all(tracked.__vts);
    }
  });
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`view transition did not finish in ${TRANSITION_LIMIT_MS / 1000} s`)),
      TRANSITION_LIMIT_MS,
    );
  });
  // If the timer wins, the evaluate is left behind and may reject once the page closes.
  finished.catch(() => undefined);
  try {
    await Promise.race([finished, stuck]);
  } finally {
    clearTimeout(timer);
  }
  const waited = Date.now() - began;
  const info = test.info();
  info.annotations.push({ type: "view-transition-ms", description: String(waited) });
  if (waited > 1000) console.log(`[vt] ${info.title} waited ${waited} ms`);
}

/** How many view transitions the page has started so far. */
const transitionsStarted = (page: Page) =>
  page.evaluate(() => (window as Window & { __vts?: Promise<unknown>[] }).__vts?.length ?? 0);

/**
 * Runs `press` (a click or a key that toggles a star) and waits for the whole
 * of its view transition. The star's state (aria-pressed) changes only when
 * the browser runs the transition's update callback, after it has captured
 * the old page, which can take seconds on a software-rendered browser: so
 * this proves the press landed by the transition it started, then waits the
 * transition out, and only then can the caller read the state. Without
 * view transitions (or with reduced motion) the update is synchronous and
 * nothing is started, so it goes straight to the state.
 */
async function toggleStar(page: Page, press: () => Promise<void>): Promise<void> {
  const animated = await page.evaluate(
    () =>
      typeof document.startViewTransition === "function" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const before = await transitionsStarted(page);
  await press();
  if (animated) await expect.poll(() => transitionsStarted(page)).toBeGreaterThan(before);
  await transitionsDone(page);
}

/**
 * Presses a Refresh button and waits for all of it: the forced response, the
 * button leaving its busy state (which comes after the transition has been
 * started), then the transition itself.
 */
async function pressRefresh(page: Page, button: Locator, press = () => button.click()): Promise<void> {
  const answered = page.waitForResponse(
    (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
  );
  await press();
  await answered;
  await expect(button).toHaveAttribute("aria-busy", "false");
  await transitionsDone(page);
}

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
  // The refresh moves the cards in a view transition; the bar's fade-out below
  // is not judged until that has played out.
  await pressRefresh(page, refresh, () => page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2));
  // Safari leaves a clicked button unfocused; Chromium focuses it, the case that matters.
  if (browserName === "chromium") await expect(refresh).toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 0));
  await barHidden(page, header);
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
// (only the Cloudflare Workers build has a history source). These two run only when the runner is given
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
