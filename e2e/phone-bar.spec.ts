import type { Page } from "@playwright/test";
import {
  BACKGROUNDS,
  barSearch,
  controlBar,
  heroSearch,
  maxScroll,
  openBoard,
  scrollAndSettle,
  viewportOf,
} from "./support/layout";
import { expect, test } from "./test";

// The floating bar on a phone (under 640px): it is out of sight while the reader scrolls down past the hero and
// comes back on a scroll up of more than 8px, the way the AI catalogue's header does. From 640px, on a tablet and a
// desktop, it stays up once it has come up. Tagged @layout, so the extra phones (a 320px Galaxy, a short iPhone SE,
// a large Pro Max, a foldable) and the tablets run it too, each on the side of the 640px line it is on.

/** Whether this screen is a phone's: under 40rem, where the bar hides on a scroll down. */
const isPhone = (page: Page) => page.evaluate(() => !matchMedia("(min-width: 40rem)").matches);

/** Waits out the bar's own slide and fade. */
const barSettled = (page: Page) =>
  controlBar(page).evaluate((bar) => Promise.allSettled(bar.getAnimations().map((animation) => animation.finished)));

/** Where the hero's field ends, as a scroll position: the bar's field can show from about here. */
const fieldBottom = (page: Page) =>
  page.locator(".search-dock").evaluate((element) => element.getBoundingClientRect().bottom + window.scrollY);

/** The position `px` of scrolling short of the end of the page, or the position given if the page is shorter. */
async function deepPosition(page: Page): Promise<number> {
  const deep = Math.ceil(await fieldBottom(page)) + 200;
  expect(deep, "the page is long enough to scroll down in").toBeLessThan((await maxScroll(page)) - 400);
  return deep;
}

/** Scrolls to `y` in steps of `step` px, a frame apart: a slow drag, not a jump. */
async function dragTo(page: Page, y: number, step: number): Promise<void> {
  await page.evaluate(
    ([target, size]) =>
      new Promise<void>((resolve) => {
        const move = () => {
          const left = target - window.scrollY;
          if (Math.abs(left) < 0.5) {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            return;
          }
          window.scrollTo(0, window.scrollY + Math.sign(left) * Math.min(Math.abs(left), size));
          requestAnimationFrame(move);
        };
        move();
      }),
    [y, step] as const,
  );
}

/** What the bar looks like: whether it is up (data-shown), parked by a scroll down (data-away), and out of use. */
const poseOf = (page: Page) =>
  controlBar(page).evaluate((bar) => {
    const box = bar.getBoundingClientRect();
    return {
      shown: bar.getAttribute("data-shown"),
      away: bar.hasAttribute("data-away"),
      inert: bar.hasAttribute("inert"),
      ariaHidden: bar.getAttribute("aria-hidden"),
      top: box.top,
      bottom: box.bottom,
      opacity: Number(getComputedStyle(bar).opacity),
      filter: getComputedStyle(bar).backdropFilter,
    };
  });

test.describe("the floating bar on a phone", { tag: "@layout" }, () => {
  test("goes away on a scroll down past the hero and comes back on a scroll up of more than 8px", async ({ page }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);

    // At the top: the hero's own controls, no bar, and it is not "away" either: it has not come up.
    await expect(bar).toHaveAttribute("data-shown", "false");
    await expect(bar).not.toHaveAttribute("data-away");

    // Scrolled down past the hero: the bar is up for the page but out of sight, above the screen and out of use.
    await scrollAndSettle(page, deep);
    await expect(bar).toHaveAttribute("data-away", "");
    await expect(bar).toHaveAttribute("data-shown", "false");
    await barSettled(page);
    const hidden = await poseOf(page);
    expect(hidden.inert).toBe(true);
    expect(hidden.ariaHidden).toBe("true");
    expect(hidden.bottom, "wholly above the top edge of the screen, the safe area's strip too").toBeLessThanOrEqual(
      0.5,
    );
    expect(hidden.opacity, "off the screen, not faded").toBe(1);

    // A little further down changes nothing; a scroll up of 8px or less does not bring it back.
    await scrollAndSettle(page, deep + 200);
    await scrollAndSettle(page, deep + 200 - 8);
    await expect(bar).toHaveAttribute("data-shown", "false");

    // More than 8px up: it comes back, in use and in view.
    await scrollAndSettle(page, deep + 200 - 20);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect(bar).not.toHaveAttribute("data-away");
    await barSettled(page);
    const shown = await poseOf(page);
    expect(shown.inert).toBe(false);
    expect(shown.ariaHidden).toBeNull();
    expect(shown.top).toBeGreaterThanOrEqual(-0.5);
    expect(shown.top).toBeLessThanOrEqual(0.5);
    expect(shown.opacity).toBe(1);
    await expect(bar.getByRole("button", { name: "Refresh status now" })).toBeInViewport();

    // And a scroll down of more than 8px takes it away again.
    await scrollAndSettle(page, deep + 200 - 20 + 4);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await scrollAndSettle(page, deep + 200 - 20 + 40);
    await expect(bar).toHaveAttribute("data-shown", "false");
    await expect(bar).toHaveAttribute("data-away", "");

    // Back near the top, where the hero's controls are again: no bar, and not parked either.
    await scrollAndSettle(page, deep - 60);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await scrollAndSettle(page, 0);
    await expect(bar).toHaveAttribute("data-shown", "false");
    await expect(bar).not.toHaveAttribute("data-away");
    await expect(bar).toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "Refresh status now" }).first()).toBeInViewport();
  });

  test("is never empty in the middle: the verdict after a short scroll up, the search field after a swipe", async ({
    page,
  }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    // What the bar draws between its glyph and its buttons, as boxes and opacities (the verdict is laid over the slot).
    const middle = () =>
      bar.evaluate((element) => {
        const opacityOf = (node: Element | null) => {
          let opacity = 1;
          for (let at = node; at && at !== element.parentElement; at = at.parentElement) {
            opacity *= Number(getComputedStyle(at).opacity);
          }
          return opacity;
        };
        const glyph = element.querySelector("[data-bar-lead] svg")?.getBoundingClientRect();
        const buttons = [...element.querySelectorAll("button")].filter(
          (button) => button.getBoundingClientRect().width > 1,
        );
        const verdictText = element.querySelector("[data-bar-verdict] > span:not(:last-child)");
        const verdict = verdictText?.getBoundingClientRect();
        const field = element.querySelector(".bar-search .search-field")?.getBoundingClientRect();
        return {
          glyphRight: glyph?.right ?? 0,
          buttonsLeft: Math.min(...buttons.map((button) => button.getBoundingClientRect().left)),
          verdict: { width: verdict?.width ?? 0, opacity: opacityOf(verdictText ?? null) },
          field: {
            left: field?.left ?? 0,
            right: field?.right ?? 0,
            opacity: opacityOf(element.querySelector(".bar-search")),
          },
        };
      });

    // A short scroll up brings the bar back with its verdict, and the field stays in.
    await scrollAndSettle(page, deep + 300);
    await scrollAndSettle(page, deep + 300 - 12);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect(bar).not.toHaveAttribute("data-revealed");
    await barSettled(page);
    const short = await middle();
    expect(short.verdict.width, "the verdict has room").toBeGreaterThan(40);
    expect(short.verdict.opacity, "the verdict shows").toBe(1);
    expect(short.field.opacity, "the field waits").toBe(0);

    // A swipe, which is far more than that: the field takes the verdict's place, between the glyph and the buttons,
    // and the middle is not empty.
    await scrollAndSettle(page, deep + 300);
    await barSettled(page);
    await scrollAndSettle(page, deep + 300 - 150);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect(bar).toHaveAttribute("data-revealed", "");
    await barSettled(page);
    await page
      .locator(".bar-search")
      .evaluate((element) => Promise.allSettled(element.getAnimations().map((animation) => animation.finished)));
    const swipe = await middle();
    expect(swipe.field.opacity, "the field shows").toBe(1);
    expect(swipe.field.right - swipe.field.left, "the field has room").toBeGreaterThan(40);
    expect(swipe.field.left).toBeGreaterThanOrEqual(swipe.glyphRight - 0.5);
    expect(swipe.field.right).toBeLessThanOrEqual(swipe.buttonsLeft + 0.5);
    expect(swipe.verdict.opacity, "the verdict gives way to the field").toBe(0);
  });

  test("adds up a slow drag: a scroll up of 2px at a time brings the bar back, and one down takes it away", async ({
    page,
  }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    await dragTo(page, deep + 300, 3);
    await expect(bar).toHaveAttribute("data-shown", "false");
    await dragTo(page, deep + 300 - 6, 2);
    await expect(bar).toHaveAttribute("data-shown", "false");
    await dragTo(page, deep + 300 - 14, 2);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await dragTo(page, deep + 300 - 14 + 5, 1);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await dragTo(page, deep + 300 - 14 + 20, 2);
    await expect(bar).toHaveAttribute("data-shown", "false");
  });

  test("keeps its blurred layer while it is away, and takes no room: the page does not move with it", async ({
    page,
  }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const deep = await deepPosition(page);
    const layout = () =>
      page.evaluate(() => ({
        height: document.documentElement.scrollHeight,
        scrollY: window.scrollY,
        card: (document.querySelector('article[id^="service-"]') as Element).getBoundingClientRect().top,
        main: (document.querySelector("main") as Element).getBoundingClientRect().height,
      }));
    await scrollAndSettle(page, deep + 100);
    await barSettled(page);
    const away = await layout();
    const awayPose = await poseOf(page);
    expect(awayPose.filter, "the blurred layer is kept while the bar is away").toContain("blur(");
    await scrollAndSettle(page, deep + 100 - 30);
    await barSettled(page);
    await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
    const up = await layout();
    // Same page, 30px up: nothing moved but the scroll.
    expect(up.height).toBe(away.height);
    expect(up.main).toBe(away.main);
    expect(up.card - away.card).toBeCloseTo(30, 0);
    expect((await poseOf(page)).filter).toContain("blur(");
  });

  test("stays up while the bar's own field has focus, whatever the page does", async ({ page }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    await scrollAndSettle(page, deep + 200);
    await scrollAndSettle(page, deep + 200 - 40);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect(bar).toHaveAttribute("data-revealed", "");
    await barSettled(page);
    await barSearch(page).focus({ timeout: 5_000 });
    await expect(barSearch(page)).toBeFocused();
    // Down and down: the field is in use, so the bar does not leave from under it (or under the keyboard).
    await scrollAndSettle(page, deep + 200 - 40 + 300);
    await scrollAndSettle(page, deep + 200 - 40 + 600);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect(bar).not.toHaveAttribute("data-away");
    await expect(barSearch(page)).toBeFocused();
    expect((await poseOf(page)).top).toBeGreaterThanOrEqual(-0.5);
    // Let go of it, and the bar is an ordinary one again: the next scroll down takes it away.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await scrollAndSettle(page, deep + 200 - 40 + 600 + 40);
    await expect(bar).toHaveAttribute("data-shown", "false");
  });

  test("stays up, with its field showing, while a search is written", async ({ page }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    await scrollAndSettle(page, deep + 200);
    await scrollAndSettle(page, deep + 200 - 40);
    await expect(bar).toHaveAttribute("data-revealed", "");
    await barSearch(page).fill("a");
    await expect(heroSearch(page)).toHaveValue("a");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // The results are fewer, and the page may be shorter: scroll on down from wherever it is.
    const at = await page.evaluate(() => window.scrollY);
    const limit = await maxScroll(page);
    const target = Math.min(at + 200, limit);
    test.skip(target - at < 40, "the search leaves too little page to scroll down in");
    await scrollAndSettle(page, target);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect(bar).toHaveAttribute("data-revealed", "");
    await expect(bar).not.toHaveAttribute("data-away");
  });

  test("is brought back by the / shortcut, which lands in the bar's field", async ({ page }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    await scrollAndSettle(page, deep + 200);
    await expect(bar).toHaveAttribute("data-shown", "false");
    const before = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("/");
    await expect(barSearch(page)).toBeFocused();
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect(bar).toHaveAttribute("data-revealed", "");
    // The page stays where it is: the field was brought to the reader, not the reader to a field.
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(2);
  });

  test("is not moved by the page's own scrolling: a jump to a link on the page neither hides nor shows it", async ({
    page,
  }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    // A link to a card, clicked as a reader would: the browser jumps the page (a plain anchor).
    const jumpTo = (id: string) =>
      page.evaluate((target) => {
        const anchor = document.createElement("a");
        anchor.href = `#${target}`;
        anchor.textContent = "jump";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, id);
    const cardTops = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('article[id^="service-"]')].map(
          (card) => [card.id, card.getBoundingClientRect().top + window.scrollY] as const,
        ),
      );
    const frames = () =>
      page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );

    // The bar is in sight (a scroll up), and a jump down to a card well below: still in sight, not read as a scroll down.
    await scrollAndSettle(page, deep + 100);
    await scrollAndSettle(page, deep + 100 - 40);
    await expect(bar).toHaveAttribute("data-shown", "true");
    const here = await page.evaluate(() => window.scrollY);
    const below = (await cardTops()).find(([, top]) => top > here + 500);
    expect(below, "a card well below the reader").toBeDefined();
    await jumpTo(below?.[0] ?? "");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(here + 300);
    await frames();
    await expect(bar).toHaveAttribute("data-shown", "true");

    // The bar is away (a scroll down), and a jump up to a card well above: still away, not read as a scroll up.
    const at = await page.evaluate(() => window.scrollY);
    await scrollAndSettle(page, Math.min(at + 40, await maxScroll(page)));
    await scrollAndSettle(page, Math.min(at + 80, await maxScroll(page)));
    await expect(bar).toHaveAttribute("data-shown", "false");
    const lower = await page.evaluate(() => window.scrollY);
    const above = (await cardTops()).filter(([, top]) => top < lower - 400 && top > deep - 400).at(-1);
    expect(above, "a card well above the reader, below the hero").toBeDefined();
    await jumpTo(above?.[0] ?? "");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(lower - 200);
    await frames();
    expect((await poseOf(page)).shown).toBe("false");
    await expect(bar).toHaveAttribute("data-away", "");
  });

  test("is the AI catalogue's header: edge to edge from the top, square, a hairline under it, 90% of the page's ground", async ({
    page,
  }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the header is a phone's bar only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    await scrollAndSettle(page, deep + 100);
    await scrollAndSettle(page, deep + 100 - 30);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await barSettled(page);
    const look = await bar.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const hair = Number.parseFloat(style.borderBottomWidth);
      // The row the content sits in: the bar's box less the safe area above and the hairline below.
      const safe = Number.parseFloat(style.paddingTop);
      const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const probe = document.createElement("span");
      probe.style.color = "color-mix(in srgb, var(--color-bg) 90%, transparent)";
      document.body.appendChild(probe);
      const fill = getComputedStyle(probe).color;
      probe.remove();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        height: box.height,
        row: box.height - safe - hair,
        rootPx,
        hair,
        width: window.innerWidth,
        position: style.position,
        radii: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ],
        edges: [style.borderTopWidth, style.borderRightWidth, style.borderLeftWidth],
        lineColour: style.borderBottomColor,
        shadow: style.boxShadow,
        fill: style.backgroundColor,
        wanted: fill,
        filter: style.backdropFilter,
      };
    });
    expect(look.position).toBe("fixed");
    expect(look.left, "edge to edge: from the left edge").toBeCloseTo(0, 0);
    expect(look.right, "edge to edge: to the right edge").toBeCloseTo(look.width, 0);
    expect(look.top, "from the very top of the screen").toBeCloseTo(0, 0);
    expect(look.row, "a 4rem row below the safe area").toBeCloseTo(4 * look.rootPx, 0);
    expect(look.radii, "square corners").toEqual(["0px", "0px", "0px", "0px"]);
    expect(look.edges, "a hairline on the lower edge only").toEqual(["0px", "0px", "0px"]);
    expect(look.hair, "the hairline is one device pixel").toBeGreaterThan(0);
    expect(look.shadow, "no shadow beyond the hairline").toBe("none");
    expect(look.fill, "the page's own ground at 90%").toBe(look.wanted);
    expect(look.filter, "a 12px blur").toBe("blur(12px)");
    const line = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-hairline)";
      document.body.appendChild(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    });
    expect(look.lineColour, "the board's own line colour").toBe(line);
  });

  test("goes away by its own height: translated by -100%, over 200ms, with the safe area's strip", async ({ page }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    await scrollAndSettle(page, deep + 100);
    await barSettled(page);
    const away = await bar.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        transform: new DOMMatrixReadOnly(style.transform).m42,
        height: element.getBoundingClientRect().height,
        bottom: box.bottom,
        property: style.transitionProperty,
        duration: style.transitionDuration,
      };
    });
    expect(away.transform, "-100% of its own height").toBeCloseTo(-away.height, 0);
    expect(away.bottom).toBeLessThanOrEqual(0.5);
    expect(away.property).toBe("transform");
    expect(away.duration).toBe("0.2s");
  });

  for (const scheme of ["light", "dark"] as const) {
    for (const background of BACKGROUNDS) {
      test(`is the page's ground at 90% under a 12px blur, square and unshadowed on ${background}, ${scheme === "light" ? "day" : "night"}`, async ({
        page,
      }) => {
        test.slow();
        await page.emulateMedia({ colorScheme: scheme });
        await openBoard(page, background, { steady: true });
        test.skip(!(await isPhone(page)), "the header is a phone's bar only");
        const deep = await deepPosition(page);
        await scrollAndSettle(page, deep + 100);
        await scrollAndSettle(page, deep + 100 - 30);
        await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
        await barSettled(page);
        const look = await controlBar(page).evaluate((element) => {
          const style = getComputedStyle(element);
          const probe = document.createElement("span");
          probe.style.color = "color-mix(in srgb, var(--color-bg) 90%, transparent)";
          document.body.appendChild(probe);
          const wanted = getComputedStyle(probe).color;
          probe.remove();
          return {
            fill: style.backgroundColor,
            wanted,
            image: style.backgroundImage,
            filter: style.backdropFilter,
            shadow: style.boxShadow,
            radius: style.borderBottomLeftRadius,
            sheen: getComputedStyle(element, "::before").display,
          };
        });
        expect(look.fill, "the page's own ground at 90%").toBe(look.wanted);
        expect(look.image, "no tint").toBe("none");
        expect(look.filter, "a 12px blur").toBe("blur(12px)");
        expect(look.shadow, "no shadow").toBe("none");
        expect(look.radius, "square").toBe("0px");
        expect(look.sheen, "no sheen").toBe("none");
      });
    }
  }

  test("under Reduce Motion it does not slide: it is there or it is not", async ({ page }) => {
    test.slow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openBoard(page, "quiet", { steady: true });
    test.skip(!(await isPhone(page)), "the bar hides on a phone only");
    const bar = controlBar(page);
    const deep = await deepPosition(page);
    await scrollAndSettle(page, deep + 200);
    await expect(bar).toHaveAttribute("data-shown", "false");
    const away = await poseOf(page);
    expect(away.inert).toBe(true);
    // No slide: it is off the screen at once (no transition), and out of use.
    expect(away.bottom).toBeLessThanOrEqual(0.5);
    expect(await bar.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
    await scrollAndSettle(page, deep + 200 - 20);
    await expect(bar).toHaveAttribute("data-shown", "true");
    // No transition to wait out: it is already there.
    const shown = await poseOf(page);
    expect(shown.opacity).toBe(1);
    expect(shown.top).toBeGreaterThanOrEqual(-0.5);
    expect(shown.top).toBeLessThanOrEqual(0.5);
  });
});

test.describe("the floating bar from 640px", { tag: "@layout" }, () => {
  test("stays up once it has come up, whichever way the page is scrolled", async ({ page }) => {
    test.slow();
    await openBoard(page, "quiet", { steady: true });
    test.skip(await isPhone(page), "a phone's bar hides on a scroll down: the tests above");
    const bar = controlBar(page);
    const wide = viewportOf(page).width >= 1024;
    // From 64rem the field docks into the bar a little way down; below, the hero's last line has to clear it.
    const deep = wide
      ? Math.ceil(await fieldBottom(page)) + 100
      : Math.min(Math.ceil(await fieldBottom(page)) + 200, (await maxScroll(page)) - 400);
    await scrollAndSettle(page, deep);
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect(bar).not.toHaveAttribute("data-away");
    // Further down, with big steps and small: never parked.
    for (const y of [deep + 40, deep + 400, deep + 405, deep + 800]) {
      await scrollAndSettle(page, Math.min(y, await maxScroll(page)));
      expect((await poseOf(page)).shown, `at ${y}`).toBe("true");
      await expect(bar).not.toHaveAttribute("data-away");
    }
    expect((await poseOf(page)).top).toBeGreaterThanOrEqual(-0.5);
    expect((await poseOf(page)).inert).toBe(false);
    // And back up to the hero it goes, as it always did.
    await scrollAndSettle(page, 0);
    await expect(bar).toHaveAttribute("data-shown", "false");
  });
});
