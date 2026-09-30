import { expect, type Page, test } from "@playwright/test";
import { fixtureBoard, serveBoard } from "./fixture-board";

// The liquid-glass lens layer (src/components/status/lens-field.tsx and the
// .lens rules in src/background.css): its markup and asset, the rules that hide,
// still or place it, and a per-pixel contrast check. The layer is Full's: the
// default Quiet background and Glass hide it, and the markup is there either way.
//
// Contrast: board.spec.ts's contrastFailures strips pseudo-elements and every
// background-image before it runs axe, so it cannot see the lens layer. The
// last test here measures it instead: with the content hidden and motion off,
// it screenshots each lens disc and checks --color-subtle and --color-muted
// against every pixel more than 3px inside the rim, in light and dark. The
// budget is 4.5:1 there, grid lines included; only the rim hairline (the outer
// 3px) is exempt. The lens colours are alpha tokens in src/background.css, so
// this is the test to run whenever one of them changes.

const lenses = (page: Page) => page.locator(".lenses");

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

/** Waits until React has hydrated the page (a copy of the helper in board.spec.ts). */
async function hydrated(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
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
  test("has a hidden layer of four lenses", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    await expect(lenses(page)).toHaveCount(1);
    await expect(lenses(page)).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".lenses > .lens")).toHaveCount(4);
    await expect(page.locator(".lenses > .lens > .lens-fx")).toHaveCount(4);
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
  const layers = [".aurora", ".aurora-grid", ".lenses"];

  test("Quiet, the default, draws none of it and sets no attribute", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    await expect(page.locator("html")).not.toHaveAttribute("data-background");
    for (const layer of layers) expect(await shown(page, layer), layer).toBe(false);
    // The markup is there all the same: the server and the browser render one page.
    await expect(page.locator(".lenses > .lens")).toHaveCount(4);
  });

  test("Glass shows the still glow and the grid, and no lenses", async ({ page }) => {
    await chooseBackground(page, "glass");
    await page.goto("/");
    await hydrated(page);
    await expect(page.locator("html")).toHaveAttribute("data-background", "glass");
    expect(await shown(page, ".aurora")).toBe(true);
    expect(await shown(page, ".aurora-grid")).toBe(true);
    expect(await shown(page, ".lenses")).toBe(false);
    // Still: the drift belongs to Full.
    const drift = await page.locator(".aurora").evaluate((node) => getComputedStyle(node, "::before").animationName);
    expect(drift).toBe("none");
    // The grid is whole in Glass: only the lenses hole it.
    const mask = await page.locator(".aurora-grid").evaluate((node) => getComputedStyle(node).maskImage || "none");
    expect(mask).toBe("none");
  });

  test("Full shows all three", async ({ page }) => {
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
    await expect(group.getByRole("status")).toHaveText("Frosted panels over a still glow.");
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
    await page.evaluate(() => {
      localStorage.setItem("status-bar:background", "full");
      window.dispatchEvent(new StorageEvent("storage", { key: "status-bar:background", newValue: "full" }));
    });
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

  test("bends the grid: the real grid is holed and each lens filters its copy", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    const grid = await page.locator(".aurora-grid").evaluate((node) => {
      const style = getComputedStyle(node);
      return { mask: style.maskImage || style.webkitMaskImage || "none" };
    });
    expect(grid.mask).not.toBe("none");
    expect(grid.mask.match(/radial-gradient/g)).toHaveLength(4);
    const filters = await page
      .locator(".lens-fx")
      .evaluateAll((all) => all.map((node) => getComputedStyle(node).filter));
    expect(filters).toHaveLength(4);
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

  test("reduced motion stills the rim light", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    const names = await page
      .locator(".lens")
      .evaluateAll((all) => all.map((lens) => getComputedStyle(lens, "::after").animationName));
    expect(names).toEqual(["none", "none", "none", "none"]);
  });

  test("the rim light orbits under a fine pointer and stands still under touch", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    const fine = await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches);
    const names = await page
      .locator(".lens")
      .evaluateAll((all) => all.map((lens) => getComputedStyle(lens, "::after").animationName));
    expect(names).toHaveLength(4);
    for (const name of names) {
      if (fine) expect(name).not.toBe("none");
      else expect(name).toBe("none");
    }
  });

  test("forced colours hide the lenses and the grid", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    await expect(lenses(page)).toBeHidden();
    await expect(page.locator(".aurora-grid")).toBeHidden();
  });

  test("Increase Contrast hides the lenses and gives the grid back whole", async ({ page }) => {
    await page.emulateMedia({ contrast: "more" });
    await page.goto("/");
    await hydrated(page);
    expect(await cssLoaded(page), "the lens rules are in the build").toBe(true);
    await expect(lenses(page)).toBeHidden();
    // The grid is holed under each lens; with no lenses there is nothing to hole.
    const mask = await page.locator(".aurora-grid").evaluate((grid) => {
      const style = getComputedStyle(grid);
      return style.maskImage || style.webkitMaskImage || "none";
    });
    expect(mask).toBe("none");
  });
});

test.describe("contrast", () => {
  test.beforeEach(async ({ page }) => {
    await chooseBackground(page, "full");
  });

  /**
   * The lens discs are painted layers behind the content, so axe cannot see
   * them. With the content hidden and motion off (the aurora and the rim
   * light stand still), this screenshots the page, then checks the WCAG
   * contrast of the two weakest text colours against every pixel that is more
   * than 3px inside a lens's rim. The rim hairline itself is exempt.
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
      expect(setup.discs).toHaveLength(4);
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
        // Not vacuous: most of four large discs is on screen.
        expect(result.checked).toBeGreaterThan(50_000);
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
   * crosses a lens's rim hairline is left out, as in the lens test above.
   */
  for (const colorScheme of ["light", "dark"] as const) {
    test(`keeps subtle and muted text at 4.5:1 on the glass panels (${colorScheme})`, async ({
      page,
      context,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "measured once, in Chromium on a desktop");
      const board = fixtureBoard(Date.now());
      await serveBoard(page, () => board);
      // Tall enough for the hero and the first lists, so plenty of subtle and muted runs are whole on screen.
      await page.setViewportSize({ width: 1280, height: 1200 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.goto("/");
      await hydrated(page);
      await page.getByRole("button", { name: "Refresh status now" }).first().click();
      // The most urgent card's "since" line sits at the brightest corner of a panel.
      await expect(page.locator("#service-aws").getByText("Outage", { exact: true }).first()).toBeVisible();
      await page.waitForTimeout(500);
      const setup = await page.evaluate(() => {
        const channels = (token: string) => {
          const probe = document.createElement("i");
          probe.style.color = `var(${token})`;
          document.body.appendChild(probe);
          const found = getComputedStyle(probe).color.match(/[\d.]+/g) ?? [];
          probe.remove();
          return found.slice(0, 3).map(Number);
        };
        const colours = { subtle: channels("--color-subtle"), muted: channels("--color-muted") };
        const discs = [...document.querySelectorAll(".lens")].map((lens) => {
          const box = lens.getBoundingClientRect();
          return [box.x + box.width / 2, box.y + box.height / 2, box.width / 2];
        });
        const runs: { kind: "subtle" | "muted"; text: string; x: number; y: number; w: number; h: number }[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const element = node.parentElement;
          const text = node.textContent?.trim();
          if (!element || !text || !element.closest(".surface") || element.closest(".sr-only")) continue;
          // The body of a closed <details> is not drawn, though it still has a box.
          const details = element.closest("details:not([open])");
          if (details && !element.closest("summary")) continue;
          const color =
            getComputedStyle(element)
              .color.match(/[\d.]+/g)
              ?.slice(0, 3)
              .map(Number) ?? [];
          const kind = (["subtle", "muted"] as const).find((name) => colours[name].every((v, i) => v === color[i]));
          if (!kind) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          // Whole in the viewport, so the screenshot has all of it.
          if (box.width < 2 || box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) {
            continue;
          }
          runs.push({ kind, text: text.slice(0, 30), x: box.x, y: box.y, w: box.width, h: box.height });
        }
        return { colours, discs, runs };
      });
      // Not vacuous: both colours are used on panels, among them the urgent card's "since" line.
      expect(setup.runs.some((run) => run.text === "since")).toBe(true);
      expect(setup.runs.filter((run) => run.kind === "subtle").length).toBeGreaterThan(8);
      expect(setup.runs.filter((run) => run.kind === "muted").length).toBeGreaterThan(2);
      await page.addStyleTag({ content: "*{color:transparent !important;text-shadow:none !important}" });
      const shot = await page.screenshot({ animations: "disabled" });

      const helper = await context.newPage();
      try {
        const result = await helper.evaluate(
          async ({ b64, setup }) => {
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
              subtle: luminance(setup.colours.subtle[0], setup.colours.subtle[1], setup.colours.subtle[2]),
              muted: luminance(setup.colours.muted[0], setup.colours.muted[1], setup.colours.muted[2]),
            };
            const worst = { subtle: 99, muted: 99 };
            const failing: string[] = [];
            let measured = 0;
            for (const run of setup.runs) {
              // A run across a lens's rim (its outer 4px either side) is exempt.
              const crossesRim = setup.discs.some(([cx, cy, radius]) => {
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
              if (runWorst < 4.5) failing.push(`${run.kind} "${run.text}" ${runWorst.toFixed(2)}`);
            }
            return { measured, worst, failing };
          },
          { b64: Buffer.from(shot).toString("base64"), setup },
        );
        expect(result.measured).toBeGreaterThan(10);
        expect(result.failing, `worst ratios ${JSON.stringify(result.worst)}`).toEqual([]);
      } finally {
        await helper.close();
      }
    });
  }
});
