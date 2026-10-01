import { expect, type Page, test } from "@playwright/test";
import { calmBoard, fixtureBoard, serveBoard } from "./fixture-board";

const cards = (page: Page) => page.locator('article[id^="service-"]');
async function settle(page: Page, y: number) {
  await page.evaluate(
    (top) =>
      new Promise<void>((r) => {
        window.scrollTo(0, top);
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      }),
    y,
  );
}
for (const kind of ["none", "calm"] as const) {
  for (const [w, h] of [
    [1280, 720],
    [1280, 900],
    [1440, 1000],
  ] as const) {
    test(`dock ${kind} ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      if (kind !== "none")
        await serveBoard(page, () => (kind === "calm" ? calmBoard(Date.now()) : fixtureBoard(Date.now())));
      await page.goto("/");
      await expect(cards(page)).toHaveCount(14);
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
      if (kind !== "none") {
        await page.getByRole("button", { name: "Refresh status now" }).first().click();
        await page.waitForTimeout(1500);
      }
      const natural = await page
        .locator(".search-dock")
        .evaluate((e) => e.getBoundingClientRect().top + window.scrollY);
      await settle(page, natural + 100);
      await page.waitForTimeout(300);
      await page.getByLabel("Search services").fill("zzzzqq");
      await expect(cards(page)).toHaveCount(0);
      await settle(page, await page.evaluate(() => window.scrollY));
      const info = await page.evaluate(() => ({
        dock: document.querySelector<HTMLElement>(".search-dock")?.style.getPropertyValue("--dock"),
        y: window.scrollY,
        max: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        body: document.querySelector(".board-body")?.getBoundingClientRect().height,
        vp: innerHeight,
      }));
      const sweep: string[] = [];
      for (let k = 30; k >= 0; k -= 3) {
        await settle(page, info.max - k);
        sweep.push(`${k}:${await page.locator(".search-dock").evaluate((e) => e.style.getPropertyValue("--dock"))}`);
      }
      console.log(`SWEEP ${kind} ${w}x${h} ${sweep.join(" ")}`);
      console.log(`INFO ${kind} ${w}x${h} natural=${Math.round(natural)} ${JSON.stringify(info)}`);
    });
  }
}
