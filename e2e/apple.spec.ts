import { expect, type Locator, test } from "@playwright/test";

// What Safari and iOS read from the page head and the manifest, and the touch
// rules in src/apple.css. Like the rest of the suite these hold whatever the
// vendors say today.

test("head carries the format-detection meta", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('meta[name="format-detection"]')).toHaveAttribute(
    "content",
    "telephone=no, date=no, address=no, email=no",
  );
});

test("manifest has a maskable icon and a language", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as { lang?: string; icons: { src: string; purpose?: string }[] };
  expect(manifest.lang).toBe("en");
  expect(manifest.icons.some((icon) => icon.purpose === "maskable" && icon.src === "/icon-512.png")).toBe(true);
});

test("loads apple.css and logs no console errors", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  await page.waitForLoadState("networkidle");
  const rules = await page.evaluate(() =>
    [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)),
  );
  expect(rules.some((rule) => rule.includes("touch-action: manipulation"))).toBe(true);
  expect(problems).toEqual([]);
});

test("buttons opt out of double-tap zoom on a touch device", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the touch rule is checked on the phone project");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  // Named, not `.first()`: on an iPhone the Alerts button server-renders and
  // is removed right after hydration (use-alerts.ts, "unsupported"), and
  // WebKit reports "" for the computed style of a detached node. The poll
  // also survives a remount between resolving the locator and reading it.
  const touchAction = (locator: Locator) =>
    locator.evaluate((element) => (element.isConnected ? getComputedStyle(element).touchAction : "detached"));
  const button = page.getByRole("button", { name: "Refresh status now" });
  await expect(button).toBeVisible();
  await expect.poll(() => touchAction(button)).toBe("manipulation");
  const link = page.getByRole("link").first();
  await expect.poll(() => touchAction(link)).toBe("manipulation");
});
