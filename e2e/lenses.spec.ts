import type { Page } from "@playwright/test";
import type { BoardSnapshot } from "../src/lib/status/types.ts";
import { verdict } from "../src/lib/status/verdict.ts";
import { calmBoard, fixtureBoard, longHeroBoard, serveBoard } from "./fixture-board";
import { expect, test } from "./test";

// The bubble layer (src/components/status/lens-field.tsx and the .lens rules in
// src/background.css; the class is still "lens"): its markup and asset, the rules
// that hide, still, thin or place it, and a per-pixel contrast check. The layer is Full's: the
// default Quiet background and Glass hide it, and the markup is there either way.
//
// Contrast: board.spec.ts's contrastFailures strips pseudo-elements and every
// background-image before it runs axe, so it cannot see the lens layer. The
// last test here measures it instead: with the content hidden and motion off,
// it screenshots each bubble and checks --color-subtle and --color-muted
// against every pixel more than 3px inside the rim, in light and dark. The
// budget is 4.5:1 there; only the rim hairline (the outer
// 3px) is exempt. The lens colours are alpha tokens in src/background.css, so
// this is the test to run whenever one of them changes.

const lenses = (page: Page) => page.locator(".lenses");

/**
 * The panels' lights at their worst for contrast, held still and drawn whole over every panel, so the result does
 * not depend on where a light happens to be when the page is measured. There are two lights on the panels' ::after
 * layer: the wandering card light (Glass and Full, on every device, a 432px layer that wander-light.ts steps with
 * --wander-x and --wander-y) and, on a touch screen with Tilt lighting on, the glint that takes the same layer over
 * (a 432px layer a transform moves); the sheen (.surface::before) is under both. Where a light can sit is anywhere
 * in a card (the wander crosses all of it, the glint's centre reaches 12% from an edge), so the worst case is each
 * one at its peak alpha over the whole panel, and the sheen at its brightest, which it is in the upper left corner
 * where the "since" line sits.
 *
 *   dark   white is what hurts: the sheen flat at its brightest, and the stronger of the card light and the glint
 *          (see `strongestLight`) flat on top of it.
 *   light  the dark text loses to a darker backdrop, never to white: no sheen, and the glint's shade flat.
 *
 * Positioned and sized here too, whatever media the real rules sit in: the layer is stretched from the 432px square
 * to the whole panel (more than the light ever covers), put at the panel's origin whatever --wander-x/y and the
 * glint's transform say, made fully opaque at once (the wander fades in by a transition), and shown despite Reduce
 * Motion's `display: none`, so each is drawn whole, unmoved and fully shown.
 */
const lightsAtTheirStrongest = (colorScheme: "light" | "dark", strongestLight: string) =>
  [
    `.spotlight::after{content:"";display:block!important;position:absolute!important;inset:0!important;width:auto!important;height:auto!important;border-radius:inherit!important;opacity:1!important;animation:none!important;transition:none!important;transform:none!important;translate:none!important;background:var(${colorScheme === "dark" ? strongestLight : "--tilt-shade"})!important}`,
    colorScheme === "dark"
      ? '.surface::before{content:"";display:block!important;position:absolute!important;inset:0!important;border-radius:inherit!important;animation:none!important;transform:none!important;translate:none!important;background:var(--glass-sheen)!important}'
      : ".surface::before{background:none!important}",
  ].join("");

/** Every `step` px from the top of the page, then its very end. */
const scrollOffsets = (top: number, step: number): number[] => {
  const offsets: number[] = [];
  for (let offset = 0; offset < top; offset += step) offsets.push(offset);
  offsets.push(top);
  return offsets;
};

/** Two animation frames on: what a scroll or a style change set going has been drawn. */
const afterTwoFrames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** Chooses the page's background before it loads, the way Settings would have: Quiet is no choice at all. */
async function chooseBackground(page: Page, background: "quiet" | "glass" | "full"): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("status-bar:background", value);
    } catch {
      // Storage can refuse; the page then stays Quiet.
    }
  }, background);
}

/** Whether a layer is drawn: its computed display. */
const shown = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => getComputedStyle(node).display !== "none");

/** Waits until React has hydrated the page and its saved checks are in (a copy of the helper in board.spec.ts). */
async function hydrated(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
}

/**
 * `serveBoard` only answers the client's server-function calls, and the first render comes from the server (the
 * preview's canned vendor payloads, e2e/support/no-vendors.mjs), so press Refresh to bring the fixture in, and wait for it before measuring anything.
 *
 * The wait does not depend on how the headline is worded, nor on what the vendors say today. Two things must hold:
 *   - AWS and Steam show the fixture's own latencies (143 and 166 ms, from `latencyMs` in fixture-board.ts). The
 *     server's board shows its canned payloads' ones, or none at all for a source it could not read, so this is only
 *     true once the fixture is in, whatever the server drew first.
 *   - The <h1> is the headline `verdict()` makes of this very board, so the variant asked for (usual, calm,
 *     longest hero) is the one on screen, not a board that merely loaded.
 */
async function loadFixture(page: Page, build: (now: number) => BoardSnapshot): Promise<void> {
  const board = build(Date.now());
  await page.getByRole("button", { name: "Refresh status now" }).first().click();
  for (const id of ["aws", "steam"] as const) {
    const latencyMs = board.services.find((service) => service.id === id)?.latencyMs;
    // An attention card adds a screen-reader copy after the figure, so match the start.
    await expect(page.locator(`#service-${id}`).getByTitle("How long the vendor took to answer")).toHaveText(
      new RegExp(`^${latencyMs}\\s*ms`),
    );
  }
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(verdict(board).title);
}

/** Console errors, warnings (React reports hydration mismatches as either) and uncaught exceptions. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
  return problems;
}

/** Whether the lens rules are in the stylesheet: the layer is only fixed once they are. The styling tests fail, not skip, when they are missing. */
async function cssLoaded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const layer = document.querySelector(".lenses");
    return layer !== null && getComputedStyle(layer).position === "fixed";
  });
}

test.describe("markup", () => {
  test("has a hidden layer of eleven bubbles", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    await expect(lenses(page)).toHaveCount(1);
    await expect(lenses(page)).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".lenses > .lens")).toHaveCount(11);
    await expect(page.locator(".lenses > .lens > .lens-fx")).toHaveCount(11);
    // The filter definitions are hidden from a screen reader too.
    await expect(page.locator('svg[aria-hidden="true"]:has(#lens-refract)')).toHaveCount(1);
  });

  test("defines the refraction filter in a rendered, zero-size svg", async ({ page }) => {
    await page.goto("/");
    const filter = page.locator("#lens-refract");
    await expect(filter).toHaveCount(1);
    expect(await filter.evaluate((node) => node.tagName.toLowerCase())).toBe("filter");
    // display:none on the svg (or an ancestor) stops the filter resolving in some browsers.
    const box = await page.evaluate(() => {
      const svg = document.querySelector("svg:has(#lens-refract)");
      if (!svg) return null;
      const style = getComputedStyle(svg);
      return { display: style.display, width: style.width, height: style.height };
    });
    expect(box).not.toBeNull();
    expect(box?.display).not.toBe("none");
    expect(box?.width).toBe("0px");
    expect(box?.height).toBe("0px");
    // The displacement map it reads is the asset served below.
    await expect(page.locator("#lens-refract feImage")).toHaveAttribute("href", "/lens-map.png");
  });

  test("serves the displacement map as a PNG", async ({ request }) => {
    const response = await request.get("/lens-map.png");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
    const body = await response.body();
    // The PNG signature; a real map is 128 x 128.
    expect([...body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(header.getUint32(16)).toBe(128);
    expect(header.getUint32(20)).toBe(128);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`adds no console errors or hydration warnings (${colorScheme})`, async ({ page }) => {
      const problems = watchConsole(page);
      await page.emulateMedia({ colorScheme });
      await page.goto("/");
      await expect(lenses(page)).toHaveCount(1);
      await hydrated(page);
      // Hydration runs after the first paint; give React time to complain.
      await page.waitForLoadState("networkidle");
      expect(problems).toEqual([]);
    });
  }
});

test.describe("background", () => {
  const layers = [".aurora", ".lenses"];

  test("Quiet, the default, draws none of it and sets no attribute", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    await expect(page.locator("html")).not.toHaveAttribute("data-background");
    for (const layer of layers) expect(await shown(page, layer), layer).toBe(false);
    // The markup is there all the same: the server and the browser render one page.
    await expect(page.locator(".lenses > .lens")).toHaveCount(11);
  });

  test("Glass shows the still glow, and no lenses", async ({ page }) => {
    await chooseBackground(page, "glass");
    await page.goto("/");
    await hydrated(page);
    await expect(page.locator("html")).toHaveAttribute("data-background", "glass");
    expect(await shown(page, ".aurora")).toBe(true);
    expect(await shown(page, ".lenses")).toBe(false);
    // Still: the drift belongs to Full.
    const drift = await page.locator(".aurora").evaluate((node) => getComputedStyle(node, "::before").animationName);
    expect(drift).toBe("none");
  });

  test("Full shows the glow and the lenses", async ({ page }) => {
    await chooseBackground(page, "full");
    await page.goto("/");
    await hydrated(page);
    await expect(page.locator("html")).toHaveAttribute("data-background", "full");
    for (const layer of layers) expect(await shown(page, layer), layer).toBe(true);
  });

  test("an unknown stored value is Quiet", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("status-bar:background", "neon"));
    await page.goto("/");
    await hydrated(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-background");
    expect(await shown(page, ".lenses")).toBe(false);
  });

  test("Reduce glass wins over Full: nothing of the layers is drawn", async ({ page }) => {
    await chooseBackground(page, "full");
    await page.addInitScript(() => localStorage.setItem("status-bar:reduce-glass", "on"));
    await page.goto("/");
    await hydrated(page);
    await expect(page.locator("html")).toHaveAttribute("data-reduce-transparency", "true");
    for (const layer of layers) expect(await shown(page, layer), layer).toBe(false);
  });
});

test.describe("Settings, Background", () => {
  const html = (page: Page) => page.locator("html");
  const stored = (page: Page) => page.evaluate(() => localStorage.getItem("status-bar:background"));

  async function openSettings(page: Page): Promise<void> {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }

  test("offers Quiet, Glass and Full, Quiet first and chosen, and says what each is", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    await openSettings(page);
    const group = page.getByRole("group", { name: "Background" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(3);
    await expect(group.getByRole("radio", { name: "Quiet" })).toBeChecked();
    await expect(group.getByRole("status")).toHaveText("Flat paper. Nothing moves behind the page.");
    // The first thing in the dialog, above the switches.
    const order = await page
      .getByRole("dialog")
      .evaluate((dialog) => [...dialog.querySelectorAll("legend, [role=switch]")].map((node) => node.tagName));
    expect(order[0]).toBe("LEGEND");
  });

  test("sets the choice at once, keeps it across a reload, and puts Quiet back", async ({ page }) => {
    const problems = watchConsole(page);
    await page.goto("/");
    await hydrated(page);
    await openSettings(page);
    const group = page.getByRole("group", { name: "Background" });

    await page.locator("label", { hasText: "Glass" }).click();
    await expect(html(page)).toHaveAttribute("data-background", "glass");
    await expect(group.getByRole("status")).toHaveText(
      "Frosted panels over a still glow, with a soft light that wanders across the cards.",
    );
    expect(await stored(page)).toBe("glass");

    await page.reload();
    await hydrated(page);
    await expect(html(page)).toHaveAttribute("data-background", "glass");
    await openSettings(page);
    await expect(page.getByRole("radio", { name: "Glass" })).toBeChecked();

    await page.locator("label", { hasText: "Full" }).click();
    await expect(html(page)).toHaveAttribute("data-background", "full");
    await expect(page.getByRole("group", { name: "Background" }).getByRole("status")).toContainText("glass lenses");
    expect(await stored(page)).toBe("full");

    await page.locator("label", { hasText: "Quiet" }).click();
    await expect(html(page)).not.toHaveAttribute("data-background");
    expect(await stored(page)).toBe("quiet");
    expect(problems).toEqual([]);
  });

  test("moves with the arrow keys, like any radio group", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    await openSettings(page);
    await page.getByRole("radio", { name: "Quiet" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(html(page)).toHaveAttribute("data-background", "glass");
    await page.keyboard.press("ArrowRight");
    await expect(html(page)).toHaveAttribute("data-background", "full");
    await page.keyboard.press("ArrowLeft");
    await expect(html(page)).toHaveAttribute("data-background", "glass");
  });

  test("follows another tab, and says when Reduce glass keeps the page solid", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    await openSettings(page);
    // A real second tab in the same browser context: its write makes the browser fire a genuine storage event here.
    const other = await page.context().newPage();
    try {
      await other.goto("/");
      await hydrated(other);
      await other.evaluate(() => localStorage.setItem("status-bar:background", "full"));
    } finally {
      await other.close();
    }
    await expect(html(page)).toHaveAttribute("data-background", "full");
    await expect(page.getByRole("radio", { name: "Full" })).toBeChecked();
    await page.getByRole("switch", { name: "Reduce glass" }).click();
    await expect(page.getByRole("group", { name: "Background" }).getByRole("status")).toContainText(
      "Reduce glass is on, so the page stays solid.",
    );
  });

  test("a stored Full sets the attribute before React hydrates, with no hydration warning", async ({ page }) => {
    const problems = watchConsole(page);
    await chooseBackground(page, "full");
    // Read the attribute the moment the document exists: the boot script in <head> has run, React has not.
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        (window as unknown as { __early: string | null }).__early =
          document.documentElement.getAttribute("data-background");
      });
    });
    await page.goto("/");
    await hydrated(page);
    expect(await page.evaluate(() => (window as unknown as { __early: string | null }).__early)).toBe("full");
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
});

test.describe("styling", () => {
  test.beforeEach(async ({ page }) => {
    await chooseBackground(page, "full");
  });

  test("the layer takes no click, tap or hover from the board", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    expect(await lenses(page).evaluate((layer) => getComputedStyle(layer).pointerEvents)).toBe("none");
  });

  test("each lens filters its copy of the aurora", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    const filters = await page
      .locator(".lens-fx")
      .evaluateAll((all) => all.map((node) => getComputedStyle(node).filter));
    expect(filters).toHaveLength(11);
    // Browsers serialise the reference with or without quotes.
    for (const filter of filters) expect(filter).toMatch(/^url\(("|')?#lens-refract("|')?\)$/);
  });

  test("Reduce glass takes the lenses off the page", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    expect(await lenses(page).evaluate((layer) => getComputedStyle(layer).display)).not.toBe("none");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: "Reduce glass" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-reduce-transparency", "true");
    await expect(lenses(page)).toBeHidden();
  });

  /** Each drawn bubble's running animations, by name: what moves it. (A bubble a width does not draw has none.) */
  const motion = (page: Page) =>
    page
      .locator(".lens")
      .evaluateAll((all) =>
        all
          .filter((lens) => getComputedStyle(lens).display !== "none")
          .map((lens) => lens.getAnimations().map((animation) => (animation as CSSAnimation).animationName)),
      );

  test("reduced motion stills the bubbles", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    const names = await page
      .locator(".lens")
      .evaluateAll((all) => all.map((lens) => getComputedStyle(lens).animationName));
    expect(names).toEqual(Array(11).fill("none"));
    expect((await motion(page)).flat()).toEqual([]);
  });

  test("the bubbles drift and breathe under a fine pointer, each on its own pace, and stand still under touch", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    const fine = await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches);
    const running = await motion(page);
    expect(running.length).toBeGreaterThanOrEqual(6);
    if (!fine) {
      expect(running.flat()).toEqual([]);
      return;
    }
    // Sideways, up and down, and a breath: compositor properties only, never a layout or paint property.
    for (const names of running) expect(names).toEqual(["bubble-sway", "bubble-bob", "bubble-breathe"]);
    const timing = await page.locator(".lens").evaluateAll((all) =>
      all
        .filter((lens) => getComputedStyle(lens).display !== "none")
        .map((lens) =>
          lens.getAnimations().map((animation) => {
            const effect = animation.effect as KeyframeEffect;
            const properties = new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)));
            return { duration: effect.getTiming().duration, properties: [...properties].sort().join(",") };
          }),
        ),
    );
    for (const bubble of timing) {
      expect(bubble.map((a) => a.properties)).toEqual([
        "composite,computedOffset,easing,offset,translate",
        "composite,computedOffset,easing,offset,transform",
        "composite,computedOffset,easing,offset,scale",
      ]);
      // Every loop is slow (the breath is the shortest, and every iteration is a style recalculation on the main thread): ten seconds or more.
      for (const animation of bubble) expect(Number(animation.duration)).toBeGreaterThanOrEqual(10_000);
    }
    // Their own timing: no two bubbles share a drift duration.
    const drifts = timing.map((bubble) => bubble[0].duration);
    expect(new Set(drifts).size).toBe(drifts.length);
  });

  /**
   * The drawn bubbles, each with the box it sweeps (its own box and its float's reach: --dx and --dy are cqmin),
   * against the bare text of the page at the top: text outside every panel, whose blur would soften a bubble.
   * Also, from 48rem (768px), where it becomes a column, against the margin column's whole x-range, which the text runs down as the page scrolls under the fixed layer.
   * With `anyHeight`, a text counts wherever it is on the page (the layer is fixed and the page scrolls under it), so the answer
   * holds at every scroll position and for any board, not only for what happens to be under a bubble now.
   */
  async function bubblesOnText(page: Page, anyHeight = false) {
    return page.evaluate((anyHeight) => {
      // What of a text is actually painted: its sides cut at every ancestor that clips sideways (a strip that scrolls
      // sideways, like the filter tabs on a narrow screen, runs its text out under the screen's edge by design, but is
      // clipped at its own box). The part left, if any, is what a bubble can meet.
      const painted = (element: Element, box: DOMRect) => {
        let left = box.left;
        let right = box.right;
        for (let up: Element | null = element; up; up = up.parentElement) {
          if (getComputedStyle(up).overflowX === "visible") continue;
          const clip = up.getBoundingClientRect();
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
        return right - left > 0.5 ? { left, right } : null;
      };
      const unit = Math.min(innerWidth, innerHeight) / 100;
      const sweeps = [...document.querySelectorAll<HTMLElement>(".lens")]
        .filter((lens) => getComputedStyle(lens).display !== "none")
        .map((lens, index) => {
          const style = getComputedStyle(lens);
          const box = lens.getBoundingClientRect();
          const dx = Number.parseFloat(style.getPropertyValue("--dx")) * unit;
          const dy = Number.parseFloat(style.getPropertyValue("--dy")) * unit;
          return { index, left: box.left - dx, right: box.right + dx, top: box.top - dy, bottom: box.bottom + dy };
        });
      const texts: { label: string; left: number; right: number; top: number; bottom: number }[] = [];
      const walker = document.createTreeWalker(document.querySelector(".liquid-content") as Node, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node.parentElement;
        if (!element || !node.textContent?.trim()) continue;
        if (element.closest(".surface, .sr-only, [aria-hidden=true], .float")) continue;
        if (getComputedStyle(element).visibility === "hidden") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const box of range.getClientRects()) {
          const sides = box.width > 0 ? painted(element, box) : null;
          if (sides)
            texts.push({
              label: node.textContent.trim().slice(0, 24),
              ...box.toJSON(),
              ...sides,
              ...(anyHeight ? { top: -Infinity, bottom: Infinity } : {}),
            });
        }
      }
      const margin = [...document.querySelectorAll(".board-margin")].map((el) => el.getBoundingClientRect());
      const hits: string[] = [];
      for (const sweep of sweeps) {
        for (const text of texts)
          if (text.left < sweep.right && text.right > sweep.left && text.top < sweep.bottom && text.bottom > sweep.top)
            hits.push(`bubble ${sweep.index + 1} over "${text.label}"`);
        for (const column of margin)
          if (innerWidth >= 768 && column.width > 0 && column.left < sweep.right && column.right > sweep.left)
            hits.push(
              `bubble ${sweep.index + 1} inside the margin column (${Math.round(column.left)}-${Math.round(column.right)})`,
            );
      }
      return hits;
    }, anyHeight);
  }

  for (const [width, height] of [
    [1024, 768],
    [1180, 820],
    [1280, 720],
    [1366, 768],
    [1440, 900],
    [1600, 900],
    [1601, 900],
    [2560, 1440],
    [1920, 1080],
  ] as const) {
    test(`at ${width}x${height} no bubble sits over the margin column or any bare text`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "needs a desktop-width page");
      await page.setViewportSize({ width, height });
      await serveBoard(page, () => fixtureBoard(Date.now()));
      await page.goto("/");
      await hydrated(page);
      await loadFixture(page, fixtureBoard);
      expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
      expect(await bubblesOnText(page)).toEqual([]);
    });
  }

  test("a narrow screen draws fewer, smaller bubbles in its own places", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveBoard(page, () => fixtureBoard(Date.now()));
    await page.goto("/");
    await hydrated(page);
    await loadFixture(page, fixtureBoard);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    const boxes = await page.locator(".lens").evaluateAll((all) =>
      all.map((lens) => {
        const box = lens.getBoundingClientRect();
        return { shown: getComputedStyle(lens).display !== "none", d: box.width, cx: box.x + box.width / 2 };
      }),
    );
    const drawn = boxes.filter((box) => box.shown);
    expect(drawn).toHaveLength(6);
    for (const box of drawn) expect(box.d).toBeLessThanOrEqual(48);
    // On the edges (some partly off the screen), clear of the middle of the column the text runs down.
    for (const box of drawn) expect(Math.abs(box.cx - 195)).toBeGreaterThan(120);
    expect(await bubblesOnText(page)).toEqual([]);
  });

  // The layer is fixed and the page scrolls under it, so "off the text" cannot depend on how tall the cards happen to
  // be: it has to hold at every scroll position, for every board. The bubbles stay in the side gutter, where no text is.
  for (const [width, height] of [
    [320, 568],
    [360, 740],
    [390, 844],
    [430, 932],
    [600, 900],
    [767, 1024],
  ] as const) {
    for (const [shape, board] of [
      ["the usual board", fixtureBoard],
      ["a calm board", calmBoard],
      ["the longest hero", longHeroBoard],
    ] as const) {
      test(`at ${width}x${height} no bubble can reach any text, on ${shape}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "desktop", "one Chromium run covers the geometry");
        await page.setViewportSize({ width, height });
        await serveBoard(page, () => board(Date.now()));
        await page.goto("/");
        await hydrated(page);
        await loadFixture(page, board);
        expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
        expect(await page.locator(".lens:visible").count()).toBe(6);
        expect(await bubblesOnText(page, true)).toEqual([]);
      });
    }
  }

  test("bubbles are small, and laptop and tablet widths draw nine", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "needs a desktop-width page");
    for (const [width, height, count] of [
      [1440, 900, 9],
      [1920, 1080, 11],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await hydrated(page);
      expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
      const sizes = await page
        .locator(".lens")
        .evaluateAll((all) =>
          all
            .filter((lens) => getComputedStyle(lens).display !== "none")
            .map((lens) => lens.getBoundingClientRect().width),
        );
      expect(sizes).toHaveLength(count);
      for (const size of sizes) {
        expect(size).toBeGreaterThanOrEqual(12);
        expect(size).toBeLessThanOrEqual(80);
      }
    }
  });

  test("forced colours hide the lenses", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    await expect(lenses(page)).toBeHidden();
  });

  test("Increase Contrast hides the lenses", async ({ page }) => {
    await page.emulateMedia({ contrast: "more" });
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    await expect(lenses(page)).toBeHidden();
  });
});

test.describe("no ruled lines", () => {
  for (const background of ["quiet", "glass", "full"] as const) {
    test(`${background} has no grid element and no layer paints a line pattern`, async ({ page }) => {
      await chooseBackground(page, background);
      await page.goto("/");
      await hydrated(page);
      await expect(page.locator(".aurora-grid")).toHaveCount(0);
      const painted = await page.evaluate(() => {
        // The layers' computed background-image, split at the commas outside any brackets.
        const layersOf = (image: string) => {
          const layers: string[] = [];
          let depth = 0;
          let start = 0;
          for (let i = 0; i < image.length; i++) {
            if (image[i] === "(") depth++;
            else if (image[i] === ")") depth--;
            else if (image[i] === "," && depth === 0) {
              layers.push(image.slice(start, i).trim());
              start = i + 1;
            }
          }
          layers.push(image.slice(start).trim());
          return layers;
        };
        // A hairline: a colour that stops hard, within 3px, on transparent ("a 1px, transparent 1px").
        const hairline = /(\d+(?:\.\d+)?)px\s*,\s*(?:transparent|rgba\(0,\s*0,\s*0,\s*0\))\s+\1px/;
        const roots = "html, body, .liquid-stage, .liquid-content, .liquid-stage > *, .aurora *, .lenses *";
        const found: string[] = [];
        for (const node of document.querySelectorAll(roots)) {
          for (const pseudo of [null, "::before", "::after"]) {
            const image = getComputedStyle(node, pseudo).backgroundImage;
            const lines = layersOf(image).filter(
              (layer) =>
                layer.startsWith("linear-gradient(") &&
                hairline.test(layer) &&
                Number.parseFloat(hairline.exec(layer)?.[1] ?? "99") <= 3,
            );
            if (/repeating-/.test(image) || lines.length >= 2)
              found.push(`${node.tagName.toLowerCase()}.${node.className} ${pseudo ?? ""}`.trim());
          }
        }
        return found;
      });
      expect(painted).toEqual([]);
    });
  }
});

test.describe("card light", () => {
  const lightTransform = (page: Page, index: number) =>
    page
      .locator(".spotlight")
      .nth(index)
      .evaluate((node) => getComputedStyle(node, "::after").transform);
  const lightOpacity = (page: Page) =>
    page
      .locator(".spotlight")
      .first()
      .evaluate((node) => getComputedStyle(node, "::after").opacity);
  // The wander runs on every device, a touch screen's included, unless Tilt lighting has taken the light over: the page
  // has given the card a place for it (--wander-x and --wander-y) and the style sheet draws it there.
  const wandering = (page: Page) =>
    page
      .locator(".spotlight")
      .first()
      .evaluate((node) => node.hasAttribute("data-wander") && node.style.getPropertyValue("--wander-x") !== "");

  test("is drawn on Glass and Full and absent on Quiet", async ({ page }) => {
    const content = () =>
      page
        .locator(".spotlight")
        .first()
        .evaluate((node) => getComputedStyle(node, "::after").content);
    await page.addInitScript((value) => localStorage.setItem("status-bar:background", value), "quiet");
    await page.goto("/");
    await hydrated(page);
    expect(await content()).toMatch(/none|normal/);
    expect(await wandering(page)).toBe(false);
    await page.evaluate(() => localStorage.clear());
    for (const background of ["glass", "full"] as const) {
      await chooseBackground(page, background);
      await page.goto("/");
      await hydrated(page);
      await expect.poll(() => wandering(page)).toBe(true);
      expect(await content()).not.toMatch(/none|normal/);
      // The reveal is a 250ms transition: wait for it to leave 0.
      await expect.poll(async () => Number(await lightOpacity(page))).toBeGreaterThan(0);
    }
  });

  test("moves on its own and never follows the pointer", async ({ page }) => {
    await chooseBackground(page, "full");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await hydrated(page);
    await expect.poll(() => wandering(page)).toBe(true);
    const before = await lightTransform(page, 0);
    await page.waitForTimeout(2500);
    expect(await lightTransform(page, 0)).not.toBe(before);
    // The pointer does not write a position any more, not even over a card.
    const background = () =>
      page
        .locator(".spotlight")
        .first()
        .evaluate((node) => getComputedStyle(node, "::after").backgroundImage);
    const spotProps = () =>
      page.evaluate(() => {
        const written: string[] = [];
        for (const node of document.querySelectorAll<HTMLElement>("*")) {
          for (const name of Array.from(node.style))
            if (name.startsWith("--spot-")) written.push(`${node.tagName.toLowerCase()} ${name}`);
        }
        return written;
      });
    const restingBackground = await background();
    const box = await page.locator(".spotlight").first().boundingBox();
    if (!box) throw new Error("the first card has no box");
    await page.mouse.move(40, 40);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 + 7, box.y + box.height / 2 + 5);
    expect(await spotProps()).toEqual([]);
    expect(await background()).toBe(restingBackground);
  });

  test("two surfaces are not in lockstep", async ({ page }) => {
    await chooseBackground(page, "full");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await hydrated(page);
    await expect.poll(() => wandering(page)).toBe(true);
    const count = await page.locator(".spotlight").count();
    expect(count).toBeGreaterThan(1);
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) seen.add(await lightTransform(page, i));
    expect(seen.size).toBeGreaterThan(1);
  });

  test("Reduce glass takes the light off Full", async ({ page }) => {
    await chooseBackground(page, "full");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await hydrated(page);
    const display = () =>
      page
        .locator(".spotlight")
        .first()
        .evaluate((node) => getComputedStyle(node, "::after").display);
    await expect.poll(display, "drawn before Reduce glass").toBe("block");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: "Reduce glass" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-reduce-transparency", "true");
    await expect.poll(display, "hidden under Reduce glass").toBe("none");
  });

  test("wanders on every device, touch screens too, with no Tilt lighting", async ({ page }) => {
    await chooseBackground(page, "full");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await hydrated(page);
    // Nothing drives a light here, so the wander is the light on every device.
    await expect(page.locator("html")).not.toHaveAttribute("data-tilt", "on");
    await expect.poll(() => wandering(page)).toBe(true);
    const light = await page
      .locator(".spotlight")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node, "::after");
        return { animationName: style.animationName, content: style.content, width: style.width, height: style.height };
      });
    // Not a CSS animation (see wander-light.ts), and a layer of the light's own size, not the card's.
    expect(light.animationName).toBe("none");
    expect(light.content).not.toMatch(/none|normal/);
    expect([light.width, light.height]).toEqual(["432px", "432px"]);
  });

  test("stands still under reduced motion", async ({ page }) => {
    await chooseBackground(page, "full");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await hydrated(page);
    const first = await lightTransform(page, 0);
    await page.waitForTimeout(2500);
    expect(await lightTransform(page, 0)).toBe(first);
    expect(
      await page
        .locator(".spotlight")
        .first()
        .evaluate((node) => getComputedStyle(node, "::after").display),
    ).toBe("none");
  });
});

test.describe("contrast", () => {
  test.beforeEach(async ({ page }) => {
    await chooseBackground(page, "full");
  });

  /**
   * The bubbles are painted layers behind the content, so axe cannot see
   * them. With the content hidden and motion off (the aurora and the bubbles
   * stand still, at the places the colour copy is aligned for), this
   * screenshots the page, then checks the WCAG contrast of the two weakest
   * text colours against every pixel that is more than 3px inside a bubble's
   * rim, its highlights included. The rim hairline itself is exempt.
   */
  for (const colorScheme of ["light", "dark"] as const) {
    test(`keeps subtle and muted text at 4.5:1 inside the lenses (${colorScheme})`, async ({
      page,
      context,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "measured once, in Chromium on a desktop");
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.goto("/");
      await hydrated(page);
      expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
      await page.addStyleTag({ content: ".liquid-content { visibility: hidden !important; }" });
      const setup = await page.evaluate(() => {
        // Resolves a token to its rgb() channels in the current colour scheme.
        const channels = (token: string) => {
          const probe = document.createElement("i");
          probe.style.color = `var(${token})`;
          document.body.appendChild(probe);
          const found = getComputedStyle(probe).color.match(/[\d.]+/g) ?? [];
          probe.remove();
          return found.slice(0, 3).map(Number);
        };
        return {
          colours: { subtle: channels("--color-subtle"), muted: channels("--color-muted") },
          discs: [...document.querySelectorAll(".lens")].map((lens) => {
            const box = lens.getBoundingClientRect();
            return [box.x + box.width / 2, box.y + box.height / 2, box.width / 2];
          }),
        };
      });
      expect(setup.discs).toHaveLength(11);
      const shot = await page.screenshot({ animations: "disabled" });

      // Decode and measure on a blank page: the board's CSP would refuse a data: fetch.
      const helper = await context.newPage();
      try {
        const result = await helper.evaluate(
          async ({ b64, discs, colours }) => {
            const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const canvasContext = canvas.getContext("2d");
            if (!canvasContext) throw new Error("no 2d canvas");
            canvasContext.drawImage(image, 0, 0);
            const { data } = canvasContext.getImageData(0, 0, image.width, image.height);
            const linear = (value: number) => {
              const v = value / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            };
            const luminance = (r: number, g: number, b: number) =>
              0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
            const text = {
              subtle: luminance(colours.subtle[0], colours.subtle[1], colours.subtle[2]),
              muted: luminance(colours.muted[0], colours.muted[1], colours.muted[2]),
            };
            const failures = { subtle: 0, muted: 0 };
            const worst = { subtle: 99, muted: 99 };
            let checked = 0;
            for (const [cx, cy, radius] of discs) {
              const inner = radius - 3;
              const top = Math.max(0, Math.floor(cy - inner));
              const bottom = Math.min(image.height - 1, Math.ceil(cy + inner));
              const left = Math.max(0, Math.floor(cx - inner));
              const right = Math.min(image.width - 1, Math.ceil(cx + inner));
              for (let y = top; y <= bottom; y++) {
                for (let x = left; x <= right; x++) {
                  if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > inner) continue;
                  const at = (y * image.width + x) * 4;
                  const back = luminance(data[at], data[at + 1], data[at + 2]);
                  checked++;
                  for (const name of ["subtle", "muted"] as const) {
                    const ratio = (Math.max(back, text[name]) + 0.05) / (Math.min(back, text[name]) + 0.05);
                    worst[name] = Math.min(worst[name], ratio);
                    if (ratio < 4.5) failures[name]++;
                  }
                }
              }
            }
            return { checked, failures, worst };
          },
          { b64: Buffer.from(shot).toString("base64"), discs: setup.discs, colours: setup.colours },
        );
        // Not vacuous: nine small bubbles are drawn at this width, a couple of thousand pixels between them.
        expect(result.checked).toBeGreaterThan(1_500);
        expect(result.failures, `worst ratios ${JSON.stringify(result.worst)}`).toEqual({ subtle: 0, muted: 0 });
      } finally {
        await helper.close();
      }
    });
  }

  /**
   * The glass panels are lighter at the top and at their upper left, where the
   * tint and the sheen add to the backdrop, so that is where the two weakest
   * text colours are tightest. This reads the pixels behind every subtle or
   * muted text run inside a panel (the text made transparent, so only the
   * backdrop is left) and checks the worst one against 4.5:1. A run that
   * crosses a lens's rim hairline, or sits under the floating bar, is left out.
   *
   * The aurora is fixed and the panels scroll over it, so the same text is on a
   * lighter or darker part of it at every scroll offset, and the page below the
   * first screen is not the first screen: each test measures at several offsets
   * (350 or 700px apart, from the top to the end of the page). The runs are
   * found again at each one, in the layout the page has there, and are measured
   * only when the layout is the same before and after the screenshot.
   *
   * Every panel and list wears the card light on Glass and on Full (and, with
   * Tilt lighting on a touch screen, the glint), which Reduce Motion hides, so
   * each background runs twice: as the page renders under Reduce Motion, and
   * with the lights forced on at their peak over the whole of every panel, the
   * wander's layer included (lightsAtTheirStrongest).
   */
  for (const background of ["glass", "full"] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      for (const cardLight of [false, true]) {
        test(`keeps subtle and muted text at 4.5:1 on the glass panels (${background}, ${colorScheme}${cardLight ? ", lights at their strongest" : ""})`, async ({
          page,
          context,
        }, testInfo) => {
          test.skip(testInfo.project.name !== "desktop", "measured once, in Chromium on a desktop");
          // A screenshot of a 1280x1200 page, read back, at each of several offsets: seconds apiece on a busy runner.
          test.slow();
          // After the describe's own choice of Full, so this one wins.
          await chooseBackground(page, background);
          const board = fixtureBoard(Date.now());
          await serveBoard(page, () => board);
          // Tall enough for the hero and the first lists, so plenty of subtle and muted runs are whole on screen.
          await page.setViewportSize({ width: 1280, height: 1200 });
          await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
          await page.goto("/");
          await hydrated(page);
          // Measured at a pixel ratio of 1: the runs' boxes are in CSS pixels, and so are the screenshot's.
          expect(await page.evaluate(() => devicePixelRatio)).toBe(1);
          await page.getByRole("button", { name: "Refresh status now" }).first().click();
          // The most urgent card's "since" line sits at the brightest corner of a panel.
          await expect(page.locator("#service-aws").getByText("Outage", { exact: true }).first()).toBeVisible();
          await page.waitForTimeout(500);
          // The click left the pointer on the Refresh button, and scrolling would bring other things under it:
          // hover brightens the chips and rows, which is not what is measured here.
          await page.mouse.move(0, 0);
          if (cardLight) {
            // The stronger of the two lights is the one whose token has the larger alpha. Read, not assumed, so a
            // change to either token keeps the strongest one under test.
            const strongestLight = await page.evaluate(() => {
              const alpha = (token: string) => {
                const probe = document.createElement("i");
                probe.style.color = `var(${token})`;
                document.body.appendChild(probe);
                const channels = getComputedStyle(probe).color.match(/[\d.]+/g) ?? [];
                probe.remove();
                return channels.length > 3 ? Number(channels[3]) : 1;
              };
              return alpha("--tilt-glint") >= alpha("--spot-color") ? "--tilt-glint" : "--spot-color";
            });
            await page.addStyleTag({ content: lightsAtTheirStrongest(colorScheme, strongestLight) });
            const drawn = await page.evaluate(() => {
              const panel = document.querySelector(".spotlight");
              if (!panel) return null;
              const read = (pseudo: "::before" | "::after") => {
                const style = getComputedStyle(panel, pseudo);
                // inset: 0 makes it as wide as the panel's padding box.
                const whole = Math.abs(Number.parseFloat(style.width) - panel.clientWidth) < 1.5;
                return [style.display, style.position, style.opacity, style.transform, whole];
              };
              return { sheen: read("::before"), light: read("::after") };
            });
            expect(drawn?.light, "the forced light covers the whole panel, at full strength, unmoved").toEqual([
              "block",
              "absolute",
              "1",
              "none",
              true,
            ]);
            if (colorScheme === "dark") {
              expect(drawn?.sheen.slice(0, 2), "the forced sheen is drawn").toEqual(["block", "absolute"]);
            }
          }

          const colours = await page.evaluate(() => {
            const channels = (token: string) => {
              const probe = document.createElement("i");
              probe.style.color = `var(${token})`;
              document.body.appendChild(probe);
              const found = getComputedStyle(probe).color.match(/[\d.]+/g) ?? [];
              probe.remove();
              return found.slice(0, 3).map(Number);
            };
            return { subtle: channels("--color-subtle"), muted: channels("--color-muted") };
          });
          // The bubbles are fixed to the viewport, like the aurora, so their discs are the same at every offset.
          const discs = await page.evaluate(() =>
            [...document.querySelectorAll(".lens")].map((lens) => {
              const box = lens.getBoundingClientRect();
              return [box.x + box.width / 2, box.y + box.height / 2, box.width / 2];
            }),
          );

          /**
           * Every text run inside a panel, where it is in the viewport now: its box, and (with the text still drawn,
           * so its colour says which kind it is) whether it is a subtle or a muted one. `boxes` lists every run
           * of text of any colour, to tell whether the layout moved.
           */
          const readRuns = (kinds: boolean) =>
            page.evaluate(
              ({ kinds, colours }) => {
                const runs: { kind: "subtle" | "muted"; text: string; x: number; y: number; w: number; h: number }[] =
                  [];
                const boxes: number[][] = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                  const element = node.parentElement;
                  const text = node.textContent?.trim();
                  if (!element || !text || !element.closest(".surface") || element.closest(".sr-only")) continue;
                  // The body of a closed <details> is not drawn, though it still has a box.
                  const details = element.closest("details:not([open])");
                  if (details && !element.closest("summary")) continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  const box = range.getBoundingClientRect();
                  boxes.push([box.x, box.y, box.width, box.height]);
                  if (!kinds) continue;
                  const color =
                    getComputedStyle(element)
                      .color.match(/[\d.]+/g)
                      ?.slice(0, 3)
                      .map(Number) ?? [];
                  const kind = (["subtle", "muted"] as const).find((name) =>
                    colours[name].every((v, i) => v === color[i]),
                  );
                  // Whole in the viewport, so the screenshot has all of it.
                  if (!kind || box.width < 2) continue;
                  if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) continue;
                  runs.push({ kind, text: text.slice(0, 30), x: box.x, y: box.y, w: box.width, h: box.height });
                }
                return {
                  runs,
                  boxes,
                  // The floating bar (and any sheet) is drawn over the panels, so what is behind a run under it is not
                  // the panel's.
                  covers: [...document.querySelectorAll(".float, .sheet")].map((node) => {
                    const box = node.getBoundingClientRect();
                    return [box.left, box.top, box.right, box.bottom];
                  }),
                  top: Math.max(0, document.documentElement.scrollHeight - innerHeight),
                };
              },
              { kinds, colours },
            );
          const sameBoxes = (a: number[][], b: number[][]) =>
            a.length === b.length && a.every((box, i) => box.every((value, j) => Math.abs(value - b[i][j]) < 0.5));

          /** At `offset`: the runs, and a screenshot of the page with its text made transparent, taken in the same layout. */
          const shootAt = async (offset: number) => {
            for (let attempt = 0; attempt < 5; attempt++) {
              const view = await page.evaluate((y) => {
                window.scrollTo(0, y);
                return { top: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
              }, offset);
              await afterTwoFrames(page);
              // Where it was asked to be, or the end of the page.
              const reach = await page.evaluate(() => Math.round(window.scrollY));
              expect(reach, `scrolled to ${offset} (the page ends at ${view.top})`).toBe(Math.min(offset, view.top));
              const before = await readRuns(true);
              const hide = await page.addStyleTag({
                content: "*{color:transparent !important;text-shadow:none !important}",
              });
              await afterTwoFrames(page);
              const shot = await page.screenshot({ animations: "disabled" });
              const after = await readRuns(false);
              await hide.evaluate((node) => node.parentNode?.removeChild(node));
              if (sameBoxes(before.boxes, after.boxes)) return { shot, before, reach };
            }
            throw new Error(`the text kept moving at scrollY ${offset}`);
          };

          const first = await shootAt(0);
          // Not vacuous: both colours are used on panels, among them the urgent card's "since" line.
          expect(first.before.runs.some((run) => run.text === "since")).toBe(true);
          expect(first.before.runs.filter((run) => run.kind === "subtle").length).toBeGreaterThan(8);
          expect(first.before.runs.filter((run) => run.kind === "muted").length).toBeGreaterThan(2);
          // The fixed backdrop is brighter in some places than in others, and it is the dark side that is tight: there,
          // with the lights at their peak, the offsets are 350px apart; elsewhere 700px.
          const offsets = scrollOffsets(first.before.top, colorScheme === "dark" && cardLight ? 350 : 700);
          expect(offsets.length, "the page is long enough to scroll").toBeGreaterThan(2);

          const helper = await context.newPage();
          const rows: string[] = [];
          const failing: string[] = [];
          let measured = 0;
          let worstOverall = { subtle: 99, muted: 99 };
          try {
            for (const offset of offsets) {
              const { shot, before, reach } = offset === 0 ? first : await shootAt(offset);
              const runs = before.runs.filter(
                (run) =>
                  !before.covers.some(
                    ([left, top, right, bottom]) =>
                      run.x < right && run.x + run.w > left && run.y < bottom && run.y + run.h > top,
                  ),
              );
              const result = await helper.evaluate(
                async ({ b64, colours, discs, runs }) => {
                  const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
                  const canvas = document.createElement("canvas");
                  canvas.width = image.width;
                  canvas.height = image.height;
                  const canvasContext = canvas.getContext("2d");
                  if (!canvasContext) throw new Error("no 2d canvas");
                  canvasContext.drawImage(image, 0, 0);
                  const linear = (value: number) => {
                    const v = value / 255;
                    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
                  };
                  const luminance = (r: number, g: number, b: number) =>
                    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
                  const text = {
                    subtle: luminance(colours.subtle[0], colours.subtle[1], colours.subtle[2]),
                    muted: luminance(colours.muted[0], colours.muted[1], colours.muted[2]),
                  };
                  const worst = { subtle: 99, muted: 99 };
                  const failing: string[] = [];
                  let measured = 0;
                  for (const run of runs) {
                    // A run across a lens's rim (its outer 4px either side) is exempt.
                    const crossesRim = discs.some(([cx, cy, radius]) => {
                      const nearest = Math.hypot(
                        Math.max(run.x - cx, 0, cx - (run.x + run.w)),
                        Math.max(run.y - cy, 0, cy - (run.y + run.h)),
                      );
                      const farthest = Math.max(
                        ...[run.x, run.x + run.w].flatMap((px) =>
                          [run.y, run.y + run.h].map((py) => Math.hypot(px - cx, py - cy)),
                        ),
                      );
                      return nearest < radius + 4 && farthest > radius - 4;
                    });
                    if (crossesRim) continue;
                    const { data } = canvasContext.getImageData(
                      Math.floor(run.x),
                      Math.floor(run.y),
                      Math.ceil(run.w) + 1,
                      Math.ceil(run.h) + 1,
                    );
                    let runWorst = 99;
                    for (let at = 0; at < data.length; at += 4) {
                      const back = luminance(data[at], data[at + 1], data[at + 2]);
                      const t = text[run.kind];
                      runWorst = Math.min(runWorst, (Math.max(back, t) + 0.05) / (Math.min(back, t) + 0.05));
                    }
                    measured++;
                    worst[run.kind] = Math.min(worst[run.kind], runWorst);
                    if (runWorst < 4.5) {
                      failing.push(
                        `${run.kind} "${run.text}" ${runWorst.toFixed(2)} at ${Math.round(run.x)},${Math.round(run.y)}`,
                      );
                    }
                  }
                  return { measured, worst, failing };
                },
                { b64: Buffer.from(shot).toString("base64"), colours, discs, runs },
              );
              measured += result.measured;
              worstOverall = {
                subtle: Math.min(worstOverall.subtle, result.worst.subtle),
                muted: Math.min(worstOverall.muted, result.worst.muted),
              };
              rows.push(`scrollY ${reach}: ${result.measured} runs, worst ${JSON.stringify(result.worst)}`);
              for (const line of result.failing) failing.push(`scrollY ${reach}: ${line}`);
              if (result.failing.length > 0) {
                await testInfo.attach(`scrollY-${reach}.png`, { body: shot, contentType: "image/png" });
              }
            }
          } finally {
            await helper.close();
          }
          testInfo.annotations.push({ type: "worst ratios", description: JSON.stringify(worstOverall) });
          // Not vacuous: a good few runs at every offset.
          expect(measured).toBeGreaterThan(offsets.length * 10);
          expect(failing, `worst ratios ${JSON.stringify(worstOverall)}\n${rows.join("\n")}`).toEqual([]);
        });
      }
    }
  }
});
