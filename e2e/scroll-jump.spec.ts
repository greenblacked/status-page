import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { fixtureBoard, serveBoard } from "./fixture-board";
import { expect, test } from "./test";

// What a reader of an iPhone sees as "the bar jumps while scrolling": the bar itself is fixed and never moves, the
// page around it does. These tests drive real touch gestures (DevTools touch events, which the browser turns into
// a scroll like a finger does) and log the reader's card on every frame.

const SERVICES = 20;
const SLOT_MS = 120_000;
const cards = (page: Page) => page.locator('article[id^="service-"]');
const feedRows = (page: Page) => page.locator('section[aria-labelledby="recent-heading"] li');

/** As in board.spec.ts: data-hydrated waits for the saved checks, a few renders after the first, so 15 s on a loaded runner. */
async function hydrated(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
}

type Frame = { t: number; tops: Record<string, number>; y: number; rows: number; by: number };

/**
 * Logs the cards on every frame: the top in the window of each one in view, the scroll position, how many rows
 * Recent changes has and how far the page has scrolled itself by (window.scrollBy, which is how the page keeps a
 * place).
 */
async function logFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tracked = window as Window & { __frames?: Frame[]; __logging?: boolean; __by?: number };
    tracked.__frames = [];
    tracked.__logging = true;
    const rows = () => document.querySelectorAll('section[aria-labelledby="recent-heading"] li').length;
    const frame = () => {
      if (!tracked.__logging) return;
      tracked.__frames?.push({
        t: performance.now(),
        tops: Object.fromEntries(
          Array.from(document.querySelectorAll('article[id^="service-"]'), (card) => [
            card.id,
            card.getBoundingClientRect().top,
          ]),
        ),
        y: window.scrollY,
        rows: rows(),
        by: tracked.__by ?? 0,
      });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function stopLogging(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const tracked = window as Window & { __frames?: Frame[]; __logging?: boolean };
    tracked.__logging = false;
    return tracked.__frames ?? [];
  });
}

/**
 * Something that moves the page the way a reader does. `down`, `dragBy` and `up` are a finger's: the page moves with
 * it, so the card under it stays under it. `at` is where, on the screen, the reader's attention is.
 */
interface Reader {
  readonly at: number;
  /** When, in the page's clock, the page was last scrolled by the reader (a finger that rests has no such moment). */
  readonly movedAt?: number;
  down(y: number): Promise<void>;
  dragBy(dy: number, step: number): Promise<void>;
  up(): Promise<void>;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A finger on the glass: touch events over DevTools, one move every frame or so. Chromium only. */
class Finger implements Reader {
  private y = 0;
  /** Where the finger is. */
  get at() {
    return this.y;
  }
  constructor(
    private readonly cdp: CDPSession,
    private readonly x: number,
  ) {}
  private send(type: "touchStart" | "touchMove" | "touchEnd", y: number) {
    return this.cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: this.x, y }],
    });
  }
  async down(y: number) {
    this.y = y;
    await this.send("touchStart", y);
  }
  async dragBy(dy: number, step: number) {
    const steps = Math.max(1, Math.round(Math.abs(dy) / step));
    for (let i = 0; i < steps; i++) {
      this.y += dy / steps;
      await this.send("touchMove", this.y);
      await pause(16);
    }
  }
  async up() {
    await this.send("touchEnd", this.y);
  }
}

type Pad = Window & {
  __pad?: { fire: (type: string, y: number, live: boolean) => string };
};

/**
 * A finger that every engine can have: the touch events the page listens to (touchstart, touchmove, touchend), made
 * in the page and sent to the card under the finger, and the page scrolled with it a step at a time, as the browser
 * would. A real TouchEvent where the engine has the constructors (iOS, and Chromium with touch emulation); where it
 * has not, a plain event with the same `touches`, which is all the page reads of it.
 */
class SyntheticFinger implements Reader {
  private y = 0;
  /** "TouchEvent" or "Event": what the last event was made of. */
  shape = "";
  get at() {
    return this.y;
  }
  constructor(
    private readonly page: Page,
    private readonly x: number,
  ) {}
  private async fire(type: "touchstart" | "touchmove" | "touchend", y: number) {
    this.shape = await this.page.evaluate(
      ([type, y]) => (window as Pad).__pad?.fire(type as string, y as number, type !== "touchend") ?? "",
      [type, y],
    );
  }
  async down(y: number) {
    this.y = y;
    await this.page.evaluate(
      ([x, y]) => {
        const target = document.elementFromPoint(x, y) ?? document.body;
        let cancelled = false;
        (window as Pad).__pad = {
          fire(type, at, live) {
            const node = target.isConnected ? target : document.body;
            // As on a phone: a pointer goes down with the finger, and is cancelled when the browser takes the
            // gesture for a scroll, while the touch events go on.
            const pointer = (name: string) => {
              if (typeof PointerEvent !== "function") return;
              const init = { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: at };
              node.dispatchEvent(new PointerEvent(name, { ...init, bubbles: true, cancelable: true, composed: true }));
            };
            if (type === "touchstart") pointer("pointerdown");
            if (type === "touchmove" && !cancelled) {
              cancelled = true;
              pointer("pointercancel");
            }
            const point = { identifier: 1, target: node, clientX: x, clientY: at, pageX: x, pageY: at + scrollY };
            try {
              const touch = new Touch(point);
              node.dispatchEvent(
                new TouchEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  touches: live ? [touch] : [],
                  targetTouches: live ? [touch] : [],
                  changedTouches: [touch],
                }),
              );
              return "TouchEvent";
            } catch {
              const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
              const list = live ? [point] : [];
              Object.defineProperties(event, {
                touches: { value: list },
                targetTouches: { value: list },
                changedTouches: { value: [point] },
              });
              node.dispatchEvent(event);
              return "Event";
            }
          },
        };
      },
      [this.x, y],
    );
    await this.fire("touchstart", y);
  }
  async dragBy(dy: number, step: number) {
    const steps = Math.max(1, Math.round(Math.abs(dy) / step));
    for (let i = 0; i < steps; i++) {
      this.y += dy / steps;
      await this.fire("touchmove", this.y);
      // The page follows the finger: a finger that moves up takes the page down with it.
      await this.page.evaluate((by) => window.scrollTo({ top: window.scrollY - by, behavior: "instant" }), dy / steps);
      await pause(16);
    }
  }
  async up() {
    await this.fire("touchend", this.y);
  }
}

/**
 * No finger: the page scrolled a step at a time (a wheel, the glide of a flick), which is scroll events alone, with
 * a mouse resting on the card the reader is on.
 */
class Scroller implements Reader {
  private y = 0;
  /** When, in the page's clock, the page was last scrolled. */
  movedAt = 0;
  get at() {
    return this.y;
  }
  constructor(
    private readonly page: Page,
    private readonly x: number,
  ) {}
  async down(y: number) {
    this.y = y;
    await this.page.evaluate(
      ([x, y]) => {
        const target = document.elementFromPoint(x, y) ?? document.body;
        const init = { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y };
        target.dispatchEvent(new PointerEvent("pointermove", { ...init, bubbles: true, composed: true }));
      },
      [this.x, y],
    );
  }
  async dragBy(dy: number, step: number) {
    const steps = Math.max(1, Math.round(Math.abs(dy) / step));
    for (let i = 0; i < steps; i++) {
      this.movedAt = await this.page.evaluate((by) => {
        window.scrollTo({ top: window.scrollY - by, behavior: "instant" });
        return performance.now();
      }, dy / steps);
      await pause(16);
    }
  }
  async up() {}
}

/** The distance, in px, a frame moved the card on screen beyond what the page's own scroll accounts for. */
function jumps(frames: Frame[], card: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const [from, to] = [a.tops[card], b.tops[card]];
    if (from === undefined || to === undefined) continue;
    // Where the card is on the page, less what the page scrolled itself by: a layout shift the page did not hold.
    out.push(to + b.y - (from + a.y) - (b.by - a.by));
  }
  return out;
}

/**
 * The reader is on a card below Recent changes. Two and a half seconds before the board's check at the turn of a
 * slot, `reader` starts to move the page, for about four and a half seconds, so the turn falls inside the gesture.
 * Then it stops (a finger rests, still down, for a moment and lifts), and the check must land after, with the card
 * the reader is on where it was.
 *
 * `touching` is whether `reader` is a finger: Recent changes must not change while it is down, even while it rests.
 */
async function acrossTheTurn(
  page: Page,
  testInfo: TestInfo,
  makeReader: (viewport: { width: number; height: number }) => Promise<Reader> | Reader,
  { touching }: { touching: boolean },
): Promise<void> {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const tracked = window as Window & { __by?: number };
    tracked.__by = 0;
    const original = window.scrollBy;
    window.scrollBy = ((...args: unknown[]) => {
      const first = args[0] as ScrollToOptions | number | undefined;
      tracked.__by = (tracked.__by ?? 0) + (typeof first === "object" ? (first?.top ?? 0) : ((args[1] as number) ?? 0));
      return (original as (...values: unknown[]) => void).apply(window, args);
    }) as typeof window.scrollBy;
  });
  // Well inside a slot while the page loads; the turn is brought close afterwards.
  const slotStart = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
  await page.clock.install({ time: slotStart + 30_000 });
  const board = fixtureBoard(Date.now());
  await serveBoard(page, () => board);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  await page.getByRole("button", { name: "Refresh status now" }).first().click();
  await expect(page.locator("#service-aws").getByText("Outage", { exact: true }).first()).toBeVisible();
  // Safari has no scroll anchoring, and the page cannot lean on it.
  await page.addStyleTag({ content: "html, body { overflow-anchor: none !important; }" });

  // The reader is on a card below Recent changes.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  await page.evaluate(
    ([id, at]) => {
      const el = document.getElementById(id as string);
      if (el) window.scrollBy(0, el.getBoundingClientRect().top - (at as number));
    },
    ["service-spotify", viewport.height * 0.6],
  );
  const rows0 = await feedRows(page).count();

  // Two and a half seconds before the board's check at the turn of a slot.
  const msToTurn = await page.evaluate((slot) => slot - (Date.now() % slot), SLOT_MS);
  await page.clock.fastForward(Math.max(0, msToTurn - 2_500));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(await feedRows(page).count(), "the turn has not come yet").toBe(rows0);

  const reader = await makeReader(viewport);
  await logFrames(page);
  await reader.down(viewport.height * 0.7);
  const downAt = await page.evaluate(() => Date.now());
  expect(await feedRows(page).count(), "the turn had not come when the reader started").toBe(rows0);
  // About four and a half seconds of dragging, up and down so the card stays on screen, across the turn.
  const dragStart = Date.now();
  while (Date.now() - dragStart < 4_500) {
    await reader.dragBy(-90, 3);
    await reader.dragBy(90, 3);
  }
  let rowsWhileTouching = rows0;
  if (touching) {
    // The finger rests a moment, still down, before it lifts: no scroll events, and still not the time to update.
    await pause(400);
    rowsWhileTouching = await feedRows(page).count();
  }
  // Where the gesture ends, in the page's clock: the lift of a finger, else the last scroll step.
  const liftedAt = touching ? await page.evaluate(() => performance.now()) : (reader.movedAt ?? Number.NaN);
  // The card the reader is on as the gesture ends: the one they are looking at.
  const card = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('article[id^="service-"]')?.id ?? "",
    [viewport.width / 2, reader.at],
  );
  expect(card, "the reader is on a card").not.toBe("");
  const upAt = await page.evaluate(() => Date.now());
  await reader.up();
  // The turn of the slot fell inside the gesture: without it the test would hold nothing back.
  const turnAt = (Math.floor(downAt / SLOT_MS) + 1) * SLOT_MS;
  expect(upAt, "the reader was still moving the page at the turn of the slot").toBeGreaterThanOrEqual(turnAt);
  // The check lands once the page is still.
  await expect.poll(() => feedRows(page).count(), { timeout: 5_000 }).toBeGreaterThan(rows0);
  await page.waitForTimeout(400);
  const frames = await stopLogging(page);

  const moves = jumps(frames, card);
  const worst = Math.max(...moves.map(Math.abs));
  const landed = frames.find((frame) => frame.rows > rows0);
  const before = landed ? frames[frames.indexOf(landed) - 1] : undefined;
  const topOf = (frame: Frame | undefined) => frame?.tops[card] ?? Number.NaN;
  const shape = reader instanceof SyntheticFinger ? `; events made as ${reader.shape}` : "";
  testInfo.annotations.push({
    type: "numbers",
    description: `${card}: ${frames.length} frames; worst card jump ${worst.toFixed(1)} px; rows while touching ${rowsWhileTouching} (was ${rows0}); landed ${landed ? Math.round(landed.t - liftedAt) : "never"} ms after the lift${shape}`,
  });
  console.log(testInfo.annotations.at(-1)?.description);
  if (process.env.SCROLL_JUMP_TRACE && landed) {
    const at = frames.indexOf(landed);
    for (const frame of frames.slice(Math.max(0, at - 6), at + 6)) {
      console.log(
        JSON.stringify({
          t: Math.round(frame.t - liftedAt),
          top: frame.tops[card],
          y: frame.y,
          by: frame.by,
          rows: frame.rows,
        }),
      );
    }
  }

  // Nothing came in under the finger, across the turn of the slot.
  expect(rowsWhileTouching, "Recent changes did not change while the finger was down").toBe(rows0);
  // Nor while the page was being scrolled: every frame up to the end of the gesture shows the rows it began with.
  expect(
    frames.filter((frame) => frame.t < liftedAt).every((frame) => frame.rows === rows0),
    "no row came in during the gesture",
  ).toBe(true);
  // And the card never moved on screen beyond the finger, a frame at a time.
  expect(worst, `the card jumped ${worst.toFixed(1)} px in a frame`).toBeLessThanOrEqual(1);
  // The update lands after the gesture, a moment after the page is still, with the card still where it was.
  expect(landed, "the check landed").toBeDefined();
  if (landed && before) {
    expect(landed.t, "the check lands after the lift").toBeGreaterThanOrEqual(liftedAt);
    // With no finger to wait for, it waits out the page's own stillness: 150 ms after the last scroll event.
    if (!touching) expect(landed.t - liftedAt, "the check waits for the page to be still").toBeGreaterThanOrEqual(100);
    expect(
      Math.abs(topOf(landed) - topOf(before)),
      "the card is where it was when the check landed",
    ).toBeLessThanOrEqual(1);
  }
}

test("floating bar: the board does not shift under a finger that scrolls across the turn of a slot", async ({
  page,
  isMobile,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== "chromium",
    "it drives a real touch drag through CDP, which only Chromium has (WebKit has the next test)",
  );
  test.skip(!isMobile && testInfo.project.name !== "tablet", "a finger is a touch project's");
  await acrossTheTurn(
    page,
    testInfo,
    async (viewport) => new Finger(await page.context().newCDPSession(page), viewport.width / 2),
    {
      touching: true,
    },
  );
});

test("floating bar: the board does not shift under touch events that come with a scroll across the turn of a slot", async ({
  page,
  hasTouch,
}, testInfo) => {
  test.skip(!hasTouch, "a finger is a touch project's");
  await acrossTheTurn(page, testInfo, (viewport) => new SyntheticFinger(page, viewport.width / 2), { touching: true });
});

test("floating bar: the board does not shift under a page that scrolls across the turn of a slot", async ({
  page,
  hasTouch,
}, testInfo) => {
  test.skip(!hasTouch, "the scrolling of a phone or a tablet, which a finger is not the only way to do");
  await acrossTheTurn(page, testInfo, (viewport) => new Scroller(page, viewport.width / 2), { touching: false });
});

test("floating bar: Recent changes holds the height of its first row on a first visit", async ({ page }) => {
  // Nothing saved: the load's own check is the first row, and the card reserved for "Waiting for the first check."
  // would grow by it a third of a second after hydration, pushing the whole board down.
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") await gate;
    await route.fallback();
  });
  let releaseBoard = () => {};
  const held = new Promise<void>((resolve) => {
    releaseBoard = resolve;
  });
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().method() === "GET") await held;
    await route.fallback();
  });
  await page.goto("/", { waitUntil: "commit" });
  const surface = page.locator('section[aria-labelledby="recent-heading"] .surface');
  await expect(surface).toBeVisible();
  await expect(feedRows(page)).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.load("400 15px Inter").catch(() => []);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const before = (await surface.boundingBox())?.height ?? 0;
  release();
  await hydrated(page);
  await expect(feedRows(page)).toHaveCount(1);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const after = (await surface.boundingBox())?.height ?? 0;
  releaseBoard();
  console.log(`first visit: reserved ${before} px, drawn ${after} px`);
  expect(Math.abs(before - after), `reserved ${before} px, drawn ${after} px`).toBeLessThanOrEqual(1);
});

test("floating bar: hidden below 64rem it keeps its blur layer, and can be neither focused nor clicked", async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 1024, "from 64rem the bar is sticky and drops its blur when hidden");
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await hydrated(page);
  const bar = page.locator('section[aria-label="Board controls"]');
  await expect(bar).toHaveAttribute("data-shown", "false");
  const look = () =>
    bar.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        blur: style.backdropFilter,
        opacity: style.opacity,
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        willChange: style.willChange,
        inert: element.hasAttribute("inert"),
        ariaHidden: element.getAttribute("aria-hidden"),
      };
    });
  const hidden = await look();
  expect(hidden.blur, "the hidden bar keeps its blur").toContain("blur(");
  expect(hidden.opacity).toBe("0");
  expect(hidden.visibility, "it is hidden by opacity, not visibility").toBe("visible");
  expect(hidden.pointerEvents).toBe("none");
  expect(hidden.willChange).toContain("opacity");
  expect(hidden.willChange).toContain("transform");
  expect(hidden.inert).toBe(true);
  expect(hidden.ariaHidden).toBe("true");

  // Not focusable: focus() on its Refresh button does nothing, and Tab from the top never lands in it.
  const focused = await bar.evaluate((element) => {
    const button = element.querySelector<HTMLElement>('button[aria-label="Refresh status now"]');
    button?.focus();
    return element.contains(document.activeElement);
  });
  expect(focused, "focus does not enter a hidden bar").toBe(false);
  for (let press = 0; press < 12; press++) {
    await page.keyboard.press("Tab");
    expect(await bar.evaluate((element) => element.contains(document.activeElement))).toBe(false);
  }

  // Not clickable: what is at the middle of its Refresh button is the page behind the bar.
  const covered = await bar.evaluate((element) => {
    const button = element.querySelector<HTMLElement>('button[aria-label="Refresh status now"]');
    const box = button?.getBoundingClientRect();
    if (!box) return null;
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  });
  expect(covered, "a click at the hidden bar's button reaches the page").toBe(false);

  // And the layer is the same layer through a show and a hide: no frame of either is without the blur.
  await page.evaluate(() => {
    const tracked = window as Window & { __blurless?: number; __watching?: boolean };
    tracked.__blurless = 0;
    tracked.__watching = true;
    const bar = document.querySelector('section[aria-label="Board controls"]');
    const frame = () => {
      if (!tracked.__watching) return;
      if (bar && !getComputedStyle(bar).backdropFilter.includes("blur("))
        tracked.__blurless = (tracked.__blurless ?? 0) + 1;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.locator("footer").scrollIntoViewIfNeeded();
  await expect(bar).toHaveAttribute("data-shown", "true");
  await expect.poll(async () => (await look()).opacity).toBe("1");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar).toHaveAttribute("data-shown", "false");
  await expect.poll(async () => (await look()).opacity).toBe("0");
  const blurless = await page.evaluate(() => {
    const tracked = window as Window & { __blurless?: number; __watching?: boolean };
    tracked.__watching = false;
    return tracked.__blurless;
  });
  expect(blurless, "frames without the blur across a show and a hide").toBe(0);
});
