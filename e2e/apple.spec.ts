import type { Locator } from "@playwright/test";
import { expect, test } from "./test";

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

test("manifest has a maskable icon of its own, a name and a language", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as {
    lang?: string;
    name?: string;
    short_name?: string;
    icons: { src: string; sizes?: string; purpose?: string }[];
  };
  expect(manifest.lang).toBe("en");
  expect(manifest.name).toBe("Status");
  expect(manifest.short_name).toBe("Status");
  const maskable = manifest.icons.find((icon) => icon.purpose === "maskable");
  const any512 = manifest.icons.find((icon) => icon.sizes === "512x512" && icon.purpose === "any");
  // Drawn for the mask's safe zone, so not the "any" icon reused.
  expect(maskable?.src).toBe("/icon-512-maskable.png");
  expect(maskable?.src).not.toBe(any512?.src);
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
});

test("loads apple.css and logs no console errors", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  const rules = await page.evaluate(() =>
    [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)),
  );
  expect(rules.some((rule) => rule.includes("touch-action: manipulation"))).toBe(true);
  expect(problems).toEqual([]);
});

test("never shows the Alerts button on an iPhone, before or after hydration", async ({ page, isMobile }) => {
  test.skip(!isMobile, "an iPhone reports touch points, which the phone project does");
  // What Cocoa WebKit has and Chromium lacks: navigator.standalone.
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: false }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-alerts", "unsupported");
  const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
  const alerts = page.getByRole("button", { name: "Notifications" });
  // Hidden by the boot script from the first paint, while the server's markup still has it.
  await expect(alerts).toBeHidden();
  const before = await refresh.boundingBox();
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
  await expect(alerts).toHaveCount(0);
  // Taking it out of the tree after hydration moves nothing.
  expect(await refresh.boundingBox()).toEqual(before);
});

test("shows the Alerts button in the first paint where alerts work", async ({ page }, testInfo) => {
  test.skip(/iPhone|iPad/.test(testInfo.project.name), "Cocoa WebKit on a touch device never shows page alerts");
  // Chrome on Android can show them, and so can a desktop.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).not.toHaveAttribute("data-alerts", /.*/);
  await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
});

test("buttons opt out of double-tap zoom on a touch device", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the touch rule is checked on the phone project");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
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
