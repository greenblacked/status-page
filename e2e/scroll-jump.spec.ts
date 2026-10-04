import type { CDPSession, Page } from "@playwright/test";
import { fixtureBoard, serveBoard } from "./fixture-board";
import { expect, test } from "./test";

// What a reader of an iPhone sees as "the bar jumps while scrolling": the bar itself is fixed and never moves, the
// page around it does. These tests drive real touch gestures (DevTools touch events, which the browser turns into
// a scroll like a finger does) and log the reader's card on every frame.

const SERVICES = 20;
const SLOT_MS = 120_000;
const cards = (page: Page) => page.locator('article[id^="service-"]');
const feedRows = (page: Page) => page.locator('section[aria-labelledby="recent-heading"] li');

async function hydrated(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
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

/** A finger on the glass: touch events over DevTools, one move every frame or so. */
class Finger {
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
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }
  async up() {
    await this.send("touchEnd", this.y);
  }
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

test("floating bar: the board does not shift under a finger that scrolls across the turn of a slot", async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(!isMobile && testInfo.project.name !== "tablet", "a finger is a touch project's");
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

  // The reader is on a card below Recent changes, with the finger on it.
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

  const cdp = await page.context().newCDPSession(page);
  const finger = new Finger(cdp, viewport.width / 2);
  await logFrames(page);
  await finger.down(viewport.height * 0.7);
  // About four and a half seconds of dragging, up and down so the card stays on screen, across the turn.
  const dragStart = Date.now();
  while (Date.now() - dragStart < 4_500) {
    await finger.dragBy(-90, 3);
    await finger.dragBy(90, 3);
  }
  // The finger rests a moment, still down, before it lifts: no scroll events, and still not the time to update.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const rowsWhileTouching = await page.evaluate(
    () => document.querySelectorAll('section[aria-labelledby="recent-heading"] li').length,
  );
  const liftedAt = await page.evaluate(() => performance.now());
  // The card the finger is on as it lifts: the one the reader is looking at.
  const card = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('article[id^="service-"]')?.id ?? "",
    [viewport.width / 2, finger.at],
  );
  expect(card, "the finger is on a card").not.toBe("");
  await finger.up();
  // The check lands once the page is still.
  await expect.poll(() => feedRows(page).count(), { timeout: 5_000 }).toBeGreaterThan(rows0);
  await page.waitForTimeout(400);
  const frames = await stopLogging(page);

  const moves = jumps(frames, card);
  const worst = Math.max(...moves.map(Math.abs));
  const landed = frames.find((frame) => frame.rows > rows0);
  const before = landed ? frames[frames.indexOf(landed) - 1] : undefined;
  const topOf = (frame: Frame | undefined) => frame?.tops[card] ?? Number.NaN;
  testInfo.annotations.push({
    type: "numbers",
    description: `${card}: ${frames.length} frames; worst card jump ${worst.toFixed(1)} px; rows while touching ${rowsWhileTouching} (was ${rows0}); landed ${landed ? Math.round(landed.t - liftedAt) : "never"} ms after the lift`,
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
    expect(
      Math.abs(topOf(landed) - topOf(before)),
      "the card is where it was when the check landed",
    ).toBeLessThanOrEqual(1);
  }
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
