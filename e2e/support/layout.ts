import type { Locator, Page, TestInfo } from "@playwright/test";
import type { BoardSnapshot } from "../../src/lib/status/types.ts";
import { serveBoard } from "../fixture-board";
import { expect } from "../test";

// What the tests of how the page lays out on a screen share (e2e/mobile-layout.spec.ts): opening the board on a
// background, the page-side audit that reads its geometry, and the helpers that scroll and wait on the page's own
// state. A spec for one more check imports from here.

export const BACKGROUNDS = ["quiet", "glass", "full"] as const;
export type Background = (typeof BACKGROUNDS)[number];

export const SERVICES = 20;
export const cards = (page: Page) => page.locator('article[id^="service-"]');
/** The floating bar, found by its markup: Playwright's role queries skip it while it is `inert`. */
export const controlBar = (page: Page) => page.locator('section[aria-label="Board controls"]');
export const heroSearch = (page: Page) => page.locator('[data-search-input="hero"]');
export const barSearch = (page: Page) => page.locator('[data-search-input="bar"]');

/** Waits until React has hydrated the page: a press before it goes nowhere. */
export async function hydrated(page: Page): Promise<void> {
  // Generous: a loaded machine (or WebKit in CI) hydrates late, and a ceiling is not a threshold the test measures.
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 30_000 });
}

/** Waits until the self-hosted Inter's fetch is over, so the hero is drawn in the face it will keep. */
export async function fontsSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.load("400 16px Inter").catch(() => []);
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/**
 * Moves the page's Date to 30 s into a two-minute slot (see pinToSlot in board.spec.ts): the turn of a slot adds a
 * row to Recent changes and refetches, which moves the page under a test that scrolls.
 */
export async function pinToSlot(page: Page): Promise<void> {
  const offset = Math.floor(Date.now() / 120_000) * 120_000 + 30_000 - Date.now();
  await page.addInitScript((shift) => {
    const Native = Date;
    const now = () => Native.now() + shift;
    window.Date = new Proxy(Native, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
      apply: (target) => new target(now()).toString(),
      get: (target, key) => (key === "now" ? now : Reflect.get(target, key, target)),
    });
  }, offset);
}

/** Waits until the bar's lead line has settled to its live words, which move the slot of the bar's field. */
export async function leadSteady(page: Page): Promise<void> {
  const lead = page.locator("[data-bar-lead]");
  await expect(lead).toHaveAttribute("data-state", "live", { timeout: 90_000 });
  await expect(lead).toContainText(/next in \d+:\d{2}/, { timeout: 90_000 });
}

/** Presses Refresh and waits for the board it brings, so a served fixture replaces the server's first render. */
export async function refreshInto(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Refresh status now" }).first();
  const answered = page.waitForResponse(
    (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
  );
  await button.click();
  await answered;
  await expect(button).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#service-aws").getByText("Outage", { exact: true }).first()).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await cardsSettled(page);
}

/** Waits until every card glide has finished, including any started meanwhile (see motionDone in board.spec.ts). */
export async function cardsSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const glides = () => document.getAnimations().filter((animation) => animation.id === "card-move");
    for (let running = glides(); running.length > 0; running = glides()) {
      await Promise.allSettled(running.map((animation) => animation.finished));
    }
  });
}

/**
 * Opens the board on a background: chosen before the page loads, the way Settings would have. With `board` the
 * server functions answer that fixture and Refresh brings it in; with `steady` the page's clock is pinned inside a
 * slot, hydrated, and the bar's lead has settled (what a test of scrolling the bar needs).
 */
export async function openBoard(
  page: Page,
  background: Background,
  { steady = false }: { steady?: boolean } = {},
): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("status-bar:background", value);
    } catch {
      // Storage can refuse; the page then stays Quiet.
    }
  }, background);
  if (steady) await pinToSlot(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  if (background !== "quiet") await expect(page.locator("html")).toHaveAttribute("data-background", background);
  await fontsSettled(page);
  if (steady) {
    await leadSteady(page);
    await expect(page.locator(".search-dock")).toHaveAttribute("data-armed", "");
  }
}

/** Serves a fixture board, opens the page on the server's first render, and returns the function that brings the fixture in. */
export async function openWithFixture(
  page: Page,
  background: Background,
  board: (now: number) => BoardSnapshot,
  options: { steady?: boolean } = {},
): Promise<() => Promise<void>> {
  await serveBoard(page, () => board(Date.now()));
  await openBoard(page, background, options);
  return () => refreshInto(page);
}

export const viewportOf = (page: Page) => {
  const size = page.viewportSize();
  if (!size) throw new Error("the project sets no viewport");
  return size;
};

/** From 64rem the search field docks into the bar, which then has no copy of it; below, it reveals on a scroll up. */
export const isWide = (page: Page) => page.evaluate(() => matchMedia("(min-width: 64rem)").matches);

/**
 * Attaches a screenshot of the page as it is. The page is read in place, so a check that failed leaves the picture
 * of that moment, not of the end of the test.
 */
export async function snap(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(`${name}.png`, { body: await page.screenshot(), contentType: "image/png" });
}

/** Asserts that a list of problems is empty, with a picture of the page if it is not. */
export async function expectNone(page: Page, testInfo: TestInfo, stage: string, problems: string[]): Promise<void> {
  if (problems.length > 0) await snap(page, testInfo, stage.replace(/[^a-z0-9]+/gi, "-"));
  expect.soft(problems, stage).toEqual([]);
}

/**
 * The page-side half of every check, installed before the page's own scripts run: `window.__layout.audit(vw)`
 * reads the page as it is and returns what is wrong with it, `window.__layout.sweep(ys, vw)` does that after each
 * scroll to a position in `ys`, and `window.__layout.targets()` lists the controls whose target is under 44 CSS px.
 * One script, so that a sweep is a moment of the page and not a round trip per stop.
 */
export async function installAudit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Problems = { overflow: string[]; overlap: string[] };

    const label = (element: Element): string => {
      const text = (element.getAttribute("aria-label") || element.textContent || "").trim().replace(/\s+/g, " ");
      const id = element.id ? `#${element.id}` : "";
      return `<${element.tagName.toLowerCase()}${id}> "${text.slice(0, 40)}"`;
    };

    /** How visible an element is, as the product of its own and its ancestors' opacity; 0 for display: none or visibility: hidden. */
    const opacityOf = (element: Element): number => {
      let opacity = 1;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none") return 0;
        if (node === element && style.visibility === "hidden") return 0;
        opacity *= Number(style.opacity);
      }
      return opacity;
    };

    /** The box of an element a person can see: drawn (not hidden, not transparent) and more than a pixel across. */
    const boxOf = (element: Element | null): DOMRect | null => {
      if (!element || opacityOf(element) < 0.05) return null;
      const box = element.getBoundingClientRect();
      return box.width > 1 && box.height > 1 ? box : null;
    };

    /**
     * The box of the lines of text in an element: its text nodes' own boxes, without the padding that gives a link in
     * running text its 44pt reach (hit-extend), which reaches into the line above by design.
     */
    const textBoxOf = (element: Element): DOMRect | null => {
      if (opacityOf(element) < 0.05) return null;
      const range = document.createRange();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let box: DOMRect | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? "").trim() || (node.parentElement && opacityOf(node.parentElement) < 0.05)) continue;
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          box = box
            ? new DOMRect(
                Math.min(box.left, rect.left),
                Math.min(box.top, rect.top),
                Math.max(box.right, rect.right) - Math.min(box.left, rect.left),
                Math.max(box.bottom, rect.bottom) - Math.min(box.top, rect.top),
              )
            : rect;
        }
      }
      return box && box.width > 1 && box.height > 1 ? box : null;
    };

    /** Whether two boxes share more than a hair of area (text boxes may touch, and round to a pixel). */
    const overlapOf = (a: DOMRect, b: DOMRect): { x: number; y: number } | null => {
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return x > 2 && y > 2 ? { x: Math.round(x), y: Math.round(y) } : null;
    };

    const pairs = (kind: string, elements: Element[], out: string[], textual: Element[] = []): void => {
      const drawn = elements
        .map((element) => ({ element, box: textual.includes(element) ? textBoxOf(element) : boxOf(element) }))
        .filter((item) => item.box);
      for (const [index, a] of drawn.entries()) {
        for (const b of drawn.slice(index + 1)) {
          if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
          const overlap = overlapOf(a.box as DOMRect, b.box as DOMRect);
          if (overlap)
            out.push(`${kind}: ${label(a.element)} and ${label(b.element)} overlap by ${overlap.x}x${overlap.y}`);
        }
      }
    };

    const all = (selector: string) => [...document.querySelectorAll(selector)];

    const audit = (vw: number): Problems => {
      const overflow: string[] = [];
      const overlap: string[] = [];
      const wide = matchMedia("(min-width: 64rem)").matches;

      // The page scrolls sideways.
      const scrollWidth = document.documentElement.scrollWidth;
      if (scrollWidth > vw) overflow.push(`the page is ${scrollWidth}px wide on a ${vw}px screen`);
      // Something past the edge. The page clips it (html, body and the .liquid-stage that holds the whole board are
      // overflow-x: clip), so scrollWidth does not tell, and those clips cannot count as "meant to scroll" either:
      // look at each drawn element and its text. One that leaves its own box is let through where that box is a
      // scroller or a clip (a truncated line, a strip that scrolls) that sits inside the screen, so that what sticks
      // out of it is cut or scrolled there and never reaches the edge; and what is hidden from view (sr-only, the lens layer).
      const clippedWithin = (element: Element): boolean => {
        for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
          if (
            node.classList.contains("liquid-stage") ||
            !/hidden|clip|auto|scroll/.test(getComputedStyle(node).overflowX)
          )
            continue;
          const box = node.getBoundingClientRect();
          if (box.left >= -0.5 && box.right <= vw + 0.5) return true;
        }
        return false;
      };
      const exempt = (element: Element): boolean =>
        element.closest(".lenses, .sr-only") !== null || clippedWithin(element);
      for (const element of document.body.querySelectorAll("*")) {
        if (exempt(element)) continue;
        const box = boxOf(element);
        if (!box || (box.left >= -0.5 && box.right <= vw + 0.5)) continue;
        overflow.push(
          `${label(element)} spans ${Math.round(box.left)} to ${Math.round(box.right)} on a ${vw}px screen`,
        );
      }
      // Text that leaves its box: a word too long for the room spills out of an element that itself fits, and the
      // box check above cannot see it. A block of text that holds more than it shows (overflow-x visible, scrollWidth
      // past clientWidth), and any line of text drawn past the screen's edge.
      const reach = document.createRange();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || !(node.textContent ?? "").trim() || exempt(parent) || opacityOf(parent) < 0.05) continue;
        reach.selectNodeContents(node);
        const past = [...reach.getClientRects()].find(
          (rect) => rect.width > 0 && rect.height > 0 && (rect.left < -0.5 || rect.right > vw + 0.5),
        );
        if (past) {
          overflow.push(
            `text ${label(parent)} is drawn from ${Math.round(past.left)} to ${Math.round(past.right)} on a ${vw}px screen`,
          );
        }
      }
      for (const element of document.body.querySelectorAll("*")) {
        if (!(element instanceof HTMLElement) || exempt(element) || opacityOf(element) < 0.05) continue;
        if (element.clientWidth === 0 || !/visible/.test(getComputedStyle(element).overflowX)) continue;
        // Its own words: what its children draw (a shadow, a glass layer, a tooltip) is not text that spilled.
        if (![...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()))
          continue;
        if (element.scrollWidth > element.clientWidth + 1) {
          overflow.push(`${label(element)} holds ${element.scrollWidth}px of content in ${element.clientWidth}px`);
        }
      }

      // The hero, the live bar and the first cards. From 64rem the search field and the chips share a row and the
      // field slides over them on its way into the bar, so they are not compared there.
      const hero = [
        ...all("header h1"),
        ...all("header h1 + p"),
        ...all("header button"),
        ...all('[data-testid="live-bar"]'),
        ...(wide ? [] : [...all(".search-dock"), ...all('section[aria-label="Filter services"]')]),
        ...all("article[id^=service-]").slice(0, 1),
      ];
      // The headline, the lines under it and the live line are compared by their text, the rest by their boxes.
      pairs("hero", hero, overlap, [...all("header h1"), ...all("header h1 + p"), ...all('[data-testid="live-bar"]')]);
      pairs("cards", all("article[id^=service-]"), overlap);
      for (const header of all("[data-card-header]")) {
        pairs("card header", [...header.querySelectorAll(":scope > span, :scope > div > *, :scope > button")], overlap);
      }

      // The floating bar, once it is up.
      const bar = document.querySelector('section[aria-label="Board controls"]');
      if (bar && bar.getAttribute("data-shown") === "true") {
        const barBox = bar.getBoundingClientRect();
        if (barBox.left < -0.5 || barBox.right > vw + 0.5) {
          overflow.push(`the floating bar spans ${Math.round(barBox.left)} to ${Math.round(barBox.right)}`);
        }
        const verdict = bar.querySelector(
          "[data-bar-verdict] > span:not(:last-child):not(.sr-only):not(.max-lg\\:sr-only)",
        );
        pairs(
          "floating bar",
          [
            ...(bar.querySelector("[data-bar-lead] svg") ? [bar.querySelector("[data-bar-lead] svg") as Element] : []),
            ...(verdict ? [verdict] : []),
            ...all('section[aria-label="Board controls"] .bar-search input'),
            // The clear button sits inside the field it clears, by design.
            ...all('section[aria-label="Board controls"] button').filter((button) => !button.closest(".bar-search")),
          ],
          overlap,
        );
        // The live line scrolls out from under the bar as it comes up, it is never under it.
        const live = document.querySelector('[data-testid="live-bar"]');
        const liveBox = live ? boxOf(live) : null;
        if (liveBox && overlapOf(liveBox, barBox)) {
          overlap.push(
            `floating bar covers the live bar (${Math.round(liveBox.top)} to ${Math.round(liveBox.bottom)} against the bar's top ${Math.round(barBox.top)})`,
          );
        }
        // Its copy of the field is up: the hero's field must be gone behind it, never on screen as a second one.
        // (With a query written, the bar's copy stays up until it is cleared, whatever the hero shows.)
        const field = document.querySelector('[data-search-input="hero"]');
        if (bar.hasAttribute("data-revealed") && field instanceof HTMLInputElement && field.value === "") {
          const fieldBox = field ? boxOf(field) : null;
          if (fieldBox && fieldBox.bottom > barBox.bottom + 0.5 && fieldBox.top < innerHeight) {
            overlap.push(
              `the bar's search field is up while the hero's is on screen (hero field ${Math.round(fieldBox.top)} to ${Math.round(fieldBox.bottom)}, bar bottom ${Math.round(barBox.bottom)})`,
            );
          }
        }
      }

      // A sheet that is open: nothing floats over it. A grid of points over the panel must all answer to the dialog.
      for (const dialog of all("dialog[open]")) {
        const box = dialog.getBoundingClientRect();
        const covered: string[] = [];
        for (const fx of [0.1, 0.5, 0.9]) {
          for (const fy of [0.1, 0.5, 0.9]) {
            const x = Math.min(Math.max(box.left + box.width * fx, 0), vw - 1);
            const y = Math.min(Math.max(box.top + box.height * fy, 0), innerHeight - 1);
            const hit = document.elementFromPoint(x, y);
            if (hit && !dialog.contains(hit) && hit !== dialog) covered.push(label(hit));
          }
        }
        if (covered.length > 0) overlap.push(`${label(dialog)} is covered by ${[...new Set(covered)].join(", ")}`);
      }
      return { overflow, overlap };
    };

    const frames = (count: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        let left = count;
        const next = () => {
          left -= 1;
          if (left <= 0) {
            clearTimeout(timer);
            resolve();
          } else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      });

    /**
     * Waits out the bar's own fade and slide and its field's (not the live ring inside it, which never finishes), and
     * the glide of cards that a refresh or a star moved (withCardMotion, an animation named "card-move"), during
     * which two cards share a place on the way.
     */
    const settled = async () => {
      const targets = [
        document.querySelector('section[aria-label="Board controls"]'),
        document.querySelector(".bar-search"),
      ];
      const running = () =>
        [
          ...targets.flatMap((target) => (target ? target.getAnimations() : [])),
          ...document.getAnimations().filter((animation) => animation.id === "card-move"),
          // One that repeats for ever never finishes: it is not something to wait for.
        ].filter((animation) => animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY);
      // A glide lasts a quarter of a second; waiting on one that outlives ten seconds would hang the check, so stop
      // there and read the page as it is (the way motionDone in board.spec.ts gives up on a stuck glide).
      let timer: number | undefined;
      const stuck = new Promise<void>((resolve) => {
        timer = window.setTimeout(resolve, 10_000);
      });
      const done = (async () => {
        for (let now = running(); now.length > 0; now = running()) {
          await Promise.allSettled(now.map((animation) => animation.finished));
        }
      })();
      await Promise.race([done, stuck]);
      window.clearTimeout(timer);
    };

    const auditSettled = async (vw: number) => {
      await settled();
      return audit(vw);
    };

    const sweep = async (ys: number[], vw: number) => {
      const found: { y: number; scrollY: number; overflow: string[]; overlap: string[] }[] = [];
      for (const y of ys) {
        window.scrollTo(0, y);
        await frames(3);
        await settled();
        const { overflow, overlap } = audit(vw);
        if (overflow.length || overlap.length)
          found.push({ y, scrollY: Math.round(window.scrollY), overflow, overlap });
      }
      return found;
    };

    /** Interactive elements with a target under 44 CSS px, after what reaches past their box is taken into account. */
    const targets = async () => {
      const modal = document.querySelector("dialog[open]");
      const selector = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "select",
        "textarea",
        "summary",
        "[role=button]",
        "[role=switch]",
        "[role=link]",
      ].join(",");
      const small: string[] = [];
      let count = 0;
      for (const element of all(selector)) {
        if (element.closest("[inert]")) continue;
        // Behind an open modal sheet the page cannot be tapped.
        if (modal && !modal.contains(element)) continue;
        if (getComputedStyle(element).pointerEvents === "none") continue;
        // A hidden radio or checkbox is taken by its label.
        const target =
          element instanceof HTMLInputElement && element.getBoundingClientRect().width <= 1
            ? (element.closest("label") ?? element)
            : element;
        if (!boxOf(target)) continue;
        if (target.classList.contains("sr-only") || target.closest(".sr-only")) continue;
        count += 1;
        const box = target.getBoundingClientRect();
        if (box.width >= 43.5 && box.height >= 43.5) continue;
        // What a finger can hit is more than the box when the control has padding or a pseudo-element that reaches out
        // (hit-extend, a Details button's invisible extension): find how far a tap still lands on it, a pixel at a time
        // from the middle, and add the two ways. Looked at from the middle of the element, scrolled into view.
        const inSentence =
          element instanceof HTMLAnchorElement &&
          getComputedStyle(element).display === "inline" &&
          (element.parentElement?.textContent ?? "").trim() !== (element.textContent ?? "").trim();
        const measure = async () => {
          target.scrollIntoView({ block: "center", inline: "nearest" });
          // The page answers a scroll in the frames after it (the bar comes up or goes, a card glides, a row settles
          // under a refetch): look once it has.
          await settled();
          await frames(2);
          const rect = target.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const reaches = (px: number, py: number) => {
            const hit = document.elementFromPoint(px, py);
            return hit === target || (hit !== null && target.contains(hit));
          };
          const reach = (dx: number, dy: number) => {
            let far = 0;
            while (far < 40 && reaches(x + dx * (far + 1), y + dy * (far + 1))) far += 1;
            return far;
          };
          return {
            width: Math.max(rect.width, reach(-1, 0) + reach(1, 0) + 1),
            height: Math.max(rect.height, reach(0, -1) + reach(0, 1) + 1),
          };
        };
        // A link inside a sentence is as wide as its words: it keeps 44px of height, and its neighbours are far enough
        // apart (WCAG 2.5.8), the way the sentence test in board.spec.ts holds the verdict's links.
        const enough = (size: { width: number; height: number }) =>
          (inSentence || size.width >= 43.5) && size.height >= 43.5;
        // A row that is still settling can have something else over the control for a frame or two: look again
        // before calling it small.
        let size = await measure();
        for (let again = 0; again < 2 && !enough(size); again += 1) size = await measure();
        if (!enough(size)) small.push(`${label(target)}: ${Math.round(size.width)}x${Math.round(size.height)}`);
      }
      return { count, small };
    };

    (window as unknown as { __layout: unknown }).__layout = { audit, auditSettled, sweep, targets };
  });
}

export type Sweep = { y: number; scrollY: number; overflow: string[]; overlap: string[] }[];

/** The audit of the page as it is: what is wrong with its width, and what overlaps. */
export const auditNow = (page: Page) =>
  page.evaluate(
    (vw) =>
      (
        window as unknown as {
          __layout: { auditSettled: (vw: number) => Promise<{ overflow: string[]; overlap: string[] }> };
        }
      ).__layout.auditSettled(vw),
    viewportOf(page).width,
  );

/** Scrolls through `ys`, auditing the page at each stop. */
export const sweepTo = (page: Page, ys: number[]): Promise<Sweep> =>
  page.evaluate(
    ([stops, vw]) =>
      (window as unknown as { __layout: { sweep: (ys: number[], vw: number) => Promise<Sweep> } }).__layout.sweep(
        stops as number[],
        vw as number,
      ),
    [ys, viewportOf(page).width] as const,
  );

/** How far the page can scroll. */
export const maxScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);

/** Scrolls to `y` and waits three frames, so the dock's own callback and React's update have run. */
export async function scrollAndSettle(page: Page, y: number): Promise<void> {
  await page.evaluate(
    (top) =>
      new Promise<void>((resolve) => {
        window.scrollTo(0, top);
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }),
    y,
  );
}

/** Stops from the top to the end of the page, a little under a screen apart, then the end itself. */
export async function downThePage(page: Page): Promise<number[]> {
  const limit = await maxScroll(page);
  const step = Math.max(200, Math.floor(viewportOf(page).height * 0.85));
  const stops: number[] = [];
  for (let y = 0; y < limit; y += step) stops.push(y);
  return [...stops, limit];
}

/** The audit's problems of one kind from a sweep, each with the scroll position it was seen at. */
export const fromSweep = (sweep: Sweep, kind: "overflow" | "overlap") =>
  sweep.flatMap((stop) => stop[kind].map((problem) => `at ${stop.scrollY}px: ${problem}`));

/** Waits out the dialog's rise, so its box is where it will stay. */
export async function dialogSettled(dialog: Locator): Promise<void> {
  await dialog.evaluate((element) =>
    Promise.allSettled(element.getAnimations().map((animation) => animation.finished)),
  );
}

/**
 * Types a query one key at a time, waiting after each for the query to show in the hero's field (the board's one
 * query, which both fields show). A search that shortens the page moves the fields under the typing, and keys sent
 * faster than the page answers can go to a field that has just been let go of. `already` is what the query holds.
 */
export async function typeSlowly(page: Page, text: string, already = ""): Promise<void> {
  let typed = already;
  for (const key of text) {
    typed += key;
    await page.keyboard.press(key);
    await expect(heroSearch(page)).toHaveValue(typed);
    // A key typed in the frame after another can reach a field that the page is just letting go of: let it settle.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        ),
    );
  }
}
