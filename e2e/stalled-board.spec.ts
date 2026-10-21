import type { Page, Route } from "@playwright/test";
import { BOARD_FETCH_TIMEOUT_MS, BOARD_REFRESH_TIMEOUT_MS } from "../src/lib/status/board-fetch.ts";
import { fixtureBoard, serveBoard } from "./fixture-board";
import { expect, test } from "./test";

// A board request that the network loses (a connection that hangs, a proxy that never answers) used to hold the page
// for good: the slot's refetch waited for ever with the live line at "Checking…", and a Refresh press that hung left
// the button busy, so it could not be pressed again. Each request now has a bound, and a lost one is retried once.

const SLOT_MS = 120_000;
const SERVER_FN = "**/_serverFn/**";

// Every test here moves the page's time itself (page.clock), so none is pinned to a slot first.
test.use({ pinSlot: false });

/** Holds every request of `method` to a server function without an answer, and counts them. */
async function stall(page: Page, method: "GET" | "POST"): Promise<() => number> {
  let count = 0;
  await page.route(SERVER_FN, (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    count += 1;
    // Never fulfilled: the page has to give up on it.
    return new Promise<void>(() => undefined);
  });
  return () => count;
}

/** Runs the page's clock on by `ms`, a second at a time, so a timer that a settled request sets runs in its turn. */
async function runClock(page: Page, ms: number, done?: () => Promise<boolean>): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    await page.clock.runFor(1_000);
    if (done && (await done())) return;
  }
}

async function open(page: Page): Promise<void> {
  // 31 s into a slot, as in render-cost.spec.ts: the next refetch is 105 s or so away.
  const slotStart = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
  await page.clock.install({ time: slotStart + 31_000 });
  await page.goto("/");
  await expect(page.locator('article[id^="service-"]').first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
}

test.afterEach(async ({ page }) => {
  // The held requests are dropped with the page; nothing is left to answer them.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a scheduled refetch that never answers is given up, retried once, and the board turns Stale", async ({
  page,
}) => {
  const gets = await stall(page, "GET");
  await open(page);
  const live = page.getByTestId("live-bar");
  // Two slots and the time a request is given: the first slot's refetch and its retry have both been given up by
  // then, and the next ones keep failing the same way, until the board on screen is old enough to say so.
  await runClock(page, 2 * SLOT_MS + BOARD_FETCH_TIMEOUT_MS);
  expect(gets(), "the lost request was retried").toBeGreaterThanOrEqual(2);
  await runClock(page, 3 * SLOT_MS, async () => ((await live.textContent()) ?? "").includes("Stale"));
  await expect(live).toContainText("Stale");
  await expect(live).not.toContainText("Checking");
  await expect(page.getByRole("alert")).toContainText("Could not refresh official sources");
});

test("a Refresh press that never answers lets go of the button, and the next press asks again", async ({ page }) => {
  const now = Date.now();
  await serveBoard(page, () => fixtureBoard(now));
  const posts = await stall(page, "POST");
  await open(page);
  const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  expect(posts()).toBe(1);
  await runClock(
    page,
    BOARD_REFRESH_TIMEOUT_MS + 2_000,
    async () => (await refresh.getAttribute("aria-busy")) === "false",
  );
  // The press fell back to the cached board, which answered, and the button is free again.
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await refresh.click();
  await expect.poll(posts).toBe(2);
});
