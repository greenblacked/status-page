import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { BoardSnapshot } from "../src/lib/status/types.ts";
import { feedBoard, fixtureBoard, serveBoard } from "./fixture-board";
import { expect, test } from "./test";

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
  await expect(line(page, "gitlab")).toContainText(/^GitLab 19\.4\.1 · \w{3} \d{1,2}/);
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
  await expect(entries.nth(0).getByRole("heading", { level: 3 })).toHaveText("GitLab 19.4.1");
  // A feed entry is never "New release": that tag is the trackers' two-week rule.
  await expect(dialog(page)).not.toContainText("New release");
  await expect(entries.nth(0).getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("GitLab Critical Patch Release: 19.4.1, 19.3.3, 19.2.7");
  const link = entries.nth(0).getByRole("link", { name: /Release post for GitLab 19\.4\.1/ });
  await expect(link).toHaveAttribute(
    "href",
    "https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-4-1-released/",
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
  // Gone, and not only shut: the key shuts a modal <dialog> at once, but the button gives focus back to itself
  // once the page has been told (the `close` event), so it is focused here only after that.
  await expect(dialog(page)).toHaveCount(0);
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

test("the line sits under the health line while the row is shut and below the list while it is open", async ({
  page,
}) => {
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
    // The line is not in the summary (a button in a summary is a nested control) and not in the <details> (an
    // engine may hide what a shut <details> holds): it is a plain sibling after it, and shown while the row is
    // shut. The list is in the <details>, where it belongs for a screen reader and for find-in-page.
    await expect(page.locator(`#service-${id} summary [data-release-line]`)).toHaveCount(0);
    await expect(row.locator("[data-release-line]")).toHaveCount(0);
    const feedLine = line(page, id);
    const button = trigger(page, id);
    const list = row.locator(":scope > div");
    await expect(list).toHaveCount(1);
    await expect(feedLine).toBeVisible();
    await expect(button).toBeVisible();
    await expect(list).toBeHidden();
    // Shut: the line is right under the health line.
    const closed = await gap();
    expect(closed).toBeGreaterThanOrEqual(-1);
    expect(closed).toBeLessThan(8);
    const shut = await feedLine.boundingBox();
    const shutButton = await button.boundingBox();
    if (!shut || !shutButton) throw new Error(`${id} has no line`);
    expect(shut.height).toBeGreaterThan(0);
    expect(shutButton.width).toBeGreaterThan(0);
    await page.locator(`#service-${id} summary h3`).click();
    await expect(row).toHaveAttribute("open", "");
    await expect(feedLine).toBeVisible();
    await expect(list).toBeVisible();
    // Open: the list opens under the health line and the release line sits below it.
    const release = await feedLine.boundingBox();
    const opened = await list.boundingBox();
    const health = await page.locator(`#service-${id} [data-card-header] p`).first().boundingBox();
    if (!release || !opened || !health) throw new Error(`${id} has no list`);
    expect(opened.y).toBeGreaterThanOrEqual(health.y + health.height - 1);
    expect(release.y).toBeGreaterThanOrEqual(opened.y + opened.height - 1);
    // Shut again: the line is back under the health line, where it was, and the list is gone.
    await page.locator(`#service-${id} summary h3`).click();
    await expect(row).not.toHaveAttribute("open", "");
    await expect(list).toBeHidden();
    await expect(feedLine).toBeVisible();
    expect(Math.abs((await gap()) - closed), `${id} shut again`).toBeLessThan(1);
  }
  expect(withList).toBeGreaterThan(0);
});

// A link to a component's name ("#:~:text=...", a shared link or a search result) opens the row that lists it. The
// list is inside the <details>, so the browser opens the row itself as it does for any shut <details>, with no
// script of the page involved. The test loads the page cold: scripts are switched off on a fresh page that is
// served the markup of the fixture board (the server's own board, from canned payloads, lacks some components), so it
// is the markup alone, which is what a slow phone shows before the page has hydrated. The name is taken from a row
// that has no release feed. It must be found: a missing name fails the test, never skips it.
test("a cold link to a component opens the shut row that lists it, before any script has run", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the reveal of a shut <details> by a text fragment is checked in Chromium");
  await openBoard(page);
  const names = await page
    .locator('details.row-details:not(.row-details-feed) ul[aria-label="Components"] li span[title]')
    .evaluateAll((spans) => spans.map((span) => span.getAttribute("title") ?? ""));
  // The page's own text, without the scripts and templates that carry the board a second time as data.
  const text = await page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    for (const node of body.querySelectorAll("script,template")) node.remove();
    return body.textContent ?? "";
  });
  // A name that occurs once on the page, so the fragment can only mean this row.
  const name = names.find((candidate) => candidate.length > 5 && text.split(candidate).length === 2);
  expect(
    name,
    `a component of a row with no release feed that is named once; found ${JSON.stringify(names)}`,
  ).toBeTruthy();
  // The hydration flag is the page's own doing; without it the markup is what the server sends.
  const markup = (await page.content()).replace(/ data-hydrated=""/, "");
  // A page of its own, so the one under test is loaded fresh, not by a hash change, with scripts off.
  const cold = await page.context().newPage();
  const cdp = await page.context().newCDPSession(cold);
  await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
  await cold.route(
    (url) => url.pathname === "/",
    (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: markup }),
  );
  const rowOf = (on: Page) =>
    on.locator("details.row-details:not(.row-details-feed)", { has: on.locator(`[title="${name}"]`) });
  // The row is one, and shut, before the link is followed.
  await expect(rowOf(page)).toHaveCount(1);
  await expect(rowOf(page)).not.toHaveAttribute("open", "");
  await cold.goto(`/#:~:text=${encodeURIComponent(name as string)}`);
  await expect(rowOf(cold)).toHaveCount(1);
  await expect(rowOf(cold)).toHaveAttribute("open", "");
  await expect(cold.locator("html")).not.toHaveAttribute("data-hydrated", "");
  await cold.close();
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
    // Taken to the middle of the window, clear of the floating bar: scrollIntoViewIfNeeded leaves a button that is
    // already in the window where it is, which can be under the bar (its 12px of target above the button are then
    // the bar's), and where that is depends on how tall the cards before it are. The box and the probes are read
    // in one page task, so nothing can move between them.
    const reached = await trigger(page, id).evaluate((button) => {
      button.scrollIntoView({ block: "center", behavior: "instant" });
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = (dy: number) =>
        Boolean(document.elementFromPoint(x, y + dy)?.closest("[data-release-details-trigger]"));
      // The button is 24px tall: 12px of target above it and 8px below (the row's padding), 44px in all.
      return { up: hit(-22), down: hit(18), beyond: hit(-28) };
    });
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

// A feed joins a board after the status sweep, so a row can gain or lose its release line between two boards.
// Its <details> must be the same node afterwards: an open row stays open and the focus in its summary stays.
for (const [name, from, to] of [
  ["gains", fixtureBoard, feedBoard],
  ["loses", feedBoard, fixtureBoard],
] as const) {
  test(`keeps an open row open, and its summary focused, when the row ${name} its release feed`, async ({ page }) => {
    let current = from(Date.now());
    await serveBoard(page, () => current);
    await page.goto("/");
    await expect(cards(page)).toHaveCount(SERVICES);
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
    const press = async () => {
      const answered = page.waitForResponse(
        (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
      );
      // A script click: a real one would move the focus to the Refresh button, and the test is whether the
      // new board takes it from the summary.
      await refresh.evaluate((button) => (button as HTMLButtonElement).click());
      await answered;
      await expect(refresh).toHaveAttribute("aria-busy", "false");
    };
    await press();
    const hasFeed = from === feedBoard;
    await expect(line(page, "cs2-europe")).toHaveCount(hasFeed ? 1 : 0);

    const summary = page.locator("#service-cs2-europe summary");
    const details = page.locator("#service-cs2-europe details");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveJSProperty("open", true);
    await expect(summary).toBeFocused();
    await details.evaluate((element) => {
      (window as unknown as { __kept: Element }).__kept = element;
    });

    current = to(Date.now());
    await press();
    await expect(line(page, "cs2-europe")).toHaveCount(hasFeed ? 0 : 1);
    expect(await details.evaluate((element) => element === (window as unknown as { __kept: Element }).__kept)).toBe(
      true,
    );
    await expect(details).toHaveJSProperty("open", true);
    await expect(summary).toBeFocused();
    // The list is where the structure puts it, and shows: open, with the release line or without it.
    await expect(page.locator("#service-cs2-europe").getByText("Frankfurt")).toBeVisible();
  });
}

// The list is as much part of the row as the <details>: a feed joining or leaving must not replace it, or the
// focus in it falls to the page and a list shown in full ("Show all 9 components") shuts back to six.
for (const [name, from, to] of [
  ["gains", fixtureBoard, feedBoard],
  ["loses", feedBoard, fixtureBoard],
] as const) {
  test(`keeps the focus and the full list of an open row when the row ${name} its release feed`, async ({ page }) => {
    const long = (board: BoardSnapshot): BoardSnapshot => ({
      ...board,
      services: board.services.map((service) =>
        service.id === "cs2-europe"
          ? {
              ...service,
              components: Array.from({ length: 9 }, (_, index) => ({
                name: `Relay ${index + 1}`,
                health: "operational" as const,
              })),
            }
          : service,
      ),
    });
    let current = long(from(Date.now()));
    await serveBoard(page, () => current);
    await page.goto("/");
    await expect(cards(page)).toHaveCount(SERVICES);
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
    const press = async () => {
      const answered = page.waitForResponse(
        (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
      );
      // A script click, so the focus stays where the test put it.
      await refresh.evaluate((button) => (button as HTMLButtonElement).click());
      await answered;
      await expect(refresh).toHaveAttribute("aria-busy", "false");
    };
    await press();
    const hasFeed = from === feedBoard;
    await expect(line(page, "cs2-europe")).toHaveCount(hasFeed ? 1 : 0);

    const row = page.locator("#service-cs2-europe");
    // The list is the <details>' own child after the summary, wherever the release line is.
    const list = row.locator("details > div");
    const items = list.getByText(/^Relay \d$/);
    await row.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(6);
    const toggle = list.getByRole("button", { name: /^Show all/ });
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(9);
    const fewer = list.getByRole("button", { name: "Show fewer components" });
    await expect(fewer).toBeFocused();
    await list.evaluate((element) => {
      (window as unknown as { __kept: Element }).__kept = element;
    });

    current = long(to(Date.now()));
    await press();
    await expect(line(page, "cs2-europe")).toHaveCount(hasFeed ? 0 : 1);
    expect(await list.evaluate((element) => element === (window as unknown as { __kept: Element }).__kept)).toBe(true);
    await expect(items).toHaveCount(9);
    await expect(fewer).toBeFocused();
  });
}
