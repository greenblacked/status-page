import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { BoardSnapshot } from "../src/lib/status/types.ts";
import { fixtureBoard, serveBoard } from "./fixture-board";

// The Details pop-up of the Releases cards: every channel, OS or version a tracker holds, with its changelog
// where the source has one. Opened from the card's main area or by keyboard, a modal dialog on every size,
// centred on a desktop and a sheet from the bottom edge on a phone.

const SERVICES = 20;
const cards = (page: Page) => page.locator('article[id^="service-"]');
const dialog = (page: Page) => page.locator("dialog[data-release-details]");

/**
 * Waits until the dialog's entrance is over: the sheet has risen from the bottom edge, or the panel has eased in. It
 * is asked of the dialog's own transform, which is none once it has landed (@starting-style gives it a translate and
 * a scale to start from), as well as of document.getAnimations(). On an iPhone in CI a sheet was measured 52px below
 * the viewport after the animations alone had been waited out; whether the list was missing the entrance is not
 * established, so the transform is the direct check and the animations are a second condition.
 */
async function entered(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const open = document.querySelector("dialog[data-release-details]");
    return (
      open !== null &&
      getComputedStyle(open).transform === "none" &&
      document.getAnimations().every((animation) => animation.playState !== "running")
    );
  });
}

/** The fixture board on the page, after hydration and one Refresh, which is how the fixture reaches the cards. */
async function openBoard(
  page: Page,
  board: () => BoardSnapshot = () => fixtureBoard(Date.now()),
  ready = "Stable 7.21",
): Promise<void> {
  await serveBoard(page, board);
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
  await expect(page.locator("#service-mikrotik [data-card-header] p")).toContainText(ready);
}

const trigger = (page: Page, id: string) => page.locator(`#service-${id} [data-release-details-trigger]`);

test("every Releases card has a Details button, and only they do", async ({ page }) => {
  await openBoard(page);
  for (const id of ["mikrotik", "apple-os", "windows", "android-os"]) {
    await expect(trigger(page, id)).toHaveCount(1);
    await expect(trigger(page, id)).toHaveText(/^Details/);
    await expect(trigger(page, id)).toHaveAttribute("aria-haspopup", "dialog");
  }
  await expect(page.locator("[data-release-details-trigger]")).toHaveCount(4);
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

test("a tracker's row names each version's note after it, and a version without one reads as before", async ({
  page,
}) => {
  await openBoard(page);
  const line = (id: string) => page.locator(`#service-${id} [data-card-header] p`);
  // RouterOS: the fresh stable channel, its note, then the long-term channel and its own.
  await expect(line("mikrotik")).toContainText(
    /Stable 7\.21 · \w{3} \d{1,2} · 23 changes: bgp, bridge, wifi \+9 more · 2 important · Long-term 7\.18\.2 · \w{3} \d{1,2} · 1 change: dhcpv4-server/,
  );
  await expect(line("mikrotik").locator("[data-release-note]")).toHaveCount(2);
  // Windows: the update type of each version's latest build.
  await expect(line("windows")).toContainText(
    /26H2 26300\.1000 · \w{3} \d{1,2} · Security update · 26H1 28000\.1575 · \w{3} \d{1,2} · Optional preview/,
  );
  // Apple's feed gives none, and the row is what it was.
  await expect(line("apple-os").locator("[data-release-note]")).toHaveCount(0);
  await expect(line("apple-os")).toContainText(/^New release iOS 27\.2 beta 2/);
});

test("the Details show RouterOS's important lines first, then the count and every area", async ({ page }) => {
  await openBoard(page);
  await trigger(page, "mikrotik").click();
  const stable = dialog(page).locator("[data-release-entry]").nth(0);
  const note = stable.locator("[data-release-note-details]");
  await expect(note.getByRole("list", { name: "Important changes" }).getByRole("listitem")).toHaveCount(2);
  await expect(note).toContainText("Important · lte - fixed a crash when a modem is removed during a firmware update");
  await expect(note).toContainText("23 changes in 12 areas: bgp, bridge, wifi, lte,");
  await expect(note).toContainText("routing.");
  // The important lines come first, the sentence after them, the first changes after both.
  const order = await stable.evaluate((entry) => {
    const at = (selector: string) => {
      const found = entry.querySelector(selector);
      return found ? [...entry.querySelectorAll("*")].indexOf(found) : -1;
    };
    return [
      at('[aria-label="Important changes"]'),
      at("[data-release-note-details] > p"),
      at('[aria-label="Changes"]'),
    ];
  });
  expect(order[0]).toBeGreaterThan(-1);
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  // The second channel has a count and no important lines; the third has no note and says so.
  const longTerm = dialog(page).locator("[data-release-entry]").nth(1);
  await expect(longTerm).toContainText("1 change in 1 area: dhcpv4-server.");
  await expect(longTerm.getByRole("list", { name: "Important changes" })).toHaveCount(0);
  const testing = dialog(page).locator("[data-release-entry]").nth(2);
  await expect(testing.locator("[data-release-note-details]")).toHaveCount(0);
  await expect(testing).toContainText("No notes text from MikroTik changelogs.");
});

test("the Details show a Windows version's update type, with the KB article linked only where the table links it", async ({
  page,
}) => {
  await openBoard(page);
  await trigger(page, "windows").click();
  const entries = dialog(page).locator("[data-release-entry]");
  await expect(entries.nth(0)).toContainText("2026-09 B: the monthly security update.");
  const kb = entries.nth(0).getByRole("link", { name: /^KB5000000 for 26H2/ });
  await expect(kb).toHaveAttribute("href", "https://support.microsoft.com/help/5000000");
  await expect(kb).toHaveAttribute("target", "_blank");
  await expect(kb).toHaveAttribute("rel", "noreferrer");
  await expect(entries.nth(0)).not.toContainText("No notes text");
  // 26H1's table names its article in text only: the number, no link, and no link invented.
  await expect(entries.nth(1)).toContainText(
    "2026-09 D: an optional, non-security preview of the next monthly update.",
  );
  await expect(entries.nth(1)).toContainText("KB5000050");
  await expect(entries.nth(1).getByRole("link", { name: /KB5000050/ })).toHaveCount(0);
});

test("a long note wraps under the version on a phone without widening the row or losing Details", async ({ page }) => {
  await openBoard(page);
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of ["mikrotik", "windows"]) {
      const card = page.locator(`#service-${id}`);
      await card.scrollIntoViewIfNeeded();
      const measure = await card.evaluate((article) => {
        const box = article.getBoundingClientRect();
        const header = article.querySelector("[data-card-header]")?.getBoundingClientRect();
        const button = article.querySelector("[data-release-details-trigger]")?.getBoundingClientRect();
        const notes = [...article.querySelectorAll("[data-release-note]")].map((note) => {
          const rect = note.getBoundingClientRect();
          return { right: rect.right, left: rect.left };
        });
        return {
          wide: article.scrollWidth > article.clientWidth + 1,
          right: box.right,
          headerRight: header?.right ?? 0,
          buttonRight: button?.right ?? 0,
          buttonLeft: button?.left ?? 0,
          notes,
        };
      });
      expect(measure.wide, `${id} at ${width}px`).toBe(false);
      expect(measure.right, `${id} at ${width}px`).toBeLessThanOrEqual(width);
      expect(measure.buttonLeft, `${id} Details at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(measure.buttonRight, `${id} Details at ${width}px`).toBeLessThanOrEqual(width);
      for (const note of measure.notes) {
        expect(note.left, `${id} note at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(note.right, `${id} note at ${width}px`).toBeLessThanOrEqual(measure.headerRight + 1);
      }
    }
  }
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
  // The link is to Apple's post about the release, which links the notes: it says so and not "Release notes".
  const link = entries.nth(0).getByRole("link", { name: /Apple Developer post for iOS/ });
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
  await expect(entries.nth(1)).toContainText(/Feb 10/);
  await expect(entries.nth(1)).toContainText(/updated \w{3} \d+/);
  await expect(entries.nth(1).getByRole("link")).toHaveAttribute("href", /^https:\/\/learn\.microsoft\.com\//);
});

test("Android shows each version with its own page and says the page gives no notes or date", async ({ page }) => {
  await openBoard(page);
  await trigger(page, "android-os").click();
  const entries = dialog(page).locator("[data-release-entry]");
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0).getByRole("heading", { level: 3 })).toHaveText("Android 17");
  // The name is the version, and "released" is not one: nothing is printed twice or made up.
  await expect(entries.nth(0)).not.toContainText("released");
  await expect(entries.nth(0)).not.toContainText("New release");
  await expect(entries.nth(0)).not.toContainText("build");
  await expect(entries.nth(0)).toContainText("No notes text from Android Developers releases.");
  await expect(entries.nth(0).getByRole("link", { name: /Android 17 page for Android 17/ })).toHaveAttribute(
    "href",
    "https://developer.android.com/about/versions/17",
  );
  await expect(entries.nth(3).getByRole("link")).toHaveAttribute(
    "href",
    "https://developer.android.com/about/versions/14",
  );
});

test("a card that needs a look has the Details button too, opened from the button or the card's name", async ({
  page,
}) => {
  // A tracker with a new release in the attention list (maintenance), which is the card layout, not the row.
  await openBoard(page, () => {
    const board = fixtureBoard(Date.now());
    return {
      ...board,
      services: board.services.map((service) =>
        service.id === "windows" ? { ...service, health: "maintenance" as const } : service,
      ),
    };
  });
  const card = page.locator("#service-windows");
  await expect(card.locator("[data-card-header]").first()).toBeVisible();
  const button = trigger(page, "windows");
  await expect(button).toHaveCount(1);
  await expect(button).toHaveText(/^Details/);
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText("Details · Windows 11");
  await expect(dialog(page).locator("[data-release-entry]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  // The card's name opens it too, as in a row; the star, which sits beside the name, does not.
  await card.getByRole("heading", { name: "Windows 11" }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page)
    .getByRole("button", { name: /^Close details/ })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  await card.getByRole("button", { name: "Star Windows 11" }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test("a press that starts in the panel and ends on the backdrop does not close it", async ({ page }) => {
  await openBoard(page);
  await trigger(page, "mikrotik").click();
  await expect(dialog(page)).toBeVisible();
  // On a phone the panel is a sheet that slides up from the bottom edge: measured while it moves, the note is not
  // where the press lands.
  await entered(page);
  const entry = await dialog(page).locator("[data-release-entry]").first().boundingBox();
  if (!entry) throw new Error("the pop-up has no entry");
  const startX = entry.x + 20;
  const startY = entry.y + 20;
  expect(
    await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-release-entry]"),
      [startX, startY],
    ),
    "the press starts inside the sheet",
  ).toBe(true);
  // A drag, as a text selection is: down on a note, up over the dimmed page.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(3, 3, { steps: 4 });
  await page.mouse.up();
  await expect(dialog(page)).toBeVisible();
  // A whole click on the backdrop still closes it, with the drag's selection still there as it is for a real user.
  await page.mouse.click(3, 3);
  await expect(dialog(page)).toHaveCount(0);
});

test("keeps its title and close button in view while a long list scrolls", async ({ page }) => {
  await openBoard(
    page,
    () => {
      const board = fixtureBoard(Date.now());
      const long = Array.from({ length: 12 }, (_, at) => ({
        name: `RouterOS channel ${at + 1}`,
        health: "operational" as const,
        detail: `7.${at}`,
        release: {
          version: `7.${at}`,
          notes: Array.from(
            { length: 5 },
            (_, line) => `note ${line + 1} of channel ${at + 1} - changed something here`,
          ),
        },
      }));
      return {
        ...board,
        services: board.services.map((service) =>
          service.id === "mikrotik" ? { ...service, components: long } : service,
        ),
      };
    },
    "RouterOS channel 1",
  );
  await trigger(page, "mikrotik").click();
  await expect(dialog(page)).toBeVisible();
  await entered(page);
  const list = dialog(page).getByRole("list", { name: "Releases" });
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  // The panel stays inside the viewport, and its header is still on screen at the end of the list.
  const view = await page.evaluate(() => window.innerHeight);
  const panel = await dialog(page).boundingBox();
  if (!panel) throw new Error("no panel");
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(panel.y + panel.height).toBeLessThanOrEqual(view + 0.5);
  await expect(dialog(page).getByRole("button", { name: /^Close details/ })).toBeInViewport();
  await expect(dialog(page).getByRole("heading", { level: 2 })).toBeInViewport();
});

test("is a small centred panel on a desktop and a sheet from the bottom edge on a phone", async ({ page }) => {
  await openBoard(page);
  await trigger(page, "mikrotik").click();
  await expect(dialog(page)).toBeVisible();
  // Let the entrance settle before measuring.
  await entered(page);
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
    for (const id of ["mikrotik", "apple-os", "windows", "android-os"]) {
      await trigger(page, id).click();
      await expect(dialog(page)).toBeVisible();
      await entered(page);
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
