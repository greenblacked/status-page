import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { fixtureBoard, serveBoard } from "./fixture-board";

// The Details pop-up of the Releases cards: every channel, OS or version a tracker holds, with its changelog
// where the source has one. Opened from the card's main area or by keyboard, a modal dialog on every size,
// centred on a desktop and a sheet from the bottom edge on a phone.

const SERVICES = 15;
const cards = (page: Page) => page.locator('article[id^="service-"]');
const dialog = (page: Page) => page.locator("dialog[data-release-details]");

/** The fixture board on the page, after hydration and one Refresh, which is how the fixture reaches the cards. */
async function openBoard(page: Page): Promise<void> {
  await serveBoard(page, () => fixtureBoard(Date.now()));
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
  const answered = page.waitForResponse(
    (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
  );
  await refresh.click();
  await answered;
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#service-mikrotik [data-card-header] p")).toContainText("Stable 7.21");
}

const trigger = (page: Page, id: string) => page.locator(`#service-${id} [data-release-details-trigger]`);

test("every Releases card has a Details button, and only they do", async ({ page }) => {
  await openBoard(page);
  for (const id of ["mikrotik", "apple-os", "windows"]) {
    await expect(trigger(page, id)).toHaveCount(1);
    await expect(trigger(page, id)).toHaveText(/^Details/);
    await expect(trigger(page, id)).toHaveAttribute("aria-haspopup", "dialog");
  }
  await expect(page.locator("[data-release-details-trigger]")).toHaveCount(3);
  await expect(dialog(page)).toHaveCount(0);
});

test("a click on the card's name or line opens Details, a click on the star or the link does not", async ({ page }) => {
  await openBoard(page);
  const card = page.locator("#service-mikrotik");
  await card.scrollIntoViewIfNeeded();
  // The button's stretched reach sits over the name, so a pointer lands on the button, not on the heading: click
  // the pixel, as a person would, instead of the element (which Playwright refuses while the button covers it).
  const name = await card.getByRole("heading", { name: "MikroTik RouterOS" }).boundingBox();
  if (!name) throw new Error("the card has no name");
  await page.mouse.click(name.x + 8, name.y + name.height / 2);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText("Details · MikroTik RouterOS");
  await dialog(page)
    .getByRole("button", { name: /^Close details/ })
    .click();
  await expect(dialog(page)).toHaveCount(0);

  const line = await card.locator("[data-card-header] p").boundingBox();
  if (!line) throw new Error("the card has no line");
  await page.mouse.click(line.x + 12, line.y + 6);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // The star keeps its behaviour: it toggles, and opens nothing.
  const star = card.getByRole("button", { name: "Star MikroTik RouterOS" });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect(dialog(page)).toHaveCount(0);
  // The link to the status page is the vendor's page, in a new tab, and is not under the button's reach.
  const link = card.getByRole("link", { name: "MikroTik RouterOS status page" });
  await expect(link).toHaveAttribute("target", "_blank");
  const box = await link.boundingBox();
  if (!box) throw new Error("the status page link has no box");
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("aria-label"),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toBe("MikroTik RouterOS status page");
});

test("opens with Enter and Space, holds focus, closes with Escape and gives focus back", async ({ page }) => {
  await openBoard(page);
  const button = trigger(page, "apple-os");
  for (const key of ["Enter", "Space"]) {
    await button.focus();
    await page.keyboard.press(key);
    await expect(dialog(page)).toBeVisible();
    // Focus moved into the dialog, and Tab cannot take it to the page behind (the browser's own chrome is the
    // one other place it can rest, and then nothing in the page has it).
    expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(
          () => document.activeElement === document.body || document.activeElement?.closest("dialog") !== null,
        ),
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  }
});

test("closes on a click outside it, and on its close button, returning focus to the button", async ({ page }) => {
  await openBoard(page);
  await trigger(page, "windows").click();
  await expect(dialog(page)).toBeVisible();
  // The backdrop is the whole page behind the panel: the top-left corner is never the panel.
  await page.mouse.click(3, 3);
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page, "windows")).toBeFocused();

  await trigger(page, "windows").click();
  await dialog(page).getByRole("button", { name: "Close details for Windows 11" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page, "windows")).toBeFocused();
});

test("is a labelled modal dialog that makes the page behind it inert", async ({ page }) => {
  await openBoard(page);
  await trigger(page, "mikrotik").click();
  const panel = dialog(page);
  await expect(panel).toHaveAttribute("aria-modal", "true");
  const labelled = await panel.getAttribute("aria-labelledby");
  await expect(page.locator(`#${labelled}`)).toHaveText("Details · MikroTik RouterOS");
  expect(await panel.evaluate((element: HTMLDialogElement) => element.matches(":modal"))).toBe(true);
  // The shortcuts stand down while it is open: "?" would otherwise open Settings over it.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test("RouterOS lists every channel with its version, day, New release flag, notes and changelog link", async ({
  page,
}) => {
  await openBoard(page);
  await trigger(page, "mikrotik").click();
  const entries = dialog(page).locator("[data-release-entry]");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0).getByRole("heading", { level: 3 })).toHaveText("Stable");
  await expect(entries.nth(0)).toContainText("New release");
  await expect(entries.nth(0)).toContainText("7.21");
  await expect(entries.nth(0).getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveCount(3);
  await expect(entries.nth(0)).toContainText("bgp - fixed route refresh handling when the peer restarts");
  await expect(entries.nth(0).getByRole("link", { name: /Release notes for Stable/ })).toHaveAttribute(
    "href",
    "https://download.mikrotik.com/routeros/7.21/CHANGELOG",
  );
  await expect(entries.nth(1)).not.toContainText("New release");
  await expect(entries.nth(1).getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveCount(1);
  // The testing channel's changelog could not be read: it says so, and invents nothing.
  await expect(entries.nth(2)).toContainText("No notes text from MikroTik changelogs.");
  await expect(entries.nth(2).getByRole("list", { name: "Changes" })).toHaveCount(0);
  // The row's line names two versions; the pop-up has all three.
  await expect(entries.nth(2)).toContainText("7.22beta3");
});

test("Apple OS shows the build, the date and the page on apple.com, and says its feed has no notes", async ({
  page,
}) => {
  await openBoard(page);
  await trigger(page, "apple-os").click();
  const entries = dialog(page).locator("[data-release-entry]");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("27.2 beta 2");
  await expect(entries.nth(0)).toContainText("build 24B5089g");
  await expect(entries.nth(0)).toContainText("New release");
  await expect(entries.nth(0)).toContainText("No notes text from Apple Developer Releases.");
  const link = entries.nth(0).getByRole("link", { name: /Release notes for iOS/ });
  await expect(link).toHaveAttribute("href", /^https:\/\/developer\.apple\.com\//);
  await expect(link).toHaveAttribute("rel", "noreferrer");
});

test("Windows 11 shows each version's build and UTC days, and links Microsoft's page", async ({ page }) => {
  await openBoard(page);
  await trigger(page, "windows").click();
  const entries = dialog(page).locator("[data-release-entry]");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0).getByRole("heading", { level: 3 })).toHaveText("26H2");
  await expect(entries.nth(0)).toContainText("build 26300.1000");
  await expect(entries.nth(0)).toContainText("New release");
  await expect(entries.nth(1)).toContainText("build 28000.1575");
  await expect(entries.nth(1)).toContainText(/10 Feb/);
  await expect(entries.nth(1)).toContainText(/updated \d+ \w{3}/);
  await expect(entries.nth(1).getByRole("link")).toHaveAttribute("href", /learn\.microsoft\.com/);
});

test("is a small centred panel on a desktop and a sheet from the bottom edge on a phone", async ({ page }) => {
  await openBoard(page);
  await trigger(page, "mikrotik").click();
  await expect(dialog(page)).toBeVisible();
  // Let the entrance settle before measuring.
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  const geometry = await dialog(page).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
  });
  const viewport = await page.evaluate(() => ({
    // The layout viewport: a page scrollbar is not part of what the dialog centres in.
    width: document.documentElement.clientWidth,
    height: window.innerHeight,
  }));
  if (viewport.width < 640) {
    expect(geometry.bottom).toBeCloseTo(viewport.height, 0);
    expect(geometry.left).toBeCloseTo(0, 0);
    expect(geometry.right).toBeCloseTo(viewport.width, 0);
    const radius = await dialog(page)
      .locator(".sheet")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.borderTopLeftRadius, style.borderBottomLeftRadius];
      });
    expect(radius[0]).not.toBe("0px");
    expect(radius[1]).toBe("0px");
  } else {
    expect(geometry.width).toBeLessThanOrEqual(416.5);
    // Centred in the viewport, less the page's thin scrollbar (up to 15px, so 7.5px of offset).
    expect(Math.abs((geometry.left + geometry.right) / 2 - viewport.width / 2)).toBeLessThanOrEqual(8);
    expect(geometry.top).toBeGreaterThan(0);
    expect(geometry.bottom).toBeLessThan(viewport.height);
  }
});

test("its entrance is still under Reduce Motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openBoard(page);
  await trigger(page, "mikrotik").click();
  await expect(dialog(page)).toBeVisible();
  const motion = await dialog(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, transition: style.transitionDuration };
  });
  expect(motion.transform).toBe("none");
  expect(motion.transition).toBe("0s");
});

for (const scheme of ["light", "dark"] as const) {
  test(`has no accessibility violations open, in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openBoard(page);
    for (const id of ["mikrotik", "apple-os", "windows"]) {
      await trigger(page, id).click();
      await expect(dialog(page)).toBeVisible();
      await page.waitForFunction(() =>
        document.getAnimations().every((animation) => animation.playState !== "running"),
      );
      const results = await new AxeBuilder({ page }).include("dialog[data-release-details]").analyze();
      expect(
        results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((n) => n.target).join(", ")}`),
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
    }
  });
}

for (const reduce of [false, true]) {
  test(`follows the background and Reduce glass (${reduce ? "on" : "off"}): the panel ${reduce ? "is solid" : "is frosted"}`, async ({
    page,
  }) => {
    await page.addInitScript((on) => {
      localStorage.setItem("status-bar:background", "glass");
      if (on) localStorage.setItem("status-bar:reduce-glass", "on");
    }, reduce);
    await openBoard(page);
    await trigger(page, "mikrotik").click();
    await expect(dialog(page)).toBeVisible();
    const filter = await dialog(page)
      .locator(".sheet")
      .evaluate((element) => getComputedStyle(element).backdropFilter);
    if (reduce) expect(filter === "none" || filter === "").toBe(true);
    else expect(filter).toContain("blur");
  });
}
