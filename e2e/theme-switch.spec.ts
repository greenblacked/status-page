import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { THEME_BOOT_SCRIPT, THEME_COLORS } from "../src/lib/theme.ts";
import { BACKGROUNDS, cards, controlBar, hydrated, SERVICES, TARGET_FLOOR } from "./support/layout";
import { expect, test } from "./test";

// The day/night switch (src/components/status/theme-switch.tsx) and the rule behind it (src/lib/theme.ts): a stored
// choice wins, otherwise the visitor's clock, night from 20:00 to 06:00. These tests are about the choice and the
// clock, so the suite's own pin (e2e/test.ts), which stores the theme of the emulated colour scheme, is off here and
// each test says what is stored and what time it is.
test.use({ pinTheme: false });

const at = (hour: number, minute = 0, second = 0) => new Date(Date.UTC(2026, 9, 5, hour, minute, second));
const THEMES = ["day", "night"] as const;
type Theme = (typeof THEMES)[number];

/** --color-bg of each theme, as the browser computes it. */
const PAGE_COLOR: Record<Theme, string> = { day: "rgb(244, 241, 235)", night: "rgb(0, 0, 0)" };

const heroSwitch = (page: Page) => page.locator("header [data-theme-switch]");
const barSwitch = (page: Page) => controlBar(page).locator("[data-theme-switch]");
const themeOf = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const storedOf = (page: Page) => page.evaluate(() => localStorage.getItem("theme"));
/** The theme-color a browser answers with: the first theme-color meta whose media applies. */
const themeColor = (page: Page) =>
  page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).find(
        (meta) => !meta.media || matchMedia(meta.media).matches,
      )?.content,
  );

/** Stores a theme before the page's first load only: a later load keeps what the page itself has stored since. */
async function seed(page: Page, value: string): Promise<void> {
  await page.addInitScript((stored) => {
    try {
      if (sessionStorage.getItem("seeded") === null) {
        sessionStorage.setItem("seeded", "");
        localStorage.setItem("theme", stored);
      }
    } catch {}
  }, value);
}

/** Opens the board at a time of day (UTC, the suite's zone), with the theme stored or not. */
async function open(page: Page, when: Date, stored?: string): Promise<void> {
  await page.clock.install({ time: when });
  if (stored !== undefined) await seed(page, stored);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
}

/** What the page reported to the console as a problem. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

test.describe("the rule, on a page that has loaded", () => {
  test("is night at 21:00 and day at 10:00 with nothing stored", async ({ page }) => {
    await open(page, at(21));
    expect(await themeOf(page)).toBe("night");
    await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "true");
    expect(await storedOf(page), "reading the clock stores nothing").toBeNull();
    await page.clock.setSystemTime(at(10));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => themeOf(page)).toBe("day");
    await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "false");
  });

  for (const [hour, minute, second, expected] of [
    [5, 59, 0, "night"],
    [6, 0, 0, "day"],
    [19, 59, 0, "day"],
    [20, 0, 0, "night"],
    [0, 0, 0, "night"],
    [12, 0, 0, "day"],
  ] as const) {
    test(`opens in ${expected} at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`, async ({
      page,
    }) => {
      await open(page, at(hour, minute, second));
      expect(await themeOf(page)).toBe(expected);
      await expect(heroSwitch(page)).toHaveAttribute("aria-checked", expected === "night" ? "true" : "false");
    });
  }

  test("crosses 20:00 and 06:00 with the page open, within a minute", async ({ page }) => {
    await open(page, at(19, 59, 30));
    expect(await themeOf(page)).toBe("day");
    await page.clock.runFor(61_000);
    await expect.poll(() => themeOf(page)).toBe("night");
    await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "true");
    expect(await themeColor(page)).toBe(THEME_COLORS.night);

    await page.clock.setSystemTime(at(5, 59, 30));
    await page.clock.runFor(61_000);
    await expect.poll(() => themeOf(page)).toBe("day");
    expect(await themeColor(page)).toBe(THEME_COLORS.day);
  });

  test("re-reads when the tab becomes visible again", async ({ page }) => {
    await open(page, at(12));
    expect(await themeOf(page)).toBe("day");
    await page.clock.setSystemTime(at(20, 5));
    // The interval has not fired: only the tab coming back can have moved it.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => themeOf(page)).toBe("night");
  });

  test("lets a stored choice win over the clock, and treats anything else stored as no choice", async ({ page }) => {
    await open(page, at(23), "day");
    expect(await themeOf(page)).toBe("day");
    await page.clock.runFor(61_000);
    expect(await themeOf(page), "the clock does not undo a stored choice").toBe("day");

    const other = await page.context().newPage();
    await other.clock.install({ time: at(12) });
    await seed(other, "night");
    await other.goto("/");
    expect(await themeOf(other)).toBe("night");
    await other.close();

    const junk = await page.context().newPage();
    await junk.clock.install({ time: at(22) });
    await junk.goto("/healthz");
    await junk.evaluate(() => localStorage.setItem("theme", "dusk"));
    await junk.goto("/");
    expect(await themeOf(junk), "junk stored, 22:00").toBe("night");
    await junk.evaluate(() => localStorage.setItem("theme", "Day"));
    await junk.reload();
    expect(await themeOf(junk), "a wrong-case value is junk too").toBe("night");
    await junk.close();
  });

  test("follows a choice made in another tab, without a reload", async ({ page }) => {
    await open(page, at(10));
    expect(await themeOf(page)).toBe("day");
    const other = await page.context().newPage();
    await other.goto("/healthz");
    await other.evaluate(() => localStorage.setItem("theme", "night"));
    await expect.poll(() => themeOf(page)).toBe("night");
    await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "true");
    expect(await themeColor(page)).toBe(THEME_COLORS.night);
    await other.evaluate(() => localStorage.clear());
    await expect.poll(() => themeOf(page), "cleared: the clock (10:00) decides again").toBe("day");
    await other.close();
  });

  test("falls back to the clock when storage cannot be read, and holds a press for the visit", async ({ page }) => {
    const problems = watchConsole(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
    });
    await open(page, at(22));
    expect(await themeOf(page)).toBe("night");
    await heroSwitch(page).click();
    expect(await themeOf(page)).toBe("day");
    await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "false");
    await page.clock.runFor(61_000);
    expect(await themeOf(page), "the next re-read does not undo the press").toBe("day");
    expect(problems).toEqual([]);
  });
});

test.describe("before the first paint", () => {
  for (const [name, hour, stored, expected] of [
    ["the clock at night", 22, undefined, "night"],
    ["the clock by day", 11, undefined, "day"],
    ["a stored night by day", 11, "night", "night"],
    ["a stored day at night", 22, "day", "day"],
  ] as const) {
    test(`sets data-theme from ${name} before any script bundle has run`, async ({ page }) => {
      await page.route(/\.js(\?.*)?$/, (route) => route.abort());
      await page.clock.install({ time: at(hour) });
      if (stored !== undefined) await seed(page, stored);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      // No wait: the attribute is there at DOMContentLoaded, written by the inline script, with nothing hydrated.
      expect(await themeOf(page)).toBe(expected);
      await expect(page.locator("html")).not.toHaveAttribute("data-hydrated", "");
      expect(await themeColor(page)).toBe(THEME_COLORS[expected]);
      const drawn = await page.evaluate(() => ({
        scheme: getComputedStyle(document.documentElement).colorScheme,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      expect(drawn).toEqual({ scheme: expected === "night" ? "dark" : "light", background: PAGE_COLOR[expected] });
    });
  }

  for (const [name, hour, stored, expected] of [
    ["the clock at night", 22, undefined, "true"],
    ["the clock by day", 11, undefined, "false"],
    ["a stored night by day", 11, "night", "true"],
    ["a stored day at night", 22, "day", "false"],
  ] as const) {
    test(`says ${name} in aria-checked on both switches before any script bundle has run`, async ({ page }) => {
      await page.route(/\.js(\?.*)?$/, (route) => route.abort());
      await page.clock.install({ time: at(hour) });
      if (stored !== undefined) await seed(page, stored);
      const problems = watchConsole(page);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      // Nothing hydrated: the server drew every switch as off, and the small script after each has set the real one.
      await expect(page.locator("html")).not.toHaveAttribute("data-hydrated", "");
      const states = await page.evaluate(() =>
        [...document.querySelectorAll("[data-theme-switch]")].map((element) => element.getAttribute("aria-checked")),
      );
      expect(states).toEqual([expected, expected]);
      expect(
        problems.filter((problem) => /content security policy|refused to execute/i.test(problem)),
        "the script runs under the page's nonce",
      ).toEqual([]);
    });
  }

  test("changes data-theme once, never from the other theme to this one while the page loads", async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __themes: string[] }).__themes = seen;
      // Watching the document, not <html>, which may not exist yet when an init script runs.
      new MutationObserver(() => seen.push(document.documentElement.getAttribute("data-theme") ?? "none")).observe(
        document,
        { attributes: true, attributeFilter: ["data-theme"], subtree: true },
      );
    });
    const problems = watchConsole(page);
    await open(page, at(22));
    await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "true");
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => (window as unknown as { __themes: string[] }).__themes)).toEqual(["night"]);
    expect(problems, "no hydration warning or error").toEqual([]);
    // Hydration kept what the server rendered (the light and the dark theme-color) and the script's own, ahead of them.
    expect(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('meta[name="theme-color"]'), (meta) => [
          meta.getAttribute("media"),
          meta.hasAttribute("data-theme-color"),
        ]),
      ),
    ).toEqual([
      [null, true],
      ["(prefers-color-scheme: light)", false],
      ["(prefers-color-scheme: dark)", false],
    ]);
  });

  test("runs the boot script once, under the policy's nonce", async ({ page, request }) => {
    const response = await request.get("/");
    const nonce = /'nonce-([^']+)'/.exec(response.headers()["content-security-policy"] ?? "")?.[1];
    expect(nonce).toBeTruthy();
    const tags = (await response.text()).match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    const boot = tags.filter((tag) => tag.includes('setAttribute("data-theme"'));
    expect(boot).toHaveLength(1);
    expect(boot[0]).toContain(`nonce="${nonce}"`);
    expect(boot[0]).toContain(THEME_BOOT_SCRIPT);
    await page.goto("/");
    await hydrated(page);
    const copies = await page.evaluate(
      (script) =>
        [...document.head.querySelectorAll("script:not([src])")].filter((el) => el.textContent === script).length,
      THEME_BOOT_SCRIPT,
    );
    expect(copies).toBe(1);
  });
});

test.describe("the switch", () => {
  test("is a real button with role=switch, a name and aria-checked for night", async ({ page }) => {
    await open(page, at(10));
    const toggle = heroSwitch(page);
    expect(await toggle.evaluate((element) => element.tagName)).toBe("BUTTON");
    await expect(toggle).toHaveAttribute("role", "switch");
    await expect(toggle).toHaveAttribute("aria-label", "Dark theme");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("switch", { name: "Dark theme" })).toHaveCount(1);
  });

  test("flips the theme, aria-checked and theme-color, stores the choice, and keeps it across a reload", async ({
    page,
  }) => {
    await open(page, at(10));
    const toggle = heroSwitch(page);
    expect(await themeOf(page)).toBe("day");
    expect(await themeColor(page)).toBe(THEME_COLORS.day);
    expect(await storedOf(page)).toBeNull();

    await toggle.click();
    expect(await themeOf(page)).toBe("night");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await themeColor(page)).toBe(THEME_COLORS.night);
    expect(await storedOf(page)).toBe("night");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(PAGE_COLOR.night);

    // 10:00 by the clock, night by the choice.
    await page.reload();
    expect(await themeOf(page)).toBe("night");
    await hydrated(page);
    await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "true");

    await heroSwitch(page).click();
    expect(await themeOf(page)).toBe("day");
    await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "false");
    expect(await storedOf(page)).toBe("day");
    expect(await themeColor(page)).toBe(THEME_COLORS.day);
    await page.reload();
    expect(await themeOf(page)).toBe("day");
  });

  test("works from the keyboard, with the board's focus ring", async ({ page }) => {
    await open(page, at(10));
    const toggle = heroSwitch(page);
    // Tab to it: the first stops of the page are the skip link and the controls ahead of it.
    for (
      let presses = 0;
      presses < 8 && !(await toggle.evaluate((element) => element === document.activeElement));
      presses++
    )
      await page.keyboard.press("Tab");
    await expect(toggle).toBeFocused();
    const ring = await toggle.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth, matches: element.matches(":focus-visible") };
    });
    expect(ring).toEqual({ style: "solid", width: "2px", matches: true });
    const accent = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--color-accent)";
      document.documentElement.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(await toggle.evaluate((element) => getComputedStyle(element).outlineColor)).toBe(accent);
    // The ring is clear of the track on every side, so at night, when the track's edge is the accent too, it is not
    // read as a thicker border. Measured from the ring's inner edge (the button's box moved out by the offset).
    const gaps = () =>
      toggle.evaluate((element) => {
        const offset = Number.parseFloat(getComputedStyle(element).outlineOffset);
        const outer = element.getBoundingClientRect();
        const track = (element.querySelector(".theme-track") as HTMLElement).getBoundingClientRect();
        return {
          offset,
          left: track.left - (outer.left - offset),
          right: outer.right + offset - track.right,
          top: track.top - (outer.top - offset),
          bottom: outer.bottom + offset - track.bottom,
        };
      });
    for (const side of Object.values(await gaps())) expect(side).toBeGreaterThanOrEqual(2);

    await page.keyboard.press("Space");
    await expect.poll(() => themeOf(page)).toBe("night");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    for (const side of Object.values(await gaps())) expect(side, "the ring at night").toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Enter");
    await expect.poll(() => themeOf(page)).toBe("day");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("is drawn as a Material switch: 52 by 32 track, 24px knob that slides 20px", async ({ page }) => {
    await open(page, at(10));
    // Reduce Motion: the knob is at its end the moment the theme changes, so the boxes below are the resting ones.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const boxes = () =>
      heroSwitch(page).evaluate((button) => {
        const rect = (selector: string) => {
          const box = (button.querySelector(selector) as HTMLElement).getBoundingClientRect();
          return { left: box.left, top: box.top, width: box.width, height: box.height };
        };
        const outer = button.getBoundingClientRect();
        return {
          button: { width: outer.width, height: outer.height },
          track: rect(".theme-track"),
          knob: rect(".theme-knob"),
          sun: getComputedStyle(button.querySelector(".theme-sun") as Element).display,
          moon: getComputedStyle(button.querySelector(".theme-moon") as Element).display,
        };
      });
    const day = await boxes();
    expect(day.button.width).toBeGreaterThanOrEqual(TARGET_FLOOR);
    expect(day.button.height).toBeGreaterThanOrEqual(TARGET_FLOOR);
    expect(day.track).toMatchObject({ width: 52, height: 32 });
    expect(day.knob).toMatchObject({ width: 24, height: 24 });
    expect([day.sun, day.moon]).toEqual(["block", "none"]);
    await heroSwitch(page).click();
    const night = await boxes();
    expect([night.sun, night.moon]).toEqual(["none", "block"]);
    expect(night.knob.left - day.knob.left).toBeCloseTo(20, 1);
    expect(night.knob.top).toBeCloseTo(day.knob.top, 1);
    expect(night.track).toEqual(day.track);
    // The knob is inside the track at both ends, with the same gap.
    expect(day.knob.left - day.track.left).toBeCloseTo(
      night.track.left + night.track.width - (night.knob.left + night.knob.width),
      1,
    );
  });

  test("slides over 300ms with the Material curve, and not at all under Reduce Motion", async ({ page }) => {
    await open(page, at(10));
    const timing = () =>
      heroSwitch(page).evaluate((button) => {
        const knob = getComputedStyle(button.querySelector(".theme-knob") as Element);
        const track = getComputedStyle(button.querySelector(".theme-track") as Element);
        return {
          knob: [knob.transitionProperty, knob.transitionDuration, knob.transitionTimingFunction],
          track: [track.transitionProperty, track.transitionDuration, track.transitionTimingFunction],
        };
      });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const moving = await timing();
    expect(moving.knob[0]).toContain("transform");
    expect(moving.knob[1]).toContain("0.3s");
    expect(moving.knob[2]).toContain("cubic-bezier(0.2, 0, 0, 1)");
    expect(moving.track[0]).toContain("background-color");
    expect(moving.track[1]).toContain("0.3s");
    expect(moving.track[2]).toContain("cubic-bezier(0.2, 0, 0, 1)");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const still = await timing();
    expect(still.knob[1]).toBe("0s");
    expect(still.track[1]).toBe("0s");
  });

  test("is in the floating bar too, from 640px, and the two always agree", async ({ page }) => {
    await open(page, at(10));
    const wide = await page.evaluate(() => matchMedia("(min-width: 40rem)").matches);
    // The bar's copy is drawn on a screen from 40rem; below it the bar keeps its room for the verdict.
    await expect(barSwitch(page)).toHaveCount(1);
    expect(await barSwitch(page).evaluate((element) => getComputedStyle(element).display !== "none")).toBe(wide);
    await heroSwitch(page).click();
    await expect(barSwitch(page)).toHaveAttribute("aria-checked", "true");
    if (wide) {
      await page.evaluate(() => window.scrollTo(0, 1200));
      await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
      await barSwitch(page).click();
      await expect(barSwitch(page)).toHaveAttribute("aria-checked", "false");
      expect(await themeOf(page)).toBe("day");
      await expect(heroSwitch(page)).toHaveAttribute("aria-checked", "false");
    }
  });
});

test.describe("the stored theme, not the system, decides", () => {
  for (const [system, stored] of [
    ["dark", "day"],
    ["light", "night"],
  ] as const) {
    test(`draws ${stored} on a system set to ${system}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: system });
      await open(page, at(stored === "day" ? 23 : 12), stored);
      expect(await themeOf(page)).toBe(stored);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(PAGE_COLOR[stored]);
      const results = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
      expect(results.violations.map((violation) => violation.nodes.map((node) => node.target.join(" ")))).toEqual([]);
    });
  }

  test("follows the system when scripts are off: no data-theme, light or dark as the system says", async ({
    browser,
    baseURL,
  }) => {
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ baseURL, javaScriptEnabled: false, colorScheme: scheme });
      try {
        const page = await context.newPage();
        await page.goto("/");
        expect(await themeOf(page)).toBeNull();
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
          PAGE_COLOR[scheme === "dark" ? "night" : "day"],
        );
        // The switch draws the system's side too, so it never shows the wrong one.
        const icons = await heroSwitch(page).evaluate((button) => ({
          sun: getComputedStyle(button.querySelector(".theme-sun") as Element).display,
          moon: getComputedStyle(button.querySelector(".theme-moon") as Element).display,
        }));
        expect(icons).toEqual(scheme === "dark" ? { sun: "none", moon: "block" } : { sun: "block", moon: "none" });
      } finally {
        await context.close();
      }
    }
  });
});

/** The relative luminance of an sRGB colour, 0 to 1. */
const contrastScript = `
  const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const parse = (css) => { const m = /rgba?\\(([^)]+)\\)/.exec(css); if (!m) throw new Error("not rgb: " + css); return m[1].split(/[ ,/]+/).slice(0, 3).map(Number); };
`;

type Contrasts = { edgeAgainstPage: number; knobAgainstTrack: number; iconAgainstKnob: number };

/** The 3:1 a control's parts need (WCAG 1.4.11): the track's edge against what is behind it, the knob against the track, the icon against the knob. */
async function contrastsOf(page: Page, toggle: Locator): Promise<Contrasts> {
  // Behind the switch is the page, and on Glass and Full the aurora over it: the worst pixel of that backdrop counts.
  await toggle.evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  const box = (await toggle.boundingBox()) as { x: number; y: number; width: number; height: number };
  const png = Buffer.from(
    await page.screenshot({
      clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 },
      animations: "disabled",
    }),
  ).toString("base64");
  await toggle.evaluate((element) => {
    (element as HTMLElement).style.visibility = "";
  });
  return page.evaluate(
    async ({ script, image }) => {
      const helpers = new Function(`${script}; return { ratio, parse };`)() as {
        ratio: (a: number[], b: number[]) => number;
        parse: (css: string) => number[];
      };
      const picture = new Image();
      picture.src = `data:image/png;base64,${image}`;
      await picture.decode();
      const canvas = document.createElement("canvas");
      canvas.width = picture.width;
      canvas.height = picture.height;
      const context = canvas.getContext("2d") as CanvasRenderingContext2D;
      context.drawImage(picture, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const button = document.querySelector("header [data-theme-switch]") as HTMLElement;
      const style = (selector: string) => getComputedStyle(button.querySelector(selector) as Element);
      const edge = helpers.parse(style(".theme-track").borderTopColor);
      const fill = helpers.parse(style(".theme-track").backgroundColor);
      const knob = helpers.parse(style(".theme-knob").backgroundColor);
      const icon = helpers.parse(style(".theme-knob").color);
      let worst = Number.POSITIVE_INFINITY;
      for (let at = 0; at < pixels.length; at += 4) {
        worst = Math.min(
          worst,
          helpers.ratio(edge, [pixels[at] as number, pixels[at + 1] as number, pixels[at + 2] as number]),
        );
      }
      return {
        edgeAgainstPage: worst,
        knobAgainstTrack: helpers.ratio(knob, fill),
        iconAgainstKnob: helpers.ratio(icon, knob),
      };
    },
    { script: contrastScript, image: png },
  );
}

test.describe("non-text contrast", () => {
  for (const background of BACKGROUNDS) {
    for (const theme of THEMES) {
      test(`keeps the switch at 3:1 on ${background}, ${theme}`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem("status-bar:background", value), background);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, at(12), theme);
        if (background !== "quiet") await expect(page.locator("html")).toHaveAttribute("data-background", background);
        await page.evaluate(() => window.scrollTo(0, 0));
        const found = await contrastsOf(page, heroSwitch(page));
        expect(found.edgeAgainstPage, "the track's edge against the page behind it").toBeGreaterThanOrEqual(3);
        expect(found.knobAgainstTrack, "the knob against the track").toBeGreaterThanOrEqual(3);
        expect(found.iconAgainstKnob, "the icon against the knob").toBeGreaterThanOrEqual(3);
      });
    }
  }
});

test.describe("every background", () => {
  for (const background of BACKGROUNDS) {
    test(`flips the theme on ${background} and every part of the page follows`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("status-bar:background", value), background);
      await open(page, at(10));
      if (background !== "quiet") await expect(page.locator("html")).toHaveAttribute("data-background", background);
      const paint = () =>
        page.evaluate(() => {
          const read = (element: Element) => {
            const style = getComputedStyle(element);
            return [style.backgroundColor, style.color];
          };
          return {
            scheme: getComputedStyle(document.documentElement).colorScheme,
            page: read(document.body),
            card: read(document.querySelector('article[id^="service-"]') as Element),
          };
        });
      const day = await paint();
      expect(day.scheme).toBe("light");
      await heroSwitch(page).click();
      const night = await paint();
      expect(night.scheme).toBe("dark");
      expect(night.page).not.toEqual(day.page);
      expect(night.card).not.toEqual(day.card);
      await heroSwitch(page).click();
      expect(await paint()).toEqual(day);
    });
  }
});

test.describe("on any screen", () => {
  for (const [width, height] of [
    [320, 568],
    [360, 640],
    [390, 844],
    [640, 900],
    [768, 1024],
    [1024, 768],
    [1280, 800],
  ] as const) {
    test(`fits ${width}px: no overflow, a 44px target, and clear of its neighbours`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, at(10));
      const read = () =>
        page.evaluate(() => {
          const toggle = document.querySelector("header [data-theme-switch]") as HTMLElement;
          const box = toggle.getBoundingClientRect();
          const header = (toggle.closest("header") as HTMLElement).getBoundingClientRect();
          const neighbours = [...document.querySelectorAll("header button:not([data-theme-switch]), header p")]
            .map((element) => ({
              name: element.getAttribute("aria-label") ?? element.textContent?.slice(0, 20),
              box: element.getBoundingClientRect(),
            }))
            .filter((item) => item.box.width > 1 && item.box.height > 1);
          const overlaps = neighbours
            .filter(
              ({ box: other }) =>
                Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 &&
                Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1,
            )
            .map((item) => item.name);
          return {
            scrollWidth: document.documentElement.scrollWidth,
            left: box.left,
            right: box.right,
            width: box.width,
            height: box.height,
            insideHeader: box.left >= header.left - 0.5 && box.right <= header.right + 0.5,
            overlaps,
          };
        });
      for (const theme of THEMES) {
        if ((await themeOf(page)) !== theme) await heroSwitch(page).click();
        const found = await read();
        expect(found.scrollWidth, `${theme}: sideways scroll`).toBeLessThanOrEqual(width);
        expect(found.left, `${theme}: left edge`).toBeGreaterThanOrEqual(0);
        expect(found.right, `${theme}: right edge`).toBeLessThanOrEqual(width);
        expect(found.width).toBeGreaterThanOrEqual(TARGET_FLOOR);
        expect(found.height).toBeGreaterThanOrEqual(TARGET_FLOOR);
        expect(found.insideHeader).toBe(true);
        expect(found.overlaps, `${theme}: overlaps`).toEqual([]);
      }
    });
  }

  // The dateline is the server's real date, so the layout must hold for the longest it can be, not the day the suite runs.
  for (const [width, height] of [
    [320, 568],
    [360, 640],
  ] as const) {
    for (const text of ["Wednesday 30 September", "Saturday 13 December", "Thursday 24 September"]) {
      test(`keeps the hero's row and the verdict where they were with "${text}" at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await open(page, at(10));
        await page.evaluate((value) => {
          const time = document.querySelector("header time");
          if (time) time.textContent = value;
        }, text);
        const measure = () =>
          page.evaluate(() => {
            const top = (selector: string) =>
              document.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN;
            const time = document.querySelector("header time")?.getBoundingClientRect();
            const refresh = document
              .querySelector('header button[aria-label="Refresh status now"]')
              ?.getBoundingClientRect();
            return {
              verdictTop: top("#board-headline"),
              refreshTop: refresh?.top ?? Number.NaN,
              refreshRight: refresh?.right ?? Number.NaN,
              // The dateline and the controls are one row when the dateline's box reaches into the buttons' height.
              sharesRow: !!time && !!refresh && time.top < refresh.bottom && time.bottom > refresh.top,
              scrollWidth: document.documentElement.scrollWidth,
            };
          });
        const withSwitch = await measure();
        await page.addStyleTag({ content: "[data-theme-switch] { display: none !important; }" });
        const without = await measure();
        expect(withSwitch.sharesRow, "the dateline and the controls are on one row").toBe(true);
        expect(withSwitch.refreshTop, "the controls did not wrap to a second row").toBe(without.refreshTop);
        expect(withSwitch.verdictTop, "the switch did not move the verdict").toBe(without.verdictTop);
        expect(withSwitch.refreshRight).toBeLessThanOrEqual(width);
        expect(withSwitch.scrollWidth).toBeLessThanOrEqual(width);
      });
    }
  }

  // Larger text makes the dateline the squeezed part of the row: it must never be cut below its longest word (the base
  // `overflow-wrap: break-word` would then split words letter by letter, a column of single letters); the controls wrap
  // under it instead. Each word has one client rect when it sits whole on a line.
  for (const rootPx of [24, 32]) {
    for (const width of [320, 360]) {
      for (const text of ["Wednesday 30 September", "Monday 1 May"]) {
        test(`never breaks a dateline word at ${rootPx}px root text: "${text}" at ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 800 });
          await open(page, at(10));
          await page.addStyleTag({ content: `html { font-size: ${rootPx}px !important; }` });
          await page.evaluate((value) => {
            const time = document.querySelector("header time");
            if (time) time.textContent = value;
          }, text);
          const found = await page.evaluate(() => {
            const time = document.querySelector("header time") as HTMLElement;
            const node = time.firstChild as Text;
            const words: { word: string; pieces: number }[] = [];
            for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
              const range = document.createRange();
              range.setStart(node, match.index ?? 0);
              range.setEnd(node, (match.index ?? 0) + match[0].length);
              // A word split across lines has a client rect on each.
              words.push({ word: match[0], pieces: range.getClientRects().length });
            }
            return {
              words,
              scrollWidth: document.documentElement.scrollWidth,
            };
          });
          for (const { word, pieces } of found.words) expect(pieces, `"${word}" is on one line`).toBe(1);
          expect(found.scrollWidth, "sideways scroll").toBeLessThanOrEqual(width);
        });
      }
    }
  }

  test("is reachable by Tab on a phone with the bar up, and the bar's copy takes over from 640px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, at(10));
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
    // The bar draws no switch below 640px, so the hero's must stay in the Tab order.
    await expect(heroSwitch(page)).not.toHaveAttribute("tabindex", "-1");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    let reached = false;
    for (let press = 0; press < 40 && !reached; press++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.hasAttribute("data-theme-switch") === true);
    }
    expect(reached, "Tab reaches a day/night switch").toBe(true);
    await expect(page.locator(":focus")).toBeVisible();
    await page.keyboard.press("Space");
    await expect.poll(() => themeOf(page)).toBe("night");

    await page.setViewportSize({ width: 800, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 1500));
    await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
    await expect(heroSwitch(page)).toHaveAttribute("tabindex", "-1");
    await expect(barSwitch(page)).not.toHaveAttribute("tabindex", "-1");
    await expect(barSwitch(page)).toBeVisible();
  });

  test("leaves the verdict where it was at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await open(page, at(10));
    const verdict = page.locator("#board-headline");
    const before = await verdict.boundingBox();
    await heroSwitch(page).click();
    const after = await verdict.boundingBox();
    expect(after).toEqual(before);
    // The bar keeps its whole width for the verdict on a phone: the switch is not in it.
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect(controlBar(page)).toHaveAttribute("data-shown", "true");
    await expect(barSwitch(page)).toBeHidden();
  });
});
