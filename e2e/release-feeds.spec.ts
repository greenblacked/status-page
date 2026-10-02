import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { BoardSnapshot } from "../src/lib/status/types.ts";
import { feedBoard, fixtureBoard, serveBoard } from "./fixture-board";

// The quiet release line of a status card whose vendor publishes an official release or changelog feed, and the
// Details it opens. It is advisory: it sits beside a card's health and changes none of it. A line wraps between
// its items on a phone and never inside one: a date is never split ("Oct" / "1").

const SERVICES = 20;
/** Phone widths the wrap tests visit, from the narrowest phone to the widest. */
const PHONES = [320, 335, 350, 360, 375, 390, 400, 412, 430];
const WITH_FEED = ["aws", "gcp", "azure", "github", "gitlab", "cs2-europe"];
const cards = (page: Page) => page.locator('article[id^="service-"]');
const dialog = (page: Page) => page.locator("dialog[data-release-details]");
const line = (page: Page, id: string) => page.locator(`#service-${id} [data-release-line]`);
const trigger = (page: Page, id: string) => page.locator(`#service-${id} [data-release-details-trigger]`);

/** The board on the page after hydration and one Refresh, which is how the fixture reaches the cards. */
async function openBoard(page: Page, board: () => BoardSnapshot = () => feedBoard(Date.now())): Promise<void> {
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
  await expect(page.locator("#service-mikrotik [data-card-header] p")).toContainText("Stable 7.21");
}

test("every status card whose vendor has a feed shows its latest entry and a Details button, and no other does", async ({
  page,
}) => {
  await openBoard(page);
  for (const id of WITH_FEED) {
    await expect(line(page, id)).toHaveCount(1);
    await expect(trigger(page, id)).toHaveCount(1);
    await expect(trigger(page, id)).toHaveText(/^Details/);
  }
  await expect(page.locator("[data-release-line]")).toHaveCount(WITH_FEED.length);
  // The four Releases trackers keep their own Details; nothing else has one.
  await expect(page.locator("[data-release-details-trigger]")).toHaveCount(WITH_FEED.length + 4);
  for (const id of ["spotify", "claude", "chatgpt", "epic", "steam", "android"]) {
    await expect(page.locator(`#service-${id} [data-release-line]`)).toHaveCount(0);
  }
});

test("the line sits under the health line: GitLab names its version and day, and the health line is as it was", async ({
  page,
}) => {
  await openBoard(page);
  const header = page.locator("#service-gitlab [data-card-header]");
  await expect(header.locator("p").first()).toContainText("Operational");
  await expect(header.locator("p").first()).toContainText(/\d+\s?ms/);
  await expect(line(page, "gitlab")).toContainText(/^GitLab 18\.4\.1 · \w{3} \d{1,2}/);
  const health = await header.locator("p").first().boundingBox();
  const release = await line(page, "gitlab").boundingBox();
  if (!health || !release) throw new Error("the card has no lines");
  expect(release.y).toBeGreaterThanOrEqual(health.y + health.height - 1);
  // A vendor with no version numbers shows the entry's headline.
  await expect(line(page, "github")).toContainText("Copilot code review is now generally available");
});

test("Details opens the vendor's recent entries: title, day, notes and a link on the vendor's own host", async ({
  page,
}) => {
  await openBoard(page);
  await trigger(page, "gitlab").click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText("Details · GitLab");
  const entries = dialog(page).locator("[data-release-entry]");
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0).getByRole("heading", { level: 3 })).toHaveText("GitLab 18.4.1");
  // A feed entry is never "New release": that tag is the trackers' two-week rule.
  await expect(dialog(page)).not.toContainText("New release");
  await expect(entries.nth(0).getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("GitLab Patch Release: 18.4.1, 18.3.3, 18.2.7");
  const link = entries.nth(0).getByRole("link", { name: /Release post for GitLab 18\.4\.1/ });
  await expect(link).toHaveAttribute(
    "href",
    "https://about.gitlab.com/releases/2026/09/24/patch-release-gitlab-18-4-1-released/",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer");
  // An entry with no notes says so, naming the feed and not the status page.
  await expect(entries.nth(2)).toContainText("No notes text from GitLab releases.");
  await dialog(page)
    .getByRole("button", { name: /^Close details/ })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page, "gitlab")).toBeFocused();
});

test("opens from the keyboard, and a card that needs a look has the line and the button too", async ({ page }) => {
  await openBoard(page);
  for (const id of ["aws", "gcp"]) {
    await expect(page.locator(`#service-${id}`)).toContainText(/Outage|Degraded/);
    await expect(trigger(page, id)).toHaveCount(1);
  }
  await trigger(page, "aws").focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText("Details · Amazon Web Services");
  await expect(dialog(page).locator("[data-release-entry]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page, "aws")).toBeFocused();
  await trigger(page, "gcp").focus();
  await page.keyboard.press("Space");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("on a row with components the button opens Details and leaves the component list as it was", async ({ page }) => {
  await openBoard(page);
  const row = page.locator("#service-cs2-europe details.row-details");
  await expect(row).not.toHaveAttribute("open", "");
  await trigger(page, "cs2-europe").click();
  await expect(dialog(page)).toBeVisible();
  await expect(row).not.toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await trigger(page, "cs2-europe").focus();
  await page.keyboard.press("Space");
  await expect(dialog(page)).toBeVisible();
  await expect(row).not.toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  // The health line still opens and closes the list.
  await page.locator("#service-cs2-europe summary h3").click();
  await expect(row).toHaveAttribute("open", "");
});

test("a card whose feed could not be read keeps its health and shows no line", async ({ page }) => {
  await openBoard(page, () => fixtureBoard(Date.now()));
  await expect(page.locator("[data-release-line]")).toHaveCount(0);
  await expect(page.locator("[data-release-details-trigger]")).toHaveCount(4);
  await expect(page.locator("#service-gitlab")).toContainText("Operational");
  await expect(page.locator("#service-aws")).toContainText("Outage");
});

test("changes neither the health counts nor the order of the cards", async ({ page }) => {
  await openBoard(page, () => fixtureBoard(Date.now()));
  const order = async () => cards(page).evaluateAll((nodes) => nodes.map((node) => node.id));
  const without = await order();
  await openBoard(page);
  expect(await order()).toEqual(without);
});

// "Sep 29", and not the "Oct 00" of "3 Oct 00:05 UTC": a time of day wraps like any text.
const DATE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b(?!:)/g;

/**
 * Every day on a card's lines ("Sep 29") that is spread over more than one line of text, and every release item
 * that is. A Range over the day sits on one row of text while it is whole, and on two when it wraps between "Sep"
 * and "29".
 */
async function splitDays(page: Page): Promise<string[]> {
  return page.evaluate((source) => {
    const pattern = new RegExp(source, "g");
    const split: string[] = [];
    // A text and a dot in two nodes make two rects on one row; it is only a split when they sit on two rows.
    const rows = (rects: DOMRectList) => new Set([...rects].map((rect) => Math.round(rect.top))).size;
    // The release line is read on its own as well as with the card's lines: it is part of the header now, but a
    // regression that moved it out of the header must not take it out of this scan.
    for (const lineEl of document.querySelectorAll("article [data-card-header] p, article [data-release-line]")) {
      const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        for (const match of text.matchAll(pattern)) {
          const range = document.createRange();
          range.setStart(node, match.index ?? 0);
          range.setEnd(node, (match.index ?? 0) + match[0].length);
          if (rows(range.getClientRects()) > 1) {
            split.push(`${lineEl.closest("article")?.id}: "${match[0]}" is split across lines`);
          }
        }
      }
    }
    for (const item of document.querySelectorAll("[data-release-item]")) {
      if (rows(item.getClientRects()) > 1) split.push(`${item.closest("article")?.id}: an item is split`);
      // A flex item is one box whatever it holds, so its parts are measured too: the title, the day.
      for (const part of item.querySelectorAll(":scope > *")) {
        if (rows(part.getClientRects()) > 1) split.push(`${item.closest("article")?.id}: a part of an item is split`);
      }
    }
    return split;
  }, DATE.source);
}

test("a day is never split across lines on a narrow phone, and Details stays on screen", async ({ page }) => {
  await openBoard(page);
  for (const width of PHONES) {
    await page.setViewportSize({ width, height: 900 });
    expect(await splitDays(page), `at ${width}px`).toEqual([]);
    // Nothing pushes the page wider than the phone: no card is wider than the screen, and no Details button is
    // off it (the page itself hides what overflows, so its scroll width says nothing).
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll("article")]
        .filter((card) => card.getBoundingClientRect().right > window.innerWidth + 0.5)
        .map((card) => card.id),
    );
    expect(wide, `at ${width}px`).toEqual([]);
    const boxes = await page.locator("[data-release-details-trigger]").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { right: box.right, left: box.left };
      }),
    );
    expect(boxes.length).toBe(WITH_FEED.length + 4);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
    }
  }
});

test("Details stays on the line of the item it belongs to, and the line is one row, at every phone width", async ({
  page,
}) => {
  await openBoard(page);
  for (const width of PHONES) {
    await page.setViewportSize({ width, height: 900 });
    const apart = await page.evaluate(() => {
      const found: string[] = [];
      for (const lineEl of document.querySelectorAll("[data-release-line]")) {
        const id = lineEl.closest("article")?.id;
        const item = lineEl.querySelector("[data-release-item]");
        const button = lineEl.querySelector("[data-release-details-trigger]");
        if (!item || !button) {
          found.push(`${id}: no item or no button`);
          continue;
        }
        const middle = (element: Element) => {
          const box = element.getBoundingClientRect();
          return box.top + box.height / 2;
        };
        const parts = [...item.children, button].map(middle);
        if (Math.max(...parts) - Math.min(...parts) > 3) found.push(`${id}: Details is on another line than its item`);
        // One row of text and its button, not two lines.
        if (lineEl.getBoundingClientRect().height > 30) found.push(`${id}: the line is more than one row`);
      }
      return found;
    });
    expect(apart, `at ${width}px`).toEqual([]);
  }
});

test("the line stays directly under the health line when the component list is open", async ({ page }) => {
  await openBoard(page);
  await page.setViewportSize({ width: 390, height: 900 });
  let withList = 0;
  for (const id of WITH_FEED) {
    // A row with a list: a card that needs a look has its own layout (the line is in its header).
    const row = page.locator(`#service-${id} details.row-details-feed`);
    if ((await row.count()) === 0) continue;
    withList += 1;
    const gap = async () => {
      const health = await page.locator(`#service-${id} [data-card-header] p`).first().boundingBox();
      const release = await line(page, id).boundingBox();
      if (!health || !release) throw new Error(`${id} has no lines`);
      return release.y - (health.y + health.height);
    };
    // The line is the first thing after the summary, not in it (a button in a summary is a nested control), and
    // it is there while the row is shut.
    await expect(page.locator(`#service-${id} summary [data-release-line]`)).toHaveCount(0);
    await expect(row.locator("[data-release-line]")).toBeVisible();
    await expect(row.locator("[data-release-details-trigger]")).toBeVisible();
    const closed = await gap();
    expect(closed).toBeGreaterThanOrEqual(-1);
    expect(closed).toBeLessThan(8);
    await page.locator(`#service-${id} summary h3`).click();
    await expect(row).toHaveAttribute("open", "");
    expect(Math.abs((await gap()) - closed), `${id} with its list open`).toBeLessThan(1);
    // ...and the list begins below the line, not above it.
    const release = await line(page, id).boundingBox();
    const list = await row.locator("summary ~ div").last().boundingBox();
    if (!release || !list) throw new Error(`${id} has no list`);
    expect(list.y).toBeGreaterThanOrEqual(release.y + release.height - 1);
  }
  expect(withList).toBeGreaterThan(0);
});

test("the chevron sits on the same line of the row with or without a release line", async ({ page }) => {
  await openBoard(page);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    // The chevron's middle minus the middle of the name and health lines, for every row that opens.
    const offsets = await page.evaluate(() => {
      const found: Array<{ id: string | undefined; feed: boolean; offset: number }> = [];
      for (const details of document.querySelectorAll("details.row-details")) {
        const summary = details.querySelector("summary");
        const name = summary?.querySelector("h3");
        const health = summary?.querySelector("p");
        if (!summary || !name || !health) continue;
        const chevron = getComputedStyle(summary, "::after");
        const middle =
          summary.getBoundingClientRect().top + Number.parseFloat(chevron.top) + Number.parseFloat(chevron.height) / 2;
        const lines = (name.getBoundingClientRect().top + health.getBoundingClientRect().bottom) / 2;
        found.push({
          id: details.closest("article")?.id,
          feed: details.classList.contains("row-details-feed"),
          offset: middle - lines,
        });
      }
      return found;
    });
    expect(
      offsets.some((row) => row.feed),
      `a row with a feed and a list at ${width}px`,
    ).toBe(true);
    expect(
      offsets.some((row) => !row.feed),
      `a row with a list and no feed at ${width}px`,
    ).toBe(true);
    const spread = Math.max(...offsets.map((row) => row.offset)) - Math.min(...offsets.map((row) => row.offset));
    expect(spread, `${width}px: ${JSON.stringify(offsets)}`).toBeLessThan(1.5);
  }
});

test("on a touch screen the Details button has a 44px target and the line keeps its height", async ({ page }) => {
  await openBoard(page);
  await page.setViewportSize({ width: 390, height: 900 });
  test.skip(
    !(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)),
    "a fine pointer keeps the small button",
  );
  for (const id of WITH_FEED) {
    const button = trigger(page, id);
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    if (!box) throw new Error(`${id} has no button`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const reached = await page.evaluate(
      ([px, py]) => {
        const hit = (dy: number) =>
          Boolean(document.elementFromPoint(px, py + dy)?.closest("[data-release-details-trigger]"));
        // The button is 24px tall: 12px of target above it and 8px below (the row's padding), 44px in all.
        return { up: hit(-22), down: hit(18), beyond: hit(-28) };
      },
      [x, y] as const,
    );
    expect(reached.up, `${id} above`).toBe(true);
    expect(reached.down, `${id} below`).toBe(true);
    expect(reached.beyond, `${id} beyond 44px`).toBe(false);
    expect((await line(page, id).boundingBox())?.height ?? 99).toBeLessThan(30);
  }
});

test("Enter on the button opens Details and leaves the list shut", async ({ page }) => {
  await openBoard(page);
  const row = page.locator("#service-cs2-europe details.row-details");
  await trigger(page, "cs2-europe").focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(row).not.toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(row).not.toHaveAttribute("open", "");
});

test("a release tracker's line breaks between its items and keeps each whole", async ({ page }) => {
  await openBoard(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const items = page.locator("#service-mikrotik [data-release-item]");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(/^Stable 7\.21 · \w{3} \d{1,2} ·$/);
  expect(await splitDays(page)).toEqual([]);
  // "Details" is in the same unit as the last item.
  const tail = page.locator("#service-mikrotik [data-release-tail]");
  await expect(tail).toContainText("Long-term 7.18.2");
  await expect(tail.locator("[data-release-details-trigger]")).toHaveCount(1);
});

test("has no accessibility violations, with the lines on the board and with the pop-up open", async ({ page }) => {
  await openBoard(page);
  const scan = () => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  const found = (results: Awaited<ReturnType<AxeBuilder["analyze"]>>) =>
    results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((n) => n.target).join(", ")}`);
  expect(found(await scan().analyze())).toEqual([]);
  await trigger(page, "github").click();
  await expect(dialog(page)).toBeVisible();
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector("dialog[data-release-details]")!).transform === "none",
  );
  expect(found(await new AxeBuilder({ page }).include("dialog[data-release-details]").analyze())).toEqual([]);
});
