import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { GLINT_QUERY, LIGHT_SIGN, TILT_STORAGE_KEY } from "../src/lib/status/tilt.ts";

// Tilt lighting reads the device's motion sensors, which a test browser does
// not have. These tests stand in for them: they dispatch synthetic
// `deviceorientation` events, and (as iOS does) put a requestPermission on
// DeviceOrientationEvent that counts its calls and answers as told. The
// browser's own readings (a null one, without a sensor) are shut out. Where
// the engine has no DeviceOrientationEvent at all (Playwright's WebKit on
// Linux is built without it), the stub supplies an empty one, so the touch
// tests run there too; the no-switch test for non-touch devices never uses it.

const SERVICES = 20;

// The light only draws on the Glass and Full backgrounds, and the default is Quiet, so every test here
// starts on Glass, the way a visitor who chose it would. One test starts on Quiet.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("status-bar:background", "glass");
    } catch {
      // Storage can refuse; the page then stays Quiet and the tests say so.
    }
  });
});
const cards = (page: Page) => page.locator('article[id^="service-"]');
const html = (page: Page) => page.locator("html");

/** Waits until React has hydrated the page: the switch handlers are attached only then. */
async function hydrated(page: Page): Promise<void> {
  await expect(html(page)).toHaveAttribute("data-hydrated", "");
}

/** Console errors, warnings (React reports hydration mismatches as either) and uncaught exceptions. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    // WebKit's resource-timing notice when hydration starts late on a loaded runner, not an app error.
    if (message.text().includes("was preloaded using link preload but not used within a few seconds")) return;
    problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
  return problems;
}

/**
 * Puts iOS's permission prompt in place, before any page script runs, and
 * answers as it does. A call made inside a tap gets `answer` (and, if that is
 * "granted", is remembered for the session, as Safari does until it is closed).
 * A call made outside a tap never prompts: it resolves "granted" if the session
 * remembers a grant, and rejects with NotAllowedError otherwise. Only calls
 * made in a tap are counted. "absent" leaves requestPermission out altogether,
 * as Android and older iOS have it.
 *
 * It also pins screen.orientation.angle, 0 unless a test says otherwise. An
 * iPhone or iPad held upright reports 0, but Playwright's WebKit on Linux
 * reports 90 for the same emulation (the host screen is landscape), which turns
 * an upright tilt into a sideways light and would make every test wait for the
 * wrong axis.
 */
async function stubMotionPermission(
  page: Page,
  answer: "granted" | "denied" | "throws" | "absent" = "granted",
  angle = 0,
): Promise<void> {
  await page.addInitScript(
    ([answer, angle]) => {
      const w = window as unknown as { __permCalls: number; __gesture: boolean };
      w.__permCalls = 0;
      w.__gesture = false;
      if (typeof DeviceOrientationEvent === "undefined") {
        (window as unknown as { DeviceOrientationEvent: unknown }).DeviceOrientationEvent =
          class DeviceOrientationEvent extends Event {};
      }
      // Pinned on the prototypes, not on the screen.orientation object: WebKit may drop an
      // unreferenced wrapper and hand back a fresh one, and a property set on it goes with it.
      if (typeof ScreenOrientation !== "undefined") {
        Object.defineProperty(ScreenOrientation.prototype, "angle", { get: () => angle, configurable: true });
      }
      if (typeof Screen !== "undefined") {
        // One fixed object for the page, for any engine whose own angle the getter above does not reach.
        const orientation = {
          angle,
          type: angle % 180 === 0 ? "portrait-primary" : "landscape-primary",
          addEventListener() {},
          removeEventListener() {},
        };
        Object.defineProperty(Screen.prototype, "orientation", { get: () => orientation, configurable: true });
      } else if (!screen.orientation) {
        Object.defineProperty(screen, "orientation", { value: { angle }, configurable: true });
      }
      Object.defineProperty(window, "orientation", { get: () => angle, configurable: true });
      // A browser with no sensor fires one empty reading of its own as soon as
      // something listens. Only the tests' readings should count.
      window.addEventListener(
        "deviceorientation",
        (event) => event.isTrusted && event.stopImmediatePropagation(),
        true,
      );
      // The click handlers run inside this event's dispatch, so a flag up for one task marks "in a tap".
      document.addEventListener(
        "click",
        () => {
          w.__gesture = true;
          setTimeout(() => {
            w.__gesture = false;
          }, 0);
        },
        true,
      );
      if (answer === "absent") {
        Reflect.deleteProperty(DeviceOrientationEvent, "requestPermission");
        return;
      }
      Object.defineProperty(DeviceOrientationEvent, "requestPermission", {
        value: async () => {
          if (!w.__gesture) {
            if (sessionStorage.getItem("__tiltGranted") === "1") return "granted";
            throw new DOMException("A tap is needed to ask for motion access.", "NotAllowedError");
          }
          w.__permCalls++;
          if (answer === "throws") throw new Error("refused");
          if (answer === "granted") sessionStorage.setItem("__tiltGranted", "1");
          return answer;
        },
        configurable: true,
      });
    },
    [answer, angle] as const,
  );
}

/**
 * The page sees the angle the stub pinned, from both sources. A stub that does
 * not apply in some engine fails here at once, not after a ten second wait for
 * a light that moves along the wrong axis.
 */
async function angleIs(page: Page, angle: number): Promise<void> {
  const seen = await page.evaluate(() => ({
    angle: window.screen.orientation ? window.screen.orientation.angle : "none",
    legacy: (window as unknown as { orientation?: number }).orientation,
  }));
  expect(seen, "screen.orientation.angle and window.orientation as the page sees them").toEqual({
    angle,
    legacy: angle,
  });
}

const permissionCalls = (page: Page) => page.evaluate(() => (window as unknown as { __permCalls: number }).__permCalls);

/**
 * A device that keeps reporting, as iOS does: the same reading every 30 ms from
 * the start of each page load. It queues ahead of any wait for a first reading,
 * so a slow browser cannot make the page think none is coming.
 */
async function pumpReadings(page: Page, beta: number, gamma: number, startAfterMs = 0): Promise<void> {
  await page.addInitScript(
    ([beta, gamma, startAfterMs]) => {
      setTimeout(() => {
        setInterval(() => {
          const event = new Event("deviceorientation");
          for (const [key, value] of Object.entries({ alpha: 0, beta, gamma, absolute: false })) {
            Object.defineProperty(event, key, { value });
          }
          window.dispatchEvent(event);
        }, 30);
      }, startAfterMs);
    },
    [beta, gamma, startAfterMs],
  );
}

/** One synthetic reading from the motion sensor; a null angle is what a device without one reports. */
async function tilt(page: Page, beta: number | null, gamma: number | null): Promise<void> {
  await page.evaluate(
    ([beta, gamma]) => {
      const event = new Event("deviceorientation");
      for (const [key, value] of Object.entries({ alpha: 0, beta, gamma, absolute: false })) {
        Object.defineProperty(event, key, { value });
      }
      window.dispatchEvent(event);
    },
    [beta, gamma],
  );
}

/**
 * The light position the page was given, -1..1 as text, empty while the light is not being driven. It is
 * handed over in one of two ways (src/components/status/tilt-light-sink.ts), and this reads either:
 * paused animations on the panels' pseudo-elements whose time is the position (the preferred one;
 * the value of a panel that is on screen), or --light-x and --light-y inline on the board's <main>.
 * It is the hook's doing and reads the same in every engine; whether the pseudo-elements then draw it
 * is paintedLight.
 */
const lightVar = (page: Page, name: "--light-x" | "--light-y") =>
  page.evaluate((name) => {
    const scope = document.getElementById("services");
    if (!scope) return "no board";
    const inline = scope.style.getPropertyValue(name).trim();
    if (inline !== "") return inline;
    const id = name === "--light-x" ? "tilt-light-x" : "tilt-light-y";
    const mine = scope.getAnimations({ subtree: true }).filter((animation) => animation.id === id);
    const near = (animation: Animation) => {
      const target = animation.effect && (animation.effect as KeyframeEffect).target;
      const rect = target?.getBoundingClientRect();
      return rect ? rect.bottom > -120 && rect.top < window.innerHeight + 120 : false;
    };
    const chosen = mine.find(near) ?? mine[0];
    if (!chosen || chosen.currentTime === null) return "";
    return (Number(chosen.currentTime) / 1000 - 1).toFixed(3);
  }, name);

/**
 * What the first card's pseudo-elements draw: the sheen's and the glint's transform as the browser
 * computes them. The gradients themselves never change; the layers slide by var(--light-x) and
 * var(--light-y), so the strings change when the value reaches them and not otherwise. WebKit once
 * reported the value on the pseudo-element yet drew as if it were unset.
 */
const paintedLight = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector(".surface");
    if (!card) return { sheen: "no card", glint: "no card" };
    return {
      sheen: getComputedStyle(card, "::before").transform,
      glint: getComputedStyle(card, "::after").transform,
    };
  });

/**
 * Where a panel's glint is drawn, in px from its resting place, as the browser computes it: the transform
 * and the individual `translate` property added together (the light reaches it through either, by path),
 * with the panel's size. At light (x, y) the glint is at (x, y) times 0.38 of the width and the height.
 */
const glintShift = (page: Page, selector = ".surface") =>
  page.evaluate((selector) => {
    const card = document.querySelector<HTMLElement>(selector);
    if (!card) return { x: 0, y: 0, w: 0, h: 0 };
    const style = getComputedStyle(card, "::after");
    const matrix = style.transform === "none" ? new DOMMatrix() : new DOMMatrix(style.transform);
    const shift = style.translate === "none" ? [] : style.translate.split(" ");
    return {
      x: matrix.e + Number.parseFloat(shift[0] ?? "0"),
      y: matrix.f + Number.parseFloat(shift[1] ?? "0"),
      w: card.offsetWidth,
      h: card.offsetHeight,
    };
  }, selector);

/** The sheen's and the glint's transform and translate of the panel that matches, whatever its place. */
const paintedOf = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const card = document.querySelector(selector);
    if (!card) return "no panel";
    const parts = [getComputedStyle(card, "::before"), getComputedStyle(card, "::after")];
    return parts.map((style) => `${style.transform} ${style.translate}`).join(" | ");
  }, selector);

const AT_REST = "matrix(1, 0, 0, 1, 0, 0) none | matrix(1, 0, 0, 1, 0, 0) none";

/** Everything about the light in one line, for a log that has to explain a failure in an engine we cannot run. */
const lightReadings = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".surface");
    if (!card) return "no card";
    const before = getComputedStyle(card, "::before");
    const after = getComputedStyle(card, "::after");
    const legacy = (window as unknown as { orientation?: number }).orientation;
    return JSON.stringify({
      tilt: document.documentElement.getAttribute("data-tilt"),
      scopeX: document.getElementById("services")?.style.getPropertyValue("--light-x"),
      scopeY: document.getElementById("services")?.style.getPropertyValue("--light-y"),
      animations: document.getAnimations().filter((animation) => animation.id.startsWith("tilt-light-")).length,
      beforeX: before.getPropertyValue("--light-x"),
      afterY: after.getPropertyValue("--light-y"),
      sheen: before.transform,
      glint: after.transform,
      angle: window.screen.orientation ? window.screen.orientation.angle : "no screen.orientation",
      legacy,
    });
  });

/** How many things still carry the light: inline values and live animations. None when the light is off. */
const lightHolders = (page: Page) =>
  page.evaluate(() => {
    const inline = Array.from(document.querySelectorAll<HTMLElement>("[style]")).filter(
      (element) =>
        element.style.getPropertyValue("--light-x") !== "" || element.style.getPropertyValue("--light-y") !== "",
    ).length;
    const animated = document.getAnimations().filter((animation) => animation.id.startsWith("tilt-light-")).length;
    return inline + animated;
  });

/**
 * Feeds the same reading until the light shows it (the listener attaches a
 * moment after hydration, and the smoothing needs a few frames).
 */
async function tiltUntil(
  page: Page,
  beta: number,
  gamma: number,
  name: "--light-x" | "--light-y",
  reached: (value: number) => boolean,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          await tilt(page, beta, gamma);
          const value = await lightVar(page, name);
          return value !== "" && reached(Number(value));
        },
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBe(true);
  } catch (error) {
    console.log(`[tilt] no ${name} for beta=${beta} gamma=${gamma}: ${await lightReadings(page)}`);
    throw error;
  }
}

/** A reading at rest, which the light takes as neutral, then one upright, which moves it. */
async function tiltFromRest(page: Page): Promise<void> {
  await tiltUntil(page, 0, 0, "--light-y", () => true);
  await tiltUntil(page, 90, 0, "--light-y", (y) => y !== 0);
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

const tiltSwitch = (page: Page) => page.getByRole("switch", { name: "Tilt lighting" });
const storedChoice = (page: Page) => page.evaluate((key) => localStorage.getItem(key), TILT_STORAGE_KEY);

/** The first panel's light-carrying pseudo-elements, as the browser computes them. */
const cardLight = (page: Page) =>
  page
    .locator(".surface")
    .first()
    .evaluate((card) => ({
      sheen: getComputedStyle(card, "::before").backgroundImage,
      sheenMoves: getComputedStyle(card, "::before").transform,
      glint: getComputedStyle(card, "::after").content,
      glintImage: getComputedStyle(card, "::after").backgroundImage,
      glintWidth: getComputedStyle(card, "::after").width,
      glintHeight: getComputedStyle(card, "::after").height,
    }));

test.describe("without touch", () => {
  test.skip(({ hasTouch }) => hasTouch, "the switch is for touch devices");

  test("shows no Tilt lighting switch and leaves the light alone", async ({ page }) => {
    await open(page);
    await openSettings(page);
    await expect(page.getByRole("switch", { name: "Reduce glass" })).toBeVisible();
    await expect(page.getByText("Tilt lighting")).toHaveCount(0);
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    expect(await lightVar(page, "--light-x")).toBe("");
  });
});

test.describe("on a touch device", () => {
  test.skip(({ hasTouch }) => !hasTouch, "needs a touch device");

  test.beforeEach(async ({ page }) => {
    await stubMotionPermission(page);
    await page.goto("/");
    await angleIs(page, 0);
    // Tests seed localStorage on this page before reloading it. A page that has not hydrated yet
    // would read the seed when it does, act on it (forget an "on" it cannot keep) and undo it.
    await hydrated(page);
  });

  test("is off until switched on, and asks for motion access on that tap", async ({ page }) => {
    const problems = watchConsole(page);
    await page.reload();
    await expect(cards(page)).toHaveCount(SERVICES);
    await hydrated(page);
    await openSettings(page);
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    expect(await permissionCalls(page)).toBe(0);
    expect(await cardLight(page)).toMatchObject({ glint: "none" });
    expect((await cardLight(page)).sheen).toContain("125deg");

    await tiltSwitch(page).click();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "true");
    expect(await permissionCalls(page)).toBe(1);
    expect(await storedChoice(page)).toBe("on");
    // Nothing moves the light until a reading arrives.
    await expect(html(page)).not.toHaveAttribute("data-tilt");

    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
    expect(problems).toEqual([]);
  });

  test("moves the light with the tilt, and clamps it", async ({ page }) => {
    const problems = watchConsole(page);
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    // Only panels on screen are moved, and the test reads the first one.
    await page.locator(".surface").first().scrollIntoViewIfNeeded();
    // The first reading is neutral.
    await tiltUntil(page, 0, 0, "--light-x", () => true);
    const neutralPainted = await paintedLight(page);
    expect(Math.abs(Number(await lightVar(page, "--light-x")))).toBeLessThan(0.05);

    // Held upright: the vertical light reaches its end.
    await tiltUntil(page, 90, 0, "--light-y", (y) => y * LIGHT_SIGN <= -0.99);
    // Left edge down and right edge down go opposite ways (upright, gamma says nothing: it is the edge case).
    await tiltUntil(page, 30, -45, "--light-x", (x) => x * LIGHT_SIGN >= 0.5);
    const leftDown = await paintedLight(page);
    await tiltUntil(page, 30, 45, "--light-x", (x) => x * LIGHT_SIGN <= -0.5);
    const rightDown = await paintedLight(page);

    // And the value reaches the pseudo-elements: what they draw follows it.
    const readings = await lightReadings(page);
    test.info().annotations.push({ type: "tilt-readings", description: readings });
    const same = (name: string, a: string, b: string) => {
      if (a === b) console.log(`[tilt] ${name} did not change: ${readings}`);
      expect(a, name).not.toBe(b);
    };
    same("sheen, left edge down against right", leftDown.sheen, rightDown.sheen);
    same("glint, left edge down against right", leftDown.glint, rightDown.glint);
    same("sheen against the untilted one", neutralPainted.sheen, rightDown.sheen);
    same("glint against the neutral one", neutralPainted.glint, rightDown.glint);
    for (const name of ["--light-x", "--light-y"] as const) {
      const value = Number(await lightVar(page, name));
      expect(Math.abs(value)).toBeLessThanOrEqual(1);
    }
    expect(await lightVar(page, "--light-x")).toMatch(/^-?\d(\.\d{1,3})?$/);

    // The sheen's layer is slid and the glint sits on the card (the gradients themselves never change).
    const light = await cardLight(page);
    expect(light.sheen).toContain("125deg");
    expect(light.sheenMoves).not.toBe("none");
    expect(light.glint).not.toBe("none");
    expect(light.glintImage).toContain("radial-gradient");
    // The glint's layer is the same fixed size whatever the panel is, not a multiple of it.
    expect(light.glintWidth).toBe("432px");
    expect(light.glintHeight).toBe("432px");
    expect(problems).toEqual([]);
  });

  test("slides the glint by a share of the panel's own size, and follows it when it grows", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await page.locator(".surface").first().scrollIntoViewIfNeeded();
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await tiltUntil(page, 90, 0, "--light-y", (y) => y * LIGHT_SIGN <= -0.99);
    const reaches = async () => {
      const y = Number(await lightVar(page, "--light-y"));
      const shift = await glintShift(page);
      return { y, shift, expected: y * 0.38 * shift.h };
    };
    await expect
      .poll(async () => {
        const seen = await reaches();
        return Math.abs(seen.shift.y - seen.expected) < 2 && Math.abs(seen.shift.y) > 5;
      })
      .toBe(true);

    // A taller panel (a refresh adds rows) moves the glint further, with no new reading.
    await page
      .locator(".surface")
      .first()
      .evaluate((card) => {
        card.style.height = "400px";
      });
    await expect
      .poll(async () => {
        const seen = await reaches();
        return seen.shift.h >= 400 && Math.abs(seen.shift.y - seen.expected) < 2 && Math.abs(seen.shift.y) > 100;
      })
      .toBe(true);
  });

  test("keeps lighting a panel that is moved in the document", async ({ page }) => {
    // React moves a keyed card this way when a refresh changes the order or a card is starred. The browser
    // rebuilds the pseudo-elements of a panel that is taken out and put back, and animations on the old ones draw nothing.
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await page.locator(".surface").first().scrollIntoViewIfNeeded();
    await tiltUntil(page, 0, 0, "--light-x", () => true);
    await tiltUntil(page, 30, -45, "--light-x", (x) => x * LIGHT_SIGN >= 0.5);
    await page
      .locator(".surface")
      .first()
      .evaluate((card) => {
        card.setAttribute("data-moved", "");
      });
    const before = await paintedOf(page, "[data-moved]");
    expect(before).not.toBe(AT_REST);

    await page.evaluate(() => {
      const card = document.querySelector("[data-moved]");
      card?.parentNode?.insertBefore(card, card.nextSibling);
    });
    await page.locator("[data-moved]").scrollIntoViewIfNeeded();
    await tiltUntil(page, 30, 45, "--light-x", (x) => x * LIGHT_SIGN <= -0.5);
    await expect
      .poll(async () => {
        const after = await paintedOf(page, "[data-moved]");
        return after !== AT_REST && after !== before;
      })
      .toBe(true);
    // And the glint is where the light is.
    await expect
      .poll(async () => {
        const x = Number(await lightVar(page, "--light-x"));
        const shift = await glintShift(page, "[data-moved]");
        return Math.abs(shift.x - x * 0.38 * shift.w) < 2 && Math.abs(shift.x) > 20;
      })
      .toBe(true);
  });

  test("lights the panels again after the board was hidden and shown", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await page.locator(".surface").first().scrollIntoViewIfNeeded();
    await tiltUntil(page, 0, 0, "--light-x", () => true);
    await tiltUntil(page, 30, -45, "--light-x", (x) => x * LIGHT_SIGN >= 0.5);

    // display: none destroys the pseudo-elements; showing the board builds new ones.
    await page.evaluate(async () => {
      const main = document.getElementById("services");
      const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (main) main.style.display = "none";
      await frames();
      if (main) main.style.display = "";
      await frames();
    });
    await page.locator(".surface").first().scrollIntoViewIfNeeded();
    await tiltUntil(page, 30, 45, "--light-x", (x) => x * LIGHT_SIGN <= -0.5);
    await expect
      .poll(async () => {
        const x = Number(await lightVar(page, "--light-x"));
        const shift = await glintShift(page);
        return Math.abs(shift.x - x * 0.38 * shift.w) < 2 && Math.abs(shift.x) > 20;
      })
      .toBe(true);
  });

  test("turns the light with the screen: upright in landscape moves it sideways", async ({ page }) => {
    await stubMotionPermission(page, "granted", 90);
    await page.reload();
    await hydrated(page);
    await angleIs(page, 90);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltUntil(page, 0, 0, "--light-x", () => true);
    // Held upright with the screen turned a quarter, the same tilt is a sideways one.
    await tiltUntil(page, 90, 0, "--light-x", (x) => x * LIGHT_SIGN <= -0.99);
    expect(Math.abs(Number(await lightVar(page, "--light-y")))).toBeLessThan(0.05);
  });

  test("is declined without being saved, and says how to allow it", async ({ page }) => {
    await stubMotionPermission(page, "denied");
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await expect(page.getByRole("status").filter({ hasText: "Motion access was declined" })).toContainText(
      "Quit the browser and reopen this page to be asked again",
    );
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    expect(await permissionCalls(page)).toBe(1);
    expect(await storedChoice(page)).not.toBe("on");
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    expect(await lightVar(page, "--light-x")).toBe("");

    // The dialog with its note still passes the accessibility scan.
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });

  test("treats a refused permission request as declined", async ({ page }) => {
    await stubMotionPermission(page, "throws");
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await expect(page.getByText("Motion access was declined")).toBeVisible();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    expect(await storedChoice(page)).not.toBe("on");
  });

  test("says so when the device has no motion sensor", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await expect
      .poll(
        async () => {
          await tilt(page, null, null);
          return page.getByText("This device has no motion sensor.").count();
        },
        { timeout: 10_000 },
      )
      .toBe(1);
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    await expect(html(page)).not.toHaveAttribute("data-tilt");
  });

  test("keeps the choice across a reload without asking again", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltUntil(page, 0, 0, "--light-y", () => true);

    const problems = watchConsole(page);
    await pumpReadings(page, 0, 0);
    await page.reload();
    await hydrated(page);
    // A saved "on" attaches at once and never prompts: iOS wants a tap for that.
    expect(await permissionCalls(page)).toBe(0);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
    expect(await permissionCalls(page)).toBe(0);
    await openSettings(page);
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "true");
    expect(problems).toEqual([]);
  });

  test("asks to be allowed again when a saved choice gets no motion, and a tap retries", async ({ page }) => {
    await page.evaluate((key) => localStorage.setItem(key, "on"), TILT_STORAGE_KEY);
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await expect(page.getByText("Motion access lapsed. Turn the switch off and on to allow it again.")).toBeVisible();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    expect(await permissionCalls(page)).toBe(0);
    // The saved choice is dropped when the note first shows, so the next load does not ask again.
    expect(await storedChoice(page)).toBe("off");

    await tiltSwitch(page).click();
    expect(await permissionCalls(page)).toBe(1);
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "true");
    expect(await storedChoice(page)).toBe("on");
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
    await expect(page.getByText("Motion access lapsed")).toHaveCount(0);
  });

  test("does not ask again on the next load, and stays off when the retry is declined", async ({ page }) => {
    await page.evaluate((key) => localStorage.setItem(key, "on"), TILT_STORAGE_KEY);
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await expect(page.getByText("Motion access lapsed")).toBeVisible();
    expect(await storedChoice(page)).toBe("off");

    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Motion access lapsed")).toHaveCount(0);

    // A tap the user declines leaves it off, with the note for that.
    await stubMotionPermission(page, "denied");
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await expect(page.getByText("Motion access was declined")).toBeVisible();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    expect(await storedChoice(page)).toBe("off");
  });

  test("keeps a saved choice when the first reading is two seconds late", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltUntil(page, 0, 0, "--light-y", () => true);

    await pumpReadings(page, 0, 0, 2000);
    await page.reload();
    await hydrated(page);
    // Motion is allowed for the session, so a slow sensor is not a missing permission.
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
    expect(await storedChoice(page)).toBe("on");
    await expect(page.getByText("Motion access lapsed")).toHaveCount(0);
  });

  test("asks again, and stores off, when Safari was closed since motion was allowed", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    expect(await storedChoice(page)).toBe("on");

    // A new session remembers no grant.
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await expect(page.getByText("Motion access lapsed")).toBeVisible();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    expect(await storedChoice(page)).toBe("off");
    expect(await permissionCalls(page)).toBe(0);
  });

  test("drops a saved choice when no readings ever arrive and there is nothing to ask", async ({ page }) => {
    await stubMotionPermission(page, "absent");
    await page.evaluate((key) => localStorage.setItem(key, "on"), TILT_STORAGE_KEY);
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    // The note comes 3 s after the page starts listening (its silence timer), too close to the default 5 s.
    await expect(page.getByText("Your device sent no motion data, so I switched tilt lighting off.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    expect(await storedChoice(page)).toBe("off");

    // The next load has nothing to say.
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await page.waitForTimeout(3500);
    await expect(page.getByText(/No motion readings arrived|sent no motion data/)).toHaveCount(0);
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
  });

  test("says so when a tap gets no readings, and a second tap tries again", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    expect(await permissionCalls(page)).toBe(1);
    // The note comes 3 s after the page starts listening (its silence timer), too close to the default 5 s.
    await expect(page.getByText("No motion readings arrived from this device.")).toBeVisible({ timeout: 10_000 });
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    // Not the note for a saved choice: this one was just allowed.
    await expect(page.getByText("Motion access lapsed")).toHaveCount(0);

    await tiltSwitch(page).click();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "true");
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await expect(page.getByText("No motion readings arrived from this device.")).toHaveCount(0);
  });

  test("does not ask again while the page loads hidden", async ({ page }) => {
    await page.evaluate((key) => localStorage.setItem(key, "on"), TILT_STORAGE_KEY);
    // Motion was allowed earlier in this session.
    await page.evaluate(() => sessionStorage.setItem("__tiltGranted", "1"));
    await page.addInitScript(() => {
      const w = window as unknown as { __hidden: boolean };
      w.__hidden = true;
      Object.defineProperty(document, "visibilityState", {
        get: () => (w.__hidden ? "hidden" : "visible"),
        configurable: true,
      });
    });
    await page.reload();
    await hydrated(page);
    // Longer than either wait for a first reading: nothing listened, so nothing is missing.
    await page.waitForTimeout(3500);
    await openSettings(page);
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("status").filter({ hasText: /Motion access lapsed|No motion readings|sent no motion data/ }),
    ).toHaveCount(0);

    await page.evaluate(() => {
      (window as unknown as { __hidden: boolean }).__hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
    await expect(
      page.getByRole("status").filter({ hasText: /Motion access lapsed|No motion readings|sent no motion data/ }),
    ).toHaveCount(0);
  });

  test("lights a panel that appears after the light is on, and clears the light when off", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltFromRest(page);
    expect(await lightHolders(page)).toBeGreaterThan(0);
    const added = await page.evaluate(async () => {
      const panel = document.createElement("div");
      panel.className = "surface";
      panel.id = "late-panel";
      // The light is on the board, so a panel anywhere inside it is lit: by animations of its own, or by
      // the properties it inherits.
      document.getElementById("services")?.appendChild(panel);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      return {
        animations: panel.getAnimations({ subtree: true }).length,
        inherited: getComputedStyle(panel).getPropertyValue("--light-y").trim(),
        transform: getComputedStyle(panel, "::before").transform,
      };
    });
    expect(added.animations > 0 || added.inherited !== "").toBe(true);
    expect(added.transform).not.toBe("none");
    await tiltSwitch(page).click();
    const cleared = await page.evaluate(() => {
      const panel = document.getElementById("late-panel") as Element;
      return {
        animations: panel.getAnimations({ subtree: true }).length,
        inherited: getComputedStyle(panel).getPropertyValue("--light-y").trim(),
      };
    });
    expect(cleared).toEqual({ animations: 0, inherited: "" });
  });

  test("switches off cleanly", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltFromRest(page);
    await tiltSwitch(page).click();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    expect(await lightVar(page, "--light-x")).toBe("");
    expect(await lightVar(page, "--light-y")).toBe("");
    expect(await lightHolders(page)).toBe(0);
    expect(await storedChoice(page)).toBe("off");
    // Readings after that go nowhere.
    await tilt(page, 0, 0);
    await page.waitForTimeout(200);
    expect(await lightVar(page, "--light-x")).toBe("");
  });

  test("stands down under Reduce glass, and comes back with it", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltFromRest(page);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");

    await page.getByRole("switch", { name: "Reduce glass" }).click();
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    expect(await lightVar(page, "--light-x")).toBe("");
    expect(await lightVar(page, "--light-y")).toBe("");
    expect(await lightHolders(page)).toBe(0);
    await expect(page.getByRole("status").filter({ hasText: "Paused while Reduce glass" })).toBeVisible();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "true");
    expect((await cardLight(page)).glint).toBe("none");

    await page.getByRole("switch", { name: "Reduce glass" }).click();
    await tiltFromRest(page);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
  });

  test("stands down in Quiet with the note, and lights the panels once Glass is chosen", async ({ page }) => {
    // Registered after this file's start-on-Glass script, so it runs after it on every load.
    await page.addInitScript(() => localStorage.removeItem("status-bar:background"));
    await page.reload();
    await hydrated(page);
    await expect(html(page)).not.toHaveAttribute("data-background");
    await openSettings(page);
    await tiltSwitch(page).click();
    await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("status").filter({ hasText: "Needs the Glass or Full background." })).toBeVisible();
    await tilt(page, 0, 0);
    await tilt(page, 90, 0);
    await page.waitForTimeout(300);
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    expect(await lightHolders(page)).toBe(0);

    // The choice is kept, and Glass wakes it.
    await page.locator("label", { hasText: "Glass" }).click();
    await expect(html(page)).toHaveAttribute("data-background", "glass");
    await expect(page.getByRole("status").filter({ hasText: "Needs the Glass or Full background." })).toHaveCount(0);
    await tiltFromRest(page);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
    expect(await lightHolders(page)).toBeGreaterThan(0);
  });

  test("stands down under Reduce Motion, and comes back without it", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltFromRest(page);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    expect(await lightVar(page, "--light-x")).toBe("");
    expect(await lightHolders(page)).toBe(0);
    await tilt(page, 0, 0);
    await page.waitForTimeout(200);
    expect(await lightVar(page, "--light-x")).toBe("");
    expect((await cardLight(page)).glint).toBe("none");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await tiltFromRest(page);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
  });

  test("stands down under Increase Contrast, where the light is transparent", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltFromRest(page);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");

    await page.emulateMedia({ contrast: "more" });
    await expect(html(page)).not.toHaveAttribute("data-tilt");
    expect(await lightHolders(page)).toBe(0);

    await page.emulateMedia({ contrast: "no-preference" });
    await tiltFromRest(page);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
  });

  test("falls back to the properties when an engine takes pseudoElement and draws nothing", async ({ page }) => {
    // animate() accepts the call but ignores the pseudo-element: the animations land on the panel
    // itself, the panel's ::before does not move, and the sink's own check has to notice.
    await page.addInitScript(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, keyframes, options) {
        if (options && typeof options === "object" && "pseudoElement" in options) {
          const rest = { ...(options as KeyframeAnimationOptions) };
          delete rest.pseudoElement;
          return animate.call(this, keyframes, rest);
        }
        return animate.call(this, keyframes, options);
      };
    });
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await page.locator(".surface").first().scrollIntoViewIfNeeded();
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await tiltUntil(page, 90, 0, "--light-y", (y) => y * LIGHT_SIGN <= -0.99);

    const seen = await page.evaluate(() => ({
      holders: Array.from(document.querySelectorAll<HTMLElement>("[style]"))
        .filter((element) => element.style.getPropertyValue("--light-y") !== "")
        .map((element) => element.id || element.tagName),
      animations: document.getAnimations().filter((animation) => animation.id.startsWith("tilt-light-")).length,
      sheen: getComputedStyle(document.querySelector(".surface") as Element, "::before").transform,
    }));
    expect(seen.holders).toEqual(["services"]);
    expect(seen.animations).toBe(0);
    expect(seen.sheen).not.toBe("none");
    expect((await paintedLight(page)).sheen).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  });

  test("falls back to custom properties on one element where pseudo-elements cannot be animated", async ({ page }) => {
    // An engine without KeyframeEffect: the sink writes --light-x and --light-y on <main> instead.
    await page.addInitScript(() => {
      Object.defineProperty(window, "KeyframeEffect", { value: undefined, configurable: true });
    });
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await page.locator(".surface").first().scrollIntoViewIfNeeded();
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await tiltUntil(page, 90, 0, "--light-y", (y) => y * LIGHT_SIGN <= -0.99);

    const seen = await page.evaluate(() => {
      const holders = Array.from(document.querySelectorAll<HTMLElement>("[style]")).filter(
        (element) => element.style.getPropertyValue("--light-y") !== "",
      );
      const row = document.querySelector(".surface > *") as Element;
      return {
        holders: holders.map((element) => element.id || element.tagName),
        animations: document.getAnimations().filter((animation) => animation.id.startsWith("tilt-light-")).length,
        // Below a panel's own children the properties are cut off, so a write does not walk the rows.
        insideRow: getComputedStyle(row.firstElementChild ?? row)
          .getPropertyValue("--light-y")
          .trim(),
        // And the panel itself moves with them.
        sheen: getComputedStyle(document.querySelector(".surface") as Element, "::before").transform,
      };
    });
    expect(seen.holders).toEqual(["services"]);
    expect(seen.animations).toBe(0);
    expect(seen.insideRow).toBe("");
    expect(seen.sheen).not.toBe("none");
    expect((await paintedLight(page)).sheen).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
    // The glint slides by a length the sink wrote on the panel itself (its size), not on the board.
    const reach = await page
      .locator(".surface")
      .first()
      .evaluate((card) => ({
        dx: card.style.getPropertyValue("--glint-dx"),
        dy: card.style.getPropertyValue("--glint-dy"),
      }));
    expect(reach.dx).toMatch(/^\d+(\.\d)?px$/);
    expect(reach.dy).toMatch(/^\d+(\.\d)?px$/);
    await expect
      .poll(async () => {
        const y = Number(await lightVar(page, "--light-y"));
        const shift = await glintShift(page);
        return Math.abs(shift.y - y * 0.38 * shift.h) < 3 && Math.abs(shift.y) > 5;
      })
      .toBe(true);
  });

  for (const path of ["animations", "custom properties"] as const) {
    test(`follows a pointer being attached and detached while the light is on (${path})`, async ({ page }) => {
      // A touch tablet with a mouse attached has a hover-capable pointer: the glint is not drawn, and the sink
      // makes none. The query answers for the glint's rules (the page's own style sheet keeps answering as the
      // device is, a touch one), so the test flips the sink's answer by hand: a controllable stand-in for that
      // one query, which tells its listeners when it changes.
      await page.addInitScript(
        ([query, hasMouse, viaProperties]) => {
          if (viaProperties) Object.defineProperty(window, "KeyframeEffect", { value: undefined, configurable: true });
          const real = window.matchMedia.bind(window);
          let matches = !hasMouse;
          const listeners = new Set<(event: unknown) => void>();
          window.matchMedia = (asked: string) => {
            if (asked !== query) return real(asked);
            return {
              media: asked,
              get matches() {
                return matches;
              },
              onchange: null,
              addEventListener: (type: string, listener: (event: unknown) => void) => {
                if (type === "change") listeners.add(listener);
              },
              removeEventListener: (type: string, listener: (event: unknown) => void) => {
                if (type === "change") listeners.delete(listener);
              },
              addListener: (listener: (event: unknown) => void) => listeners.add(listener),
              removeListener: (listener: (event: unknown) => void) => listeners.delete(listener),
              dispatchEvent: () => true,
            } as unknown as MediaQueryList;
          };
          (window as unknown as { __glintQuery: unknown }).__glintQuery = {
            set: (value: boolean) => {
              matches = value;
              for (const listener of Array.from(listeners)) listener({ matches: value, media: query, type: "change" });
            },
            listeners: () => listeners.size,
          };
        },
        [GLINT_QUERY, true, path === "custom properties"] as const,
      );
      await page.reload();
      await hydrated(page);
      await openSettings(page);
      await tiltSwitch(page).click();
      await page.locator(".surface").first().scrollIntoViewIfNeeded();
      await tiltUntil(page, 0, 0, "--light-y", () => true);
      await tiltUntil(page, 90, 0, "--light-y", (y) => y * LIGHT_SIGN <= -0.99);

      const flip = (value: boolean) =>
        page.evaluate(
          (value) => (window as unknown as { __glintQuery: { set: (v: boolean) => void } }).__glintQuery.set(value),
          value,
        );
      const glintState = () =>
        page.evaluate(() => {
          const card = document.querySelector<HTMLElement>(".surface");
          return {
            animations: document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.id.startsWith("tilt-light-") &&
                  (animation.effect as KeyframeEffect | null)?.pseudoElement === "::after",
              ).length,
            dx: card?.style.getPropertyValue("--glint-dx") ?? "",
            listeners: (window as unknown as { __glintQuery: { listeners: () => number } }).__glintQuery.listeners(),
          };
        });
      const followsLight = async () => {
        const y = Number(await lightVar(page, "--light-y"));
        const shift = await glintShift(page);
        return Math.abs(shift.y - y * 0.38 * shift.h) < 3 && Math.abs(shift.y) > 5;
      };
      const still = async () => Math.abs((await glintShift(page)).y) < 0.5;

      // A mouse is attached when the light starts: the sheen follows the light, the glint has nothing made for it.
      expect(await paintedOf(page, ".surface")).not.toBe(AT_REST);
      expect(await glintState()).toMatchObject({ animations: 0, dx: "", listeners: 1 });
      expect(await still()).toBe(true);

      // The mouse is taken off: the glint is made and put where the light is, with no new reading.
      await flip(true);
      await expect.poll(followsLight).toBe(true);
      const on = await glintState();
      if (path === "animations") expect(on.animations).toBeGreaterThan(0);
      else expect(on.dx).toMatch(/^\d+(\.\d)?px$/);
      await tiltUntil(page, 30, -45, "--light-x", (x) => x * LIGHT_SIGN >= 0.5);
      await expect
        .poll(async () => {
          const x = Number(await lightVar(page, "--light-x"));
          const shift = await glintShift(page);
          return Math.abs(shift.x - x * 0.38 * shift.w) < 2 && Math.abs(shift.x) > 20;
        })
        .toBe(true);

      // The mouse is attached again: the glint is dropped and the light no longer drives it.
      await flip(false);
      await expect.poll(still).toBe(true);
      expect(await glintState()).toMatchObject({ animations: 0, dx: "" });
      await tiltUntil(page, 0, 0, "--light-x", (x) => Math.abs(x) < 0.2);
      await tiltUntil(page, 30, -45, "--light-x", (x) => x * LIGHT_SIGN >= 0.5);
      expect((await glintShift(page)).x).toBeCloseTo(0, 0);
      expect(await glintState()).toMatchObject({ animations: 0, dx: "" });

      // Switching the light off takes the listener away with it.
      await tiltSwitch(page).click();
      await expect(tiltSwitch(page)).toHaveAttribute("aria-checked", "false");
      await expect.poll(async () => (await glintState()).listeners).toBe(0);
    });
  }

  test("writes nothing while no panel is on screen, and catches up when one comes back", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await tiltUntil(page, 90, 0, "--light-y", (y) => y * LIGHT_SIGN <= -0.99);

    // Every panel is inside <main>: slide it off the screen (not display: none, which destroys the
    // panels' pseudo-elements, and has a test of its own above).
    const board = (shown: boolean) =>
      page.evaluate(async (shown) => {
        const main = document.getElementById("services");
        if (main) main.style.transform = shown ? "" : "translateX(-100000px)";
        // Two frames: the observer reports on the frame after the change.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
      }, shown);
    await page.locator(".surface").first().scrollIntoViewIfNeeded();
    await board(false);
    await page.waitForTimeout(100);
    const frozen = await lightVar(page, "--light-y");
    // Held flat again for long enough that the light, if it were written, would be back at the start.
    for (let i = 0; i < 20; i++) {
      await tilt(page, 0, 0);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(300);
    expect(await lightVar(page, "--light-y")).toBe(frozen);

    // Back on screen: one write puts the page where the light is now, without waiting for another reading.
    await board(true);
    await expect
      .poll(async () => Math.abs(Number(await lightVar(page, "--light-y"))), { timeout: 5000 })
      .toBeLessThan(0.3);
    // What is drawn catches up too (the light is near the middle, so the glint is near its resting place).
    await expect
      .poll(async () => {
        const shift = await glintShift(page);
        return Math.abs(shift.y) < 0.3 * 0.38 * shift.h;
      })
      .toBe(true);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");

    // And it goes on following the light.
    await tiltUntil(page, 30, -45, "--light-x", (x) => x * LIGHT_SIGN >= 0.5);
    await expect
      .poll(async () => {
        const x = Number(await lightVar(page, "--light-x"));
        const shift = await glintShift(page);
        return Math.abs(shift.x - x * 0.38 * shift.w) < 2 && Math.abs(shift.x) > 20;
      })
      .toBe(true);
  });

  test("stops listening while the tab is hidden", async ({ page }) => {
    await page.reload();
    await hydrated(page);
    await openSettings(page);
    await tiltSwitch(page).click();
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await tiltUntil(page, 90, 0, "--light-y", (y) => y * LIGHT_SIGN <= -0.99);

    const visibility = (state: "hidden" | "visible") =>
      page.evaluate((state) => {
        Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);

    await visibility("hidden");
    const frozen = await lightVar(page, "--light-y");
    await tilt(page, 0, 0);
    await page.waitForTimeout(400);
    expect(await lightVar(page, "--light-y")).toBe(frozen);

    await visibility("visible");
    await tiltUntil(page, 0, 0, "--light-y", () => true);
    await page.waitForTimeout(100);
    await expect(html(page)).toHaveAttribute("data-tilt", "on");
  });
});
