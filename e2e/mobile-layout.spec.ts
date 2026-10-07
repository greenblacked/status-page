import type { Locator, Page, TestInfo } from "@playwright/test";
import { HIDE_DOWN_PX, REVEAL_UP_PX } from "../src/lib/status/dock.ts";
import { degradedLedBoard, fixtureBoard, longHeroBoard, unreadBoard } from "./fixture-board";
import {
  auditNow,
  BACKGROUNDS,
  barBack,
  barSearch,
  cards,
  controlBar,
  dialogSettled,
  downThePage,
  expectNone,
  fromSweep,
  heroSearch,
  installAudit,
  isPhone,
  isWide,
  maxScroll,
  openBoard,
  openWithFixture,
  pressSettled,
  refreshInto,
  SERVICES,
  scrollAndSettle,
  sweepTo,
  typeSlowly,
  viewportOf,
} from "./support/layout";
import { expect, test } from "./test";

/** The phone widths the bar's status text is held to: a small Android, the iPhone SE and Pro, a large Pixel. */
const PHONE_WIDTHS = [320, 375, 390, 412] as const;

// How the page lays out on a screen. Every test here is tagged @layout, and playwright.config.ts runs only these
// on the extra screens (a 320px phone, a short one, a large one, a foldable open and on its cover, an Android
// tablet, phones on their side) besides the projects that run the whole suite. Each test runs on all three
// backgrounds (Quiet, Glass, Full), because the Glass and Full ones add layers (translucent panels, the lens layer)
// that Quiet has not. They read the page's geometry and state, never a time: a check waits for the page to say it
// is done (an attribute, an animation that finished, two frames after a scroll), not for a number of milliseconds.
//
// What they hold the page to, on the first render and again after scrolling, a refresh and opening things:
//   - no sideways scroll, and no element past the edge of the screen except inside something meant to scroll
//   - the hero, the live bar, the floating bar and the cards do not overlap, and the bar covers neither the field it
//     replaces nor a sheet
//   - every control has a 44pt target on a touch screen
//   - the floating bar comes up with the hero gone, shows its search field on a scroll up and takes it back on a scroll
//     down, with its status text drawn
//   - the Details sheet and Settings fit the screen and close
//   - the search field takes focus and a query, and the results fit
//   - no status word is cut by an ellipsis
// A failing check attaches a screenshot of the page as it was.

test.describe("mobile layout", { tag: "@layout" }, () => {
  // The audit has to be able to fail: each of these breaks the page on purpose and expects the audit to say so, so a
  // change to it that stops seeing sideways overflow (the page clips it, so scrollWidth never shows it) or an overlap
  // fails here and not silently everywhere else.
  test.describe("the audit", () => {
    test.beforeEach(async ({ page }) => {
      await installAudit(page);
      await openBoard(page, "quiet");
    });

    test("sees a card wider than the screen", async ({ page }) => {
      await cards(page)
        .first()
        .evaluate((element) => {
          element.style.minWidth = "900px";
        });
      const found = await auditNow(page);
      expect(found.overflow.join("\n")).toContain("spans");
    });

    test("sees a word too long for its box", async ({ page }) => {
      await page.evaluate(() => {
        const title = document.querySelector("header h1");
        if (title) title.append(" ".concat("x".repeat(80)));
      });
      const found = await auditNow(page);
      expect(found.overflow.join("\n")).toMatch(/text <h1>|holds \d+px of content/);
    });

    test("sees two cards on top of each other", async ({ page }) => {
      // The second card moved onto the first, wherever the grid put them.
      await page.evaluate(() => {
        const [first, second] = document.querySelectorAll<HTMLElement>('article[id^="service-"]');
        const a = first.getBoundingClientRect();
        const b = second.getBoundingClientRect();
        second.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top + 20}px)`;
      });
      const found = await auditNow(page);
      expect(found.overlap.join("\n")).toContain("cards");
    });
  });

  for (const background of BACKGROUNDS) {
    test.describe(`on the ${background} background`, () => {
      test.beforeEach(async ({ page }) => {
        await installAudit(page);
      });

      test("fits the screen and overlaps nothing, at the top, down the page and with a sheet open", async ({
        page,
      }, testInfo) => {
        test.slow();
        const bring = await openWithFixture(page, background, fixtureBoard);
        const problems = async (stage: string) => {
          const found = await auditNow(page);
          await expectNone(page, testInfo, `${stage}: sideways`, found.overflow);
          await expectNone(page, testInfo, `${stage}: overlap`, found.overlap);
        };
        // The first render, the server's own board.
        await problems("first render");
        let sweep = await sweepTo(page, await downThePage(page));
        await expectNone(page, testInfo, "first render, down the page: sideways", fromSweep(sweep, "overflow"));
        await expectNone(page, testInfo, "first render, down the page: overlap", fromSweep(sweep, "overlap"));

        // The board with every state, long summaries and component lists.
        await scrollAndSettle(page, 0);
        await bring();
        await problems("fixture board");
        sweep = await sweepTo(page, await downThePage(page));
        await expectNone(page, testInfo, "fixture board, down the page: sideways", fromSweep(sweep, "overflow"));
        await expectNone(page, testInfo, "fixture board, down the page: overlap", fromSweep(sweep, "overlap"));

        // And back up, with the bar's field coming in on the way.
        sweep = await sweepTo(page, (await downThePage(page)).reverse());
        await expectNone(page, testInfo, "fixture board, back up: sideways", fromSweep(sweep, "overflow"));
        await expectNone(page, testInfo, "fixture board, back up: overlap", fromSweep(sweep, "overlap"));

        // Things opened: a card's Details, and Settings, each with the bar up behind it.
        await page.locator("[data-release-details-trigger]").last().scrollIntoViewIfNeeded();
        await page.locator("[data-release-details-trigger]").last().click();
        const details = page.locator("dialog[data-release-details][open]");
        await expect(details).toBeVisible();
        await dialogSettled(details);
        await problems("Details open");
        await details.getByRole("button", { name: /^Close details/ }).click();
        await expect(page.locator("dialog[data-release-details]")).toHaveCount(0);

        await page.getByRole("button", { name: "Settings", exact: true }).scrollIntoViewIfNeeded();
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const settings = page.locator("dialog.settings-dialog[open]");
        await expect(settings).toBeVisible();
        await dialogSettled(settings);
        await problems("Settings open");
      });

      test("fits the screen with Tilt lighting's clip on, and a Details target stays inside its card", async ({
        page,
      }, testInfo) => {
        test.skip(background === "quiet", "Tilt lighting draws on Glass and Full only; Quiet has no clip to test");
        test.slow();
        const bring = await openWithFixture(page, background, fixtureBoard);
        await bring();
        // The attribute the light sets while it drives the glass: the panels then clip (overflow: clip) the layer
        // that slides inside them, which nothing in them may rely on reaching past the panel's edge.
        await page.evaluate(() => document.documentElement.setAttribute("data-tilt", "on"));
        expect(
          await page.evaluate(() => getComputedStyle(document.querySelector(".surface") as Element).overflow),
          "the panel clips with Tilt lighting on",
        ).toBe("clip");
        const found = await auditNow(page);
        await expectNone(page, testInfo, "tilt on: sideways", found.overflow);
        await expectNone(page, testInfo, "tilt on: overlap", found.overlap);
        const sweep = await sweepTo(page, await downThePage(page));
        await expectNone(page, testInfo, "tilt on, down the page: sideways", fromSweep(sweep, "overflow"));
        await expectNone(page, testInfo, "tilt on, down the page: overlap", fromSweep(sweep, "overlap"));
        // The invisible extension of a Details button on a touch screen (12px above, 8px below, release-details.tsx)
        // must lie inside its card, or the clip cuts it.
        await scrollAndSettle(page, 0);
        const reaching = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-release-details-trigger]"), (trigger) => {
            const card = trigger.closest(".surface")?.getBoundingClientRect();
            const box = trigger.getBoundingClientRect();
            if (!card) return `${trigger.textContent}: not inside a panel`;
            return box.top - 12 < card.top - 0.5 || box.bottom + 8 > card.bottom + 0.5
              ? `${trigger.textContent}: button ${box.top.toFixed(1)}-${box.bottom.toFixed(1)}, panel ${card.top.toFixed(1)}-${card.bottom.toFixed(1)}`
              : "";
          }).filter(Boolean),
        );
        await expectNone(page, testInfo, "tilt on: Details targets", reaching);
      });

      test("gives every control a 44pt target on a touch screen", async ({ page }, testInfo) => {
        test.slow();
        await openWithFixture(page, background, fixtureBoard, { steady: true });
        const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
        test.skip(!coarse, "the touch sizes are for a coarse pointer, which this project does not have");
        const read = () =>
          page.evaluate(() =>
            (
              window as unknown as { __layout: { targets: () => Promise<{ count: number; small: string[] }> } }
            ).__layout.targets(),
          );
        // The server's first render, then the fixture's cards (outage, degraded and maintenance ones).
        const first = await read();
        expect(first.count, "a page of controls").toBeGreaterThan(12);
        await expectNone(page, testInfo, "first render", first.small);
        await refreshInto(page);
        await expectNone(page, testInfo, "fixture board", (await read()).small);

        // The floating bar's controls, with the bar up.
        await scrollAndSettle(page, await maxScroll(page));
        await barBack(page);
        await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
        await expectNone(page, testInfo, "floating bar up", (await read()).small);

        // A card's Details.
        await page.locator("[data-release-details-trigger]").first().scrollIntoViewIfNeeded();
        await page.locator("[data-release-details-trigger]").first().click();
        const details = page.locator("dialog[data-release-details][open]");
        await expect(details).toBeVisible();
        await dialogSettled(details);
        await expectNone(page, testInfo, "Details open", (await read()).small);
      });

      test("keeps the day/night switch in reach: 44pt, on the screen and clear of the other controls, in day and night", async ({
        page,
      }, testInfo) => {
        test.slow();
        await openBoard(page, background, { steady: true });
        const { width } = viewportOf(page);
        const room = (selector: string) =>
          page.evaluate((query) => {
            const toggle = document.querySelector(query) as HTMLElement | null;
            if (!toggle) return { missing: true as const };
            const box = toggle.getBoundingClientRect();
            const container = toggle.closest("header, section[aria-label='Board controls']") as HTMLElement;
            const inside = container.getBoundingClientRect();
            const others = [...container.querySelectorAll("button, [data-bar-lead], .bar-search, header > div > p")]
              .filter((other) => other !== toggle && !toggle.contains(other) && !other.closest("[data-theme-switch]"))
              .map((other) => ({
                name: other.getAttribute("aria-label") ?? other.className,
                box: other.getBoundingClientRect(),
              }))
              .filter((other) => other.box.width > 1 && other.box.height > 1);
            return {
              missing: false as const,
              hidden: getComputedStyle(toggle).display === "none",
              width: box.width,
              height: box.height,
              left: box.left,
              right: box.right,
              inContainer: box.left >= inside.left - 0.5 && box.right <= inside.right + 0.5,
              touching: others
                .filter(
                  (other) =>
                    Math.min(box.right, other.box.right) - Math.max(box.left, other.box.left) > 1 &&
                    Math.min(box.bottom, other.box.bottom) - Math.max(box.top, other.box.top) > 1,
                )
                .map((other) => other.name),
            };
          }, selector);
        const checked = async (where: string, selector: string, wantHidden: boolean) => {
          // Wait out any press on the switch before reading its box.
          await pressSettled(page.locator(selector));
          const found = await room(selector);
          const problems: string[] = [];
          if (found.missing) problems.push("the switch is not in the page");
          else if (wantHidden) {
            if (!found.hidden) problems.push("drawn where the bar keeps its room for the verdict");
          } else {
            if (found.hidden) problems.push("not drawn");
            if (found.width < 43.99 || found.height < 43.99) problems.push(`target ${found.width}x${found.height}`);
            if (found.left < 0 || found.right > width) problems.push(`off the screen: ${found.left} to ${found.right}`);
            if (!found.inContainer) problems.push("outside its header");
            if (found.touching.length > 0) problems.push(`touches ${found.touching.join(", ")}`);
          }
          await expectNone(page, testInfo, `${where}: ${selector}`, problems);
        };
        // The bar draws its copy from 640px; below that the verdict has the room.
        const barDrawsIt = await page.evaluate(() => matchMedia("(min-width: 40rem)").matches);
        for (const theme of ["day", "night"] as const) {
          if ((await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) !== theme)
            await page.locator("header [data-theme-switch]").click();
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await scrollAndSettle(page, 0);
          await checked(`${theme}, hero`, "header [data-theme-switch]", false);
          const top = await auditNow(page);
          await expectNone(page, testInfo, `${theme}, top: sideways`, top.overflow);
          await expectNone(page, testInfo, `${theme}, top: overlap`, top.overlap);

          const fieldBottom = await page
            .locator(".search-dock")
            .evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
          await scrollAndSettle(page, Math.ceil(fieldBottom) + 200);
          await barBack(page);
          await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
          await checked(`${theme}, bar`, "section[aria-label='Board controls'] [data-theme-switch]", !barDrawsIt);
          const down = await auditNow(page);
          await expectNone(page, testInfo, `${theme}, bar: sideways`, down.overflow);
          await expectNone(page, testInfo, `${theme}, bar: overlap`, down.overlap);
        }
      });

      test("shows the floating bar with the hero gone, reveals its field on a scroll up and takes it back on a scroll down", async ({
        page,
      }, testInfo) => {
        test.slow();
        await openBoard(page, background, { steady: true });
        const wide = await isWide(page);
        const bar = controlBar(page);
        await expect(bar).toHaveAttribute("data-shown", "false");

        // Past the hero and its field, with room to scroll on.
        const limit = await maxScroll(page);
        const fieldBottom = await page
          .locator(".search-dock")
          .evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
        const deep = Math.ceil(fieldBottom) + 200;
        expect(deep, "the page is long enough to scroll down in").toBeLessThan(limit - 160);
        await scrollAndSettle(page, deep);
        // A phone's bar is out of sight after a scroll down (parked above the screen); a scroll up a little brings it
        // back, and not yet its field (that takes REVEAL_UP_PX).
        await expect(bar).toHaveAttribute("data-shown", (await isPhone(page)) ? "false" : "true");
        await barBack(page);
        await expect(bar).toHaveAttribute("data-shown", "true");
        await expect(bar).not.toHaveAttribute("data-revealed");
        const settle = () =>
          bar.evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
        await settle();

        // The status text is drawn: one form of the verdict has a width and is not transparent.
        const verdict = async () =>
          bar.locator("[data-bar-verdict] > span:not(:last-child)").evaluateAll((spans) =>
            spans
              .map((span) => {
                let opacity = 1;
                for (let node: Element | null = span; node && node.tagName !== "SECTION"; node = node.parentElement) {
                  opacity *= Number(getComputedStyle(node).opacity);
                }
                return { text: span.textContent, width: Math.round(span.getBoundingClientRect().width), opacity };
              })
              .filter((span) => span.width > 1 && span.opacity > 0.99),
          );
        const hidden = await verdict();
        await expectNone(
          page,
          testInfo,
          "bar down: status text drawn",
          hidden.length === 1 ? [] : [JSON.stringify(hidden)],
        );
        const found = await auditNow(page);
        await expectNone(page, testInfo, "bar down: sideways", found.overflow);
        await expectNone(page, testInfo, "bar down: overlap", found.overlap);

        if (wide) {
          // The field is docked into the bar from 64rem: it is there, in the bar, and takes the tap.
          const box = await heroSearch(page).boundingBox();
          const barBox = await bar.boundingBox();
          expect(box && barBox && box.y >= barBox.y && box.y + box.height <= barBox.y + barBox.height).toBe(true);
          return;
        }

        // A scroll up reveals the bar's field; a scroll down takes it back.
        await scrollAndSettle(page, deep - (REVEAL_UP_PX + 4));
        await expect(bar).toHaveAttribute("data-revealed", "");
        await settle();
        await page
          .locator(".bar-search")
          .evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
        const field = await barSearch(page).boundingBox();
        const barBox = await bar.boundingBox();
        expect(field, "the bar's field is drawn").not.toBeNull();
        expect(barBox).not.toBeNull();
        if (field && barBox) {
          const inside = field.x >= barBox.x - 0.5 && field.x + field.width <= barBox.x + barBox.width + 0.5;
          await expectNone(
            page,
            testInfo,
            "bar up: field in the bar",
            inside && field.width > 40 ? [] : [JSON.stringify(field)],
          );
        }
        const up = await auditNow(page);
        await expectNone(page, testInfo, "bar up: sideways", up.overflow);
        await expectNone(page, testInfo, "bar up: overlap", up.overlap);

        await scrollAndSettle(page, deep - (REVEAL_UP_PX + 4) + (HIDE_DOWN_PX + 4));
        await expect(bar).not.toHaveAttribute("data-revealed");
        // A phone's bar went with that scroll down: back it comes, without the field.
        await barBack(page);
        await expect(bar).toHaveAttribute("data-shown", "true");
        await settle();
        await page
          .locator(".bar-search")
          .evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
        const again = await verdict();
        await expectNone(
          page,
          testInfo,
          "bar down again: status text drawn",
          again.length === 1 ? [] : [JSON.stringify(again)],
        );

        // Back at the top the bar goes and the hero's field is the only one.
        await scrollAndSettle(page, 0);
        await expect(bar).toHaveAttribute("data-shown", "false");
        await expect(bar).toHaveAttribute("inert", "");
      });

      // The bar's status text fills the room between its glyph and its buttons. `alerts` false is a browser that cannot
      // show page alerts (iPhone Safari outside a Home Screen app has no Notification API): its bar draws Refresh alone,
      // and the text has that button's room too, not the room the missing Alerts button would have had.
      const drawsStatusText = async (page: Page, testInfo: TestInfo, alerts: boolean) => {
        test.slow();
        if (!alerts) {
          await page.addInitScript(() => {
            // @ts-expect-error: a browser with no Notification API
            delete window.Notification;
          });
        }
        await openBoard(page, background, { steady: true });
        if (!alerts) await expect(page.locator("html")).toHaveAttribute("data-alerts", "unsupported");
        test.skip(
          await page.evaluate(() => matchMedia("(min-width: 40rem)").matches),
          "the verdict is laid over the bar's field slot on a phone only; from 640px it sits in the flow",
        );
        const { height } = viewportOf(page);
        for (const width of PHONE_WIDTHS) {
          await page.setViewportSize({ width, height });
          await scrollAndSettle(page, 0);
          const fieldBottom = await page
            .locator(".search-dock")
            .evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
          await scrollAndSettle(page, Math.ceil(fieldBottom) + 200);
          await barBack(page);
          await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
          await controlBar(page).evaluate((bar) =>
            Promise.allSettled(bar.getAnimations().map((animation) => animation.finished)),
          );
          const found = await controlBar(page).evaluate((bar) => {
            const verdict = bar.querySelector<HTMLElement>("[data-bar-verdict]");
            const glyph = bar.querySelector("svg");
            const buttons = [...bar.querySelectorAll("button")].filter(
              (button) => button.getBoundingClientRect().width > 1,
            );
            const text = verdict?.firstElementChild as HTMLElement | null;
            const box = verdict?.getBoundingClientRect();
            const textBox = text?.getBoundingClientRect();
            let opacity = 1;
            for (let node: Element | null = text ?? null; node && node !== bar; node = node.parentElement) {
              opacity *= Number(getComputedStyle(node).opacity);
            }
            return {
              width: box?.width ?? 0,
              textWidth: textBox?.width ?? 0,
              left: box?.left ?? 0,
              right: box?.right ?? 0,
              glyphRight: glyph?.getBoundingClientRect().right ?? 0,
              buttonsLeft: Math.min(...buttons.map((button) => button.getBoundingClientRect().left)),
              clipped: text ? text.scrollWidth > text.clientWidth + 1 : false,
              opacity,
            };
          });
          const problems: string[] = [];
          if (found.width < 40) problems.push(`the verdict is ${found.width}px wide`);
          if (found.textWidth < 40) problems.push(`its text is ${found.textWidth}px wide`);
          if (found.opacity < 0.99) problems.push(`its opacity is ${found.opacity}`);
          if (found.left < found.glyphRight - 0.5) problems.push("it runs under the glyph");
          if (found.right > found.buttonsLeft + 0.5) problems.push("it runs under the buttons");
          // Not short of them either: the room that is free is the text's (the gap is the bar's own, 14px, plus a little).
          if (found.buttonsLeft - found.right > 20) {
            problems.push(`it stops ${Math.round(found.buttonsLeft - found.right)}px short of the buttons`);
          }
          if (found.right > width) problems.push("it leaves the screen");
          await expectNone(page, testInfo, `${width}px: status text drawn`, problems);
        }
      };

      test("draws the bar's status text in the room between its glyph and its buttons, at every phone width", async ({
        page,
      }, testInfo) => {
        await drawsStatusText(page, testInfo, true);
      });

      test("draws the bar's status text up to Refresh where the browser has no Alerts button", async ({
        page,
      }, testInfo) => {
        await drawsStatusText(page, testInfo, false);
      });

      test("covers the strip above the bar on a phone: nothing of the page shows over or beside it", async ({
        page,
      }, testInfo) => {
        test.slow();
        await openBoard(page, background, { steady: true });
        test.skip(
          await page.evaluate(() => matchMedia("(min-width: 40rem)").matches),
          "the bar is a sheet from the top edge on a phone only; from 640px it is a pill under the top",
        );
        const { width } = viewportOf(page);
        const fieldBottom = await page
          .locator(".search-dock")
          .evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
        await scrollAndSettle(page, Math.ceil(fieldBottom) + 200);
        await barBack(page);
        await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
        await controlBar(page).evaluate((bar) =>
          Promise.allSettled(bar.getAnimations().map((animation) => animation.finished)),
        );
        const found = await controlBar(page).evaluate((bar, vw) => {
          const box = bar.getBoundingClientRect();
          // What is on top at the screen's top edge, at its left, middle and right, and at the bar's lower corners.
          const covered = [2, vw / 2, vw - 2].flatMap((x) =>
            [1, box.bottom / 2, box.bottom - 12].map((y) => {
              const top = document.elementFromPoint(x, y);
              return top && bar.contains(top)
                ? ""
                : `(${Math.round(x)}, ${Math.round(y)}): ${top?.tagName ?? "nothing"}`;
            }),
          );
          return { top: box.top, left: box.left, right: box.right, covered: covered.filter(Boolean) };
        }, width);
        const problems: string[] = [];
        if (found.top > 0.5) problems.push(`the bar starts ${found.top}px down, leaving a strip above it`);
        if (found.left > 0.5 || found.right < width - 0.5) {
          problems.push(`the bar spans ${found.left} to ${found.right} of a ${width}px screen`);
        }
        problems.push(...found.covered.map((spot) => `something else is on top at ${spot}`));
        await expectNone(page, testInfo, "strip above the bar", problems);
      });

      test("fits the Details sheet and Settings to the screen, and closes them", async ({ page }, testInfo) => {
        test.slow();
        await openWithFixture(page, background, fixtureBoard);
        await refreshInto(page);
        const { width, height } = viewportOf(page);

        /** Everything a sheet must hold: inside the screen, nothing wider than itself, its close button reachable. */
        const fits = (dialog: Locator) =>
          dialog.evaluate(
            (element, [vw, vh, closeName]) => {
              const problems: string[] = [];
              const box = element.getBoundingClientRect();
              if (box.left < -0.5 || box.right > (vw as number) + 0.5) {
                problems.push(
                  `the sheet spans ${Math.round(box.left)} to ${Math.round(box.right)} on a ${vw}px screen`,
                );
              }
              if (box.top < -0.5 || box.bottom > (vh as number) + 0.5) {
                problems.push(
                  `the sheet spans ${Math.round(box.top)} to ${Math.round(box.bottom)} on a ${vh}px screen`,
                );
              }
              if (element.scrollWidth > element.clientWidth + 1) {
                problems.push(`the sheet holds ${element.scrollWidth}px in ${element.clientWidth}px`);
              }
              const button = element.querySelector(`button[aria-label^="${closeName}"]`);
              const buttonBox = button?.getBoundingClientRect();
              if (!buttonBox) problems.push("no close button");
              else {
                if (buttonBox.width < 43.5 || buttonBox.height < 43.5) {
                  problems.push(`close button is ${Math.round(buttonBox.width)}x${Math.round(buttonBox.height)}`);
                }
                if (
                  buttonBox.left < 0 ||
                  buttonBox.right > (vw as number) ||
                  buttonBox.top < 0 ||
                  buttonBox.bottom > (vh as number)
                ) {
                  problems.push("close button is off screen");
                }
                const hit = document.elementFromPoint(
                  buttonBox.left + buttonBox.width / 2,
                  buttonBox.top + buttonBox.height / 2,
                );
                if (!button?.contains(hit)) problems.push("close button is covered");
              }
              // The list under the header scrolls inside the sheet; none of its content may leave the sheet's width.
              for (const inner of element.querySelectorAll("li, li *")) {
                const innerBox = inner.getBoundingClientRect();
                if (innerBox.width > 0 && (innerBox.left < box.left - 0.5 || innerBox.right > box.right + 0.5)) {
                  problems.push(
                    `${inner.tagName.toLowerCase()} "${(inner.textContent ?? "").trim().slice(0, 30)}" leaves the sheet`,
                  );
                  break;
                }
              }
              return problems;
            },
            [width, height, "Close"] as const,
          );

        // Details of a card at the top of the board, and of a tracker at its end with the floating bar up.
        for (const [which, trigger] of [
          ["first Details", page.locator("[data-release-details-trigger]").first()],
          ["last Details, bar up", page.locator("[data-release-details-trigger]").last()],
        ] as const) {
          await trigger.scrollIntoViewIfNeeded();
          if (which.endsWith("bar up")) {
            await barBack(page);
            await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
          }
          await trigger.click();
          const dialog = page.locator("dialog[data-release-details][open]");
          await expect(dialog).toBeVisible();
          await dialogSettled(dialog);
          await expectNone(page, testInfo, `${which}`, await fits(dialog));
          const found = await auditNow(page);
          await expectNone(page, testInfo, `${which}: overlap`, found.overlap);
          await dialog.getByRole("button", { name: /^Close details/ }).click();
          await expect(page.locator("dialog[data-release-details]")).toHaveCount(0);
        }

        // Settings, closed with Escape.
        const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
        await settingsButton.scrollIntoViewIfNeeded();
        await settingsButton.click();
        const settings = page.locator("dialog.settings-dialog[open]");
        await expect(settings).toBeVisible();
        await dialogSettled(settings);
        await expectNone(page, testInfo, "Settings", await fits(settings));
        await page.keyboard.press("Escape");
        await expect(settings).toBeHidden();
      });

      test("takes focus and a query in the search field, and fits the results", async ({ page }, testInfo) => {
        test.slow();
        await openBoard(page, background, { steady: true });
        const wide = await isWide(page);
        const { width } = viewportOf(page);

        /** The field is inside the screen and its text is not wider than the room for it. */
        const fieldFits = async (field: Locator, stage: string) => {
          const problems = await field.evaluate((input, vw) => {
            const found: string[] = [];
            const box = input.getBoundingClientRect();
            if (box.width < 40) found.push(`field is ${Math.round(box.width)}px wide`);
            if (box.left < -0.5 || box.right > (vw as number) + 0.5)
              found.push(`field spans ${Math.round(box.left)} to ${Math.round(box.right)}`);
            return found;
          }, width);
          await expectNone(page, testInfo, stage, problems);
        };
        const resultsFit = async (stage: string) => {
          const found = await auditNow(page);
          await expectNone(page, testInfo, `${stage}: sideways`, found.overflow);
          await expectNone(page, testInfo, `${stage}: overlap`, found.overlap);
        };

        // The hero's field, at the top.
        const field = heroSearch(page);
        await field.click();
        await expect(field).toBeFocused();
        await typeSlowly(page, "git");
        await expect(cards(page).first()).toBeVisible();
        const matches = await cards(page).count();
        expect(matches, "a search for git leaves a few of the twenty").toBeGreaterThan(0);
        expect(matches).toBeLessThan(SERVICES);
        await fieldFits(field, "hero field with a query");
        await resultsFit("results for git");
        await typeSlowly(page, "zzz", "git");
        await expect(cards(page)).toHaveCount(0);
        await resultsFit("no result");
        await page.keyboard.press("Escape");
        await expect(field).toHaveValue("");
        await expect(cards(page)).toHaveCount(SERVICES);

        // The field in the bar: docked from 64rem, revealed by a scroll up below. A field in use holds the bar as it
        // is, so the hero's is let go of first.
        await field.blur();
        const limit = await maxScroll(page);
        const fieldBottom = await page
          .locator(".search-dock")
          .evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
        const deep = Math.ceil(fieldBottom) + 200;
        expect(deep).toBeLessThan(limit - 160);
        await scrollAndSettle(page, deep);
        await barBack(page);
        await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
        let live: Locator = field;
        if (!wide) {
          await scrollAndSettle(page, deep - (REVEAL_UP_PX + 4));
          await expect(controlBar(page)).toHaveAttribute("data-revealed", "");
          await page
            .locator(".bar-search")
            .evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
          live = barSearch(page);
        }
        await live.click();
        await expect(live).toBeFocused();
        // Set in one go: what is held here is that the field takes a query and the results fit. A key at a time,
        // which moves the page under the typing, is the next test.
        await live.fill("git");
        await expect(heroSearch(page)).toHaveValue("git");
        await expect(cards(page).first()).toBeVisible();
        await fieldFits(live, "bar field with a query");
        await resultsFit("bar field, results for git");
      });

      /**
       * Scrolls past the field, up far enough to reveal the bar's field, and taps it. Phones and the iPad turned up:
       * from 64rem the field is docked and never revealed, so the caller skips there.
       */
      const focusBarField = async (page: Page) => {
        const fieldBottom = await page
          .locator(".search-dock")
          .evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);
        const deep = Math.ceil(fieldBottom) + 200;
        expect(deep, "the page is long enough to scroll down in").toBeLessThan((await maxScroll(page)) - 160);
        await scrollAndSettle(page, deep);
        await barBack(page);
        await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
        await scrollAndSettle(page, deep - (REVEAL_UP_PX + 4));
        await expect(controlBar(page)).toHaveAttribute("data-revealed", "");
        await page
          .locator(".bar-search")
          .evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
        await barSearch(page).click();
        await expect(barSearch(page)).toBeFocused();
      };
      const twoFrames = (page: Page) =>
        page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );

      // A key typed into the bar's field filters the board, which shortens the page, and the browser moves the page
      // by part of that (it holds a card the search may just have removed). That is no scroll by the reader, so the
      // field in use must not be let go of: on a phone, losing it closes the keyboard and ends the search.
      test("keeps the focus in the search field while the bar's field is typed in, a key at a time", async ({
        page,
      }) => {
        test.slow();
        await openBoard(page, background, { steady: true });
        test.skip(await isWide(page), "from 64rem the field is docked in the bar and is never revealed");
        await focusBarField(page);
        let typed = "";
        for (const key of "github") {
          typed += key;
          await page.keyboard.press(key);
          await twoFrames(page);
          const now = await page.evaluate(() => {
            const active = document.activeElement;
            const field =
              active instanceof HTMLInputElement && active.hasAttribute("data-search-input") ? active : null;
            const box = field?.getBoundingClientRect();
            return {
              tag: active?.tagName,
              which: field?.dataset.searchInput,
              value: field?.value,
              shown: field ? field.checkVisibility() && !field.closest("[inert]") : false,
              onScreen: box ? box.bottom > 0 && box.top < window.innerHeight : false,
              // Nothing floats over the middle of it: the floating bar must not sit on a field that has the focus.
              uncovered: box
                ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === field
                : false,
            };
          });
          expect(now.which, `after "${typed}" the focus is in a search field, not on ${now.tag}`).toBeDefined();
          expect(now.value, `after "${typed}" the field holds what was typed`).toBe(typed);
          expect(now.shown && now.onScreen, `after "${typed}" the field in use can be seen`).toBe(true);
          expect(now.uncovered, `after "${typed}" nothing is drawn over the field in use`).toBe(true);
          await expect(heroSearch(page)).toHaveValue(typed);
          const results = await cards(page).count();
          expect(results, `after "${typed}" the results are shown`).toBeGreaterThan(0);
          expect(results, `after "${typed}" the search has narrowed the board`).toBeLessThan(SERVICES);
        }
      });

      // The other half: a scroll the reader makes with the bar's field in use is still theirs. Up to the hero lets
      // the field go and takes the bar away, as it always did, after a query that has moved the page.
      test("still lets the bar's field go when the reader scrolls up to the hero after typing", async ({ page }) => {
        test.slow();
        await openBoard(page, background, { steady: true });
        test.skip(await isWide(page), "from 64rem the field is docked in the bar and is never revealed");
        // The first key moves the page and the focus goes where it is in view; the field is let go of and taken in
        // the bar again, with the query written, before the reader's scroll.
        await focusBarField(page);
        await page.keyboard.press("g");
        await twoFrames(page);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await twoFrames(page);
        await focusBarField(page);
        // A key was typed a moment ago (the page's note of it is all this sends); the page does not change in the
        // frames that follow, so what moves it now is the reader.
        await barSearch(page).evaluate((input) => input.dispatchEvent(new Event("input", { bubbles: true })));
        await scrollAndSettle(page, 0);
        await twoFrames(page);
        const left = await page.evaluate(() => {
          const active = document.activeElement;
          return active instanceof HTMLInputElement && active.hasAttribute("data-search-input");
        });
        expect(left, "the reader's scroll up to the hero let the field go").toBe(false);
        await expect(controlBar(page)).toHaveAttribute("data-shown", "false");
      });

      // The bar's verdict is read in Inter and in the fallback face (Arial or its twins, Roboto): Inter is
      // font-display: optional, so a first view is drawn in the fallback, which is wider, and a 320px screen leaves
      // the verdict 156px. The widest forms the bar draws are read too: the one with the most digits, the one with the
      // longest state word and the longest sentence.
      for (const [name, board, fallback] of [
        ["the plain fixture", fixtureBoard, false],
        ["the longest hero", longHeroBoard, false],
        ["the longest hero in the fallback face", longHeroBoard, true],
        ["the longest state word in the fallback face", degradedLedBoard, true],
        ["the longest sentence in the fallback face", unreadBoard, true],
      ] as const) {
        test(`cuts no status word short with an ellipsis, on ${name}`, async ({ page }, testInfo) => {
          test.slow();
          // No face of Inter arrives, so the page keeps the fallback it was first drawn in.
          if (fallback) await page.route(/\.woff2?(\?|$)/, (route) => route.abort());
          const bring = await openWithFixture(page, background, board, {
            steady: true,
            // The fixture's outage is not on a board that has none: the headline is what shows it has landed.
            landed:
              board === unreadBoard
                ? (at) => at.getByRole("heading", { level: 1, name: /Nothing needs a look/ })
                : undefined,
          });
          const clipped = () =>
            page.evaluate(() => {
              const status =
                /\b(operational|degraded|outage|down|maintenance|needs a look|everything is up|no data|unknown|couldn.t read|checking|checked|stale|next in|new release|issues only|starred|releases|alerts|refresh)\b/i;
              const places = [
                '[data-testid="live-bar"]',
                'section[aria-label="Board controls"]',
                'section[aria-label="Filter services"]',
                "header h1",
                "header h1 + p",
                "[data-card-header]",
              ];
              const found: string[] = [];
              for (const element of document.body.querySelectorAll("*")) {
                if (!(element instanceof HTMLElement)) continue;
                if (
                  element.closest("[inert]") &&
                  element.closest("section[aria-label='Board controls']")?.getAttribute("data-shown") !== "true"
                )
                  continue;
                const style = getComputedStyle(element);
                const cutsOff = style.textOverflow === "ellipsis" || /hidden|clip/.test(style.overflowX);
                if (!cutsOff || element.clientWidth === 0) continue;
                if (element.scrollWidth <= element.clientWidth + 1) continue;
                const box = element.getBoundingClientRect();
                const opacity = Number(style.opacity);
                if (box.width <= 1 || opacity < 0.05 || style.visibility === "hidden") continue;
                const text = (element.textContent ?? "").trim().replace(/\s+/g, " ");
                const inStatusPlace = places.some((selector) => element.closest(selector));
                // A service's name, or the words of a release, may be cut short on purpose: the Details hold them whole.
                if (element.closest("[data-release-line]") || element.closest("h3")) continue;
                if (status.test(text) && (inStatusPlace || element.children.length === 0)) {
                  found.push(`"${text.slice(0, 50)}" is cut at ${element.clientWidth}px of ${element.scrollWidth}px`);
                }
              }
              return found;
            });
          if (fallback) {
            const inter = await page.evaluate(() =>
              [...document.fonts].some(
                (face) => face.family.replaceAll('"', "") === "Inter" && face.status === "loaded",
              ),
            );
            expect(inter, "Inter did not load, so this is the fallback face").toBe(false);
          }
          await expectNone(page, testInfo, "first render", await clipped());
          await bring();
          await expectNone(page, testInfo, "board", await clipped());
          // With the bar up, and again with its field revealed.
          const bar = controlBar(page);
          const settle = () =>
            bar.evaluate((element) =>
              Promise.allSettled(element.getAnimations().map((animation) => animation.finished)),
            );
          const deep = (await maxScroll(page)) - 100;
          await scrollAndSettle(page, deep);
          await barBack(page);
          await expect(bar).toHaveAttribute("data-shown", "true");
          await settle();
          await expectNone(page, testInfo, "bar up", await clipped());
          if (!(await isWide(page))) {
            await scrollAndSettle(page, deep - (REVEAL_UP_PX + 4));
            await expect(bar).toHaveAttribute("data-revealed", "");
            await settle();
            await expectNone(page, testInfo, "bar's field revealed", await clipped());
          }
        });
      }
    });
  }
});
