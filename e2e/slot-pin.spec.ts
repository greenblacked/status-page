import { pinToSlot } from "./support/pin-to-slot";
import { expect, test } from "./test";

// Every test's page starts 30 s into a slot of two minutes (the `pinSlot` fixture in e2e/test.ts), so a turn of the slot
// that adds a row to Recent changes cannot land in the first 90 s of a test, wherever the wall clock is when it starts.

const SLOT_MS = 120_000;
const pageTime = (page: import("@playwright/test").Page) => page.evaluate(() => Date.now());

test("a page starts in the first half of a slot, whatever the wall clock says", async ({ page }) => {
  await page.goto("/healthz");
  const at = (await pageTime(page)) % SLOT_MS;
  // 30 s in, plus the little that has passed since.
  expect(at).toBeGreaterThanOrEqual(30_000);
  expect(at).toBeLessThan(40_000);
});

test("pinning a page that is pinned already does not move it again", async ({ page }) => {
  await pinToSlot(page);
  await page.goto("/healthz");
  const at = (await pageTime(page)) % SLOT_MS;
  expect(at).toBeGreaterThanOrEqual(30_000);
  expect(at).toBeLessThan(40_000);
});

test.describe("a test that opts out", () => {
  test.use({ pinSlot: false });

  test("keeps the wall clock", async ({ page }) => {
    await page.goto("/healthz");
    expect(Math.abs((await pageTime(page)) - Date.now())).toBeLessThan(5_000);
  });
});
