import { expect, type Page, test } from "@playwright/test";

// The liquid-glass lens layer (src/components/status/lens-field.tsx and the
// .lens rules in src/styles.css): its markup and asset, the rules that hide,
// still or place it, and a per-pixel contrast check.
//
// Contrast: board.spec.ts's contrastFailures strips pseudo-elements and every
// background-image before it runs axe, so it cannot see the lens layer. The
// last test here measures it instead: with the content hidden and motion off,
// it screenshots each lens disc and checks --color-subtle and --color-muted
// against every pixel more than 3px inside the rim, in light and dark. The
// budget is 4.5:1 there, grid lines included; only the rim hairline (the outer
// 3px) is exempt. The lens colours are alpha tokens in src/styles.css, so
// this is the test to run whenever one of them changes.

const lenses = (page: Page) => page.locator(".lenses");

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

test.describe("styling", () => {
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

    await page.getByRole("button", { name: "Settings and shortcuts" }).click();
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
});
