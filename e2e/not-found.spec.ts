import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./test";

// A URL that is not on the board keeps the board's voice and type instead of the router's unbranded
// default. (The error page is a component test: a production build has no way to break on purpose.)

test.describe("a URL that is not on the board", () => {
  test("answers 404 with the page, in the server's HTML", async ({ request }) => {
    const response = await request.get("/nope");
    expect(response.status()).toBe(404);
    const html = await response.text();
    expect(html).toContain("<title>Not found · Status</title>");
    expect(html).toContain("Nothing here.");
    // One title, or the browser reads only the first.
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  test("says so in the tab and the page, and leads back to the board", async ({ page }) => {
    await page.goto("/nope");
    await expect(page).toHaveTitle("Not found · Status");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing here.");
    const back = page.getByRole("link", { name: "Back to the board." });
    await expect(back).toHaveAttribute("href", "/");
    await back.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle(/^(\(\d+\) )?Status$/);
  });

  test("names the page Status Page, centred over the content width", async ({ page }) => {
    await page.goto("/nope");
    const mark = page.getByTestId("wordmark");
    await expect(mark).toHaveText("Status Page");
    const { markCentre, mainCentre } = await page.evaluate(() => {
      const main = document.querySelector("main");
      const text = document.querySelector('[data-testid="wordmark"]');
      if (!main || !text) throw new Error("no main or wordmark");
      const rect = main.getBoundingClientRect();
      const style = getComputedStyle(main);
      const range = document.createRange();
      range.selectNodeContents(text);
      const run = range.getBoundingClientRect();
      const left = rect.left + Number.parseFloat(style.paddingLeft);
      const right = rect.right - Number.parseFloat(style.paddingRight);
      return { markCentre: (run.left + run.right) / 2, mainCentre: (left + right) / 2 };
    });
    expect(Math.abs(markCentre - mainCentre)).toBeLessThanOrEqual(1);
  });

  test("has no accessibility violations in either appearance", async ({ page }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto("/nope");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, colorScheme).toEqual([]);
    }
  });
});
