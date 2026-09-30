import { expect, type Page, test } from "@playwright/test";

// The liquid-glass lens layer (src/components/status/lens-field.tsx and the
// .lens rules in src/styles.css). The markup and asset tests run against any
// build; the rules that hide, still or place the lenses need the stylesheet,
// so each of those skips itself until the lens CSS is in the build.
//
// Contrast is not tested here on purpose. board.spec.ts's contrastFailures
// strips pseudo-elements and every background-image before it runs axe, so it
// cannot see the lens layer: a lens tints the aurora behind the cards, never
// a card's own fill. What keeps text at AA over the lenses is token
// discipline in the CSS (the lens colours are alpha tokens that stay behind
// the glass materials), and this file only checks that the layer steps aside
// when the user asks for less (Reduce glass, Increase Contrast, reduced
// motion).

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

/** Whether the lens rules are in the stylesheet: the layer is only fixed once they are. */
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
    test.skip(!(await cssLoaded(page)), "needs the lens CSS");
    expect(await lenses(page).evaluate((layer) => getComputedStyle(layer).pointerEvents)).toBe("none");
  });

  test("Reduce glass takes the lenses off the page", async ({ page }) => {
    await page.goto("/");
    await hydrated(page);
    test.skip(!(await cssLoaded(page)), "needs the lens CSS");
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
    test.skip(!(await cssLoaded(page)), "needs the lens CSS");
    const names = await page
      .locator(".lens")
      .evaluateAll((all) => all.map((lens) => getComputedStyle(lens, "::after").animationName));
    expect(names).toEqual(["none", "none", "none", "none"]);
  });

  test("the rim light orbits under a fine pointer and stands still under touch", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await hydrated(page);
    test.skip(!(await cssLoaded(page)), "needs the lens CSS");
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

  test("Increase Contrast hides the lenses and gives the grid back whole", async ({ page }) => {
    await page.emulateMedia({ contrast: "more" });
    await page.goto("/");
    await hydrated(page);
    test.skip(!(await cssLoaded(page)), "needs the lens CSS");
    await expect(lenses(page)).toBeHidden();
    // The grid is holed under each lens; with no lenses there is nothing to hole.
    const mask = await page.locator(".aurora-grid").evaluate((grid) => {
      const style = getComputedStyle(grid);
      return style.maskImage || style.webkitMaskImage || "none";
    });
    expect(mask).toBe("none");
  });
});
