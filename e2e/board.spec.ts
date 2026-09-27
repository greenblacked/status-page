import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const SERVICES = 14;
const cards = (page: Page) => page.locator('article[id^="service-"]');

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
  // After hydration the title leads with how many services need attention: "(2) Status Bar".
  await expect(page).toHaveTitle(/^(\(\d+\) )?Status Bar$/);
  await expect(cards(page)).toHaveCount(SERVICES);
  // Hydration runs after the first paint; give React time to complain.
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});

test("has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} nodes)`);
  expect(blocking).toEqual([]);
});

test("starts the tab order with a skip link that moves focus to the services", async ({ page, isMobile }) => {
  test.skip(isMobile, "no Tab key on a touch device");
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to services" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#services")).toBeFocused();
  // Script moves focus without leaving #services in the address.
  expect(new URL(page.url()).hash).toBe("");
});

test("opens with the search from the address and announces a new result count", async ({ page }) => {
  await page.goto("/?q=aws");
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

function historyDocument(
  services: Record<string, { days: Array<{ date: string; worst: string; samples: number; up: number }> }>,
) {
  return {
    schema: 1,
    updatedAt: "2026-09-27T12:00:00.000Z",
    timezone: "UTC",
    retentionDays: 30,
    services,
  };
}

function day(date: string, worst: string, samples = 1, up = worst === "operational" ? 1 : 0) {
  return { date, worst, samples, up };
}

test("shows a 30-day history strip on a card with history and none without", async ({ page }) => {
  // aws always has a card; gcp is omitted from the document so its strip stays empty.
  // Dates are relative to "today" so the strip stays inside the 30-day retention window.
  const today = new Date();
  const days = Array.from({ length: 10 }, (_, index) => {
    const stamp = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (9 - index)));
    const date = stamp.toISOString().slice(0, 10);
    return day(date, index === 5 ? "degraded" : "operational", 2, index === 5 ? 0.5 : 1);
  });
  await page.route("**/api/history.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(historyDocument({ aws: { days } })),
    });
  });

  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);

  const aws = page.locator("#service-aws");
  await expect(aws).toBeVisible();
  await expect(aws.getByRole("img", { name: /uptime history/i })).toBeVisible();
  await expect(aws.getByText(/uptime/i).first()).toBeVisible();

  const gcp = page.locator("#service-gcp");
  await expect(gcp).toBeVisible();
  await expect(gcp.getByRole("img", { name: /uptime history/i })).toHaveCount(0);
});

test("loads the board when history is cold or empty", async ({ page }) => {
  await page.route("**/api/history.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(historyDocument({})),
    });
  });

  const problems = watchConsole(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(page.getByRole("img", { name: /uptime history/i })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});
