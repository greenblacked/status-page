import { expect, test } from "@playwright/test";

// Times on the board are the viewer's own once the page has hydrated, and UTC before that: the
// server cannot know the viewer's zone, and a hydrating render must print what the server printed.
// The suite pins UTC (playwright.config.ts), so the zone is set here. The `title` of every time is
// the whole moment in UTC, in any zone.

/** The board's as-of time in the hero. */
const asOf = (page: import("@playwright/test").Page) => page.getByText("as of").locator("time");

test.describe("in Berlin", () => {
  test.use({ timezoneId: "Europe/Berlin", locale: "en-GB" });

  test("shows the viewer's own zone once hydrated, and UTC in the title", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    const stamp = asOf(page);
    await expect(stamp).toHaveText(/^\d\d:\d\d\sCES?T$/);
    await expect(stamp).toHaveAttribute("title", /^\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d UTC$/);

    // The same moment: the title's UTC clock is the local clock less the zone's offset (1 h in winter, 2 in summer).
    const iso = (await stamp.getAttribute("datetime")) ?? "";
    expect(iso).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const utc = new Date(iso);
    const title = (await stamp.getAttribute("title")) ?? "";
    expect(
      title.endsWith(
        `${String(utc.getUTCHours()).padStart(2, "0")}:${String(utc.getUTCMinutes()).padStart(2, "0")} UTC`,
      ),
    ).toBe(true);
    const shown = (await stamp.textContent()) ?? "";
    const offset = Number(shown.slice(0, 2)) - utc.getUTCHours();
    expect([1, 2, -22, -23]).toContain(offset);
    expect(shown.endsWith(offset === 2 || offset === -22 ? "CEST" : "CET")).toBe(true);

    // Hydrating from UTC text to local text is not a mismatch.
    expect(problems).toEqual([]);
  });

  test("the server's HTML is UTC, whatever zone asks", async ({ baseURL, browser }) => {
    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
      timezoneId: "Europe/Berlin",
      locale: "en-GB",
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      const stamp = asOf(page);
      await expect(stamp).toHaveText(/^\d\d:\d\d\sUTC$/);
      await expect(stamp).toHaveAttribute("title", /UTC$/);
    } finally {
      await context.close();
    }
  });
});

test("in UTC the hydrated text is the server's text, so nothing moves", async ({ page }) => {
  await page.goto("/");
  const stamp = asOf(page);
  const before = await stamp.textContent();
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  await expect(stamp).toHaveText(/^\d\d:\d\d\sUTC$/);
  expect(await stamp.textContent()).toBe(before);
});
