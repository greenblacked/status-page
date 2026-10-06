import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { SETTLE_MS } from "../src/lib/status/page-motion.ts";
import { fixtureBoard, serveBoard } from "./fixture-board";
import { barBack, isPhone } from "./support/layout";
import { pinToSlot } from "./support/pin-to-slot";
import { expect, test } from "./test";

// What a reader of an iPhone sees as "the bar jumps while scrolling": the bar itself is fixed and never moves, the
// page around it does. These tests move a reader over the board and log the reader's card on every frame: a real
// touch drag (DevTools touch events, which the browser turns into a scroll like a finger does) on Chromium, touch
// events made in the page with the page scrolled a step at a time on every touch project, and scroll steps alone.

const SERVICES = 20;
const SLOT_MS = 120_000;
const cards = (page: Page) => page.locator('article[id^="service-"]');
const feedRows = (page: Page) => page.locator('section[aria-labelledby="recent-heading"] li');

/** As in board.spec.ts: data-hydrated waits for the saved checks, a few renders after the first, so 15 s on a loaded runner. */
async function hydrated(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
}

type Frame = {
  t: number;
  tops: Record<string, number>;
  y: number;
  rows: number;
  by: number;
  reader: number;
  /** Which element the "mouse" top is of, and what it is, once the mouse is on the board (see `watchMouseArrival`). */
  mouseId?: number;
  piece?: string;
};

/** What `watchMouseArrival` leaves in the page for the frames to follow: the piece the mouse is over, until the update lands. */
type HeldPiece = {
  rows0: number;
  /** Whether a real mouse has reached the place after the finger lifted. */
  on: boolean;
  /** Whether the update has landed: the piece is what was held, and is not picked again. */
  landed: boolean;
  id?: number;
  piece?: string;
  pick(): void;
};

/**
 * Logs the cards on every frame: the top in the window of each one in view, the scroll position, how many rows
 * Recent changes has, how far the page has scrolled itself by (window.scrollBy, which is how the page keeps a
 * place) and how far the reader has scrolled it (for the readers that scroll it from the page).
 */
async function logFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tracked = window as Window & {
      __frames?: Frame[];
      __logging?: boolean;
      __by?: number;
      __reader?: number;
      __held?: HeldPiece;
    };
    tracked.__frames = [];
    tracked.__logging = true;
    const rows = () => document.querySelectorAll('section[aria-labelledby="recent-heading"] li').length;
    const frame = () => {
      if (!tracked.__logging) return;
      // The piece under a mouse that has reached the board is picked again on every frame until the update lands:
      // the page picks what it holds right before it, so the last frame before the landing says which it is.
      const held = tracked.__held;
      if (held?.on && !held.landed) {
        if (rows() > held.rows0) held.landed = true;
        else held.pick();
      }
      tracked.__frames?.push({
        t: performance.now(),
        tops: Object.fromEntries([
          ...Array.from(document.querySelectorAll('article[id^="service-"]'), (card) => [
            card.id,
            card.getBoundingClientRect().top,
          ]),
          // The piece of the board a mouse is over, where a test marks it (see `findMousePlace`).
          ...Array.from(document.querySelectorAll("[data-mouse-piece]"), (piece) => [
            "mouse",
            piece.getBoundingClientRect().top,
          ]),
          // What the reader is looking at, where a test marks it (see the glide in `acrossTheTurn`).
          ...Array.from(document.querySelectorAll("[data-probe]"), (probe) => [
            "probe",
            probe.getBoundingClientRect().top,
          ]),
        ]),
        y: window.scrollY,
        rows: rows(),
        by: tracked.__by ?? 0,
        reader: tracked.__reader ?? 0,
        mouseId: held?.on ? held.id : undefined,
        piece: held?.on ? held.piece : undefined,
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
 * Something that moves the page the way a reader does. `down`, `gesture` and `up` are a finger's: the page moves with
 * it, so the card under it stays under it. `at` is where, on the screen, the reader's attention is.
 */
interface Reader {
  readonly at: number;
  /** When, in the page's clock, the page was last scrolled by the reader (a finger that rests has no such moment). */
  readonly movedAt?: number;
  /** Whether the reader says how far it has scrolled the page (`window.__reader`), so a frame can be judged on what is on screen. */
  readonly accounted: boolean;
  /** What the last `gesture` did, for a reader that makes the whole gesture inside the page. */
  readonly swept?: Sweep;
  down(y: number): Promise<void>;
  /** The gesture: about `ms` of dragging, up and down so the card stays on screen. */
  gesture(ms: number): Promise<void>;
  up(): Promise<void>;
}

/** What a gesture made inside the page did, in the page's clock. */
type Sweep = {
  /** Where the finger ended, in the window (a reader with no finger leaves it where it was). */
  y: number;
  /** When the last step was taken. */
  lastStepAt: number;
  /** The scroll events the page sent during the gesture. */
  events: number;
  /** The longest time, in ms, between two of them, and when (in the page's clock) it began and ended. */
  longestGap: number;
  gapStartedAt: number;
  gapEndedAt: number;
  /**
   * A flick: the longest gap between two scroll events that began at or after the lift, which is the only kind that lets
   * the board's wait run out (a gap during the drag is held by the finger), however long the longest gap overall was.
   */
  glideGap?: { length: number; startedAt: number; endedAt: number };
  /** When the gesture began. */
  startedAt: number;
  /** What the last touch event was made of ("TouchEvent" or "Event"), for a finger. */
  shape: string;
  /** A flick: what the page was when the finger lifted, read in the page at that moment. */
  lifted?: {
    /** In the page's clock (`performance.now()`), and by its `Date.now()`. */
    at: number;
    date: number;
    /** The rows of Recent changes, and the card under the finger ("" for none). */
    rows: number;
    card: string;
  };
  /** A flick: whether something was marked `data-probe` where the finger is, once the glide was over. */
  probed?: boolean;
};

/** The px of a step of the sweep, and the steps it runs one way before it turns (see `sweep`). */
const SWEEP_STEP = 3;
const SWEEP_RUN = 30;
/** How far, in px, the sweep takes the page from where it began, either way: the page is never further than this. */
const SWEEP_REACH = SWEEP_STEP * SWEEP_RUN;

/**
 * The whole gesture, driven from inside the page: one step of `STEP` px on every animation frame, alternating
 * `RUN` steps one way and `RUN` the other, for `ms`. Steps driven from the test process (a round trip and a pause
 * for each) are as far apart as the runner lets them be, and a page that has not scrolled for `SETTLE_MS` is at
 * rest as far as the board is concerned, so on a loaded machine the update lands in the middle of the gesture. A
 * loop in the page takes the test process out of the steps: they are a frame apart for as long as the page's own
 * main thread keeps up (the page clock is Playwright's, so after a stall of the page the steps that came due run
 * back to back, and the gap shows in the scroll events). `finger` makes a touchmove (with `__pad`, see
 * SyntheticFinger) before each step, the page following the finger as the browser would.
 *
 * `flick` goes on from the finger's `ms` to the glide of a flick, in the same loop: a frame after the last move
 * the finger lifts (its touchend), with the page still moving and the scroll event of that last step just sent,
 * and the page glides on without it for `glide` ms. A lift that came after a round trip to the test process would
 * have no scroll event within `SETTLE_MS` before it on a loaded machine, and a page that has not scrolled for that
 * long is at rest as far as the board is concerned. What the test needs of the lift is read in the page at that
 * moment (`lifted`), and what the reader is on, once the glide is over, is marked `data-probe` before anything
 * else can run (`probed`). Between two cards it is the card below the finger.
 */
async function sweep(
  page: Page,
  { ms, finger, y, flick }: { ms: number; finger: boolean; y: number; flick?: { glide: number; x: number } },
): Promise<Sweep> {
  return page.evaluate(
    ({ ms, finger, y, flick, STEP, RUN }) =>
      new Promise<Sweep>((resolve) => {
        const tracked = window as Window & {
          __reader?: number;
          __pad?: { fire: (type: string, y: number, live: boolean) => string };
        };
        const seen: number[] = [];
        const onScroll = () => seen.push(performance.now());
        window.addEventListener("scroll", onScroll, { passive: true });
        const start = performance.now();
        let at = y;
        let shape = "";
        let steps = 0;
        let lastStepAt = start;
        let lifted: Sweep["lifted"];
        let probed: boolean | undefined;
        let over = start + ms;
        let moving = finger;
        const frame = () => {
          if (flick && !lifted && performance.now() >= over) {
            // As in a flick: the finger lifts with the page still moving, and no rest for the board to take.
            tracked.__pad?.fire("touchend", at, false);
            const under = document.elementFromPoint(flick.x, at);
            lifted = {
              at: performance.now(),
              date: Date.now(),
              rows: document.querySelectorAll('section[aria-labelledby="recent-heading"] li').length,
              card: under?.closest('article[id^="service-"]')?.id ?? "",
            };
            moving = false;
            over = lifted.at + flick.glide;
            // For a test that does something of its own in the glide (a real mouse move), which it waits for this to do.
            (window as Window & { __lifted?: boolean }).__lifted = true;
          }
          if (performance.now() >= over) {
            if (flick) {
              // What the page moved under the finger as it glided is what the reader is on now, which the board
              // holds, and not the card the gesture began on. Marked here, with the last step's scroll event just
              // sent, a hundred and fifty ms short of the update.
              const under = document.elementFromPoint(flick.x, at);
              const cards = [...document.querySelectorAll('article[id^="service-"]')];
              const probe = under?.closest("article") ? under : cards.find((c) => c.getBoundingClientRect().top >= at);
              probe?.setAttribute("data-probe", "");
              probed = Boolean(probe);
            }
            // One frame more, for the scroll event of the last step.
            requestAnimationFrame(() => {
              window.removeEventListener("scroll", onScroll);
              let longestGap = 0;
              let gapStartedAt = start;
              let gapEndedAt = start;
              for (let i = 1; i < seen.length; i++) {
                if (seen[i] - seen[i - 1] > longestGap) {
                  longestGap = seen[i] - seen[i - 1];
                  gapStartedAt = seen[i - 1];
                  gapEndedAt = seen[i];
                }
              }
              // The same, among the gaps that began once the finger had lifted.
              let glideGap: Sweep["glideGap"];
              if (lifted) {
                glideGap = { length: 0, startedAt: lifted.at, endedAt: lifted.at };
                for (let i = 1; i < seen.length; i++) {
                  if (seen[i - 1] >= lifted.at && seen[i] - seen[i - 1] > glideGap.length) {
                    glideGap = { length: seen[i] - seen[i - 1], startedAt: seen[i - 1], endedAt: seen[i] };
                  }
                }
              }
              resolve({
                y: at,
                lastStepAt,
                events: seen.length,
                longestGap,
                gapStartedAt,
                gapEndedAt,
                glideGap,
                startedAt: start,
                shape,
                lifted,
                probed,
              });
            });
            return;
          }
          // A finger that moves up (negative) takes the page down with it.
          const by = (Math.floor(steps++ / RUN) % 2 === 0 ? -1 : 1) * STEP;
          const from = window.scrollY;
          let to = from - by;
          if (moving) {
            at += by;
            shape = tracked.__pad?.fire("touchmove", at, true) ?? shape;
          } else {
            // Turned back at either end of the page: a step that goes nowhere sends no scroll event, and a page that
            // has stopped sending them is at rest.
            const room = document.documentElement.scrollHeight - window.innerHeight;
            if (to < 0 || to > room) to = from + by;
          }
          window.scrollTo({ top: to, behavior: "instant" });
          tracked.__reader = (tracked.__reader ?? 0) + window.scrollY - from;
          lastStepAt = performance.now();
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    { ms, finger, y, flick, STEP: SWEEP_STEP, RUN: SWEEP_RUN },
  );
}

/** The time, in ms, a frame that saw something may be later than the thing it saw. */
const FRAME_SLACK_MS = 50;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A finger on the glass: touch events over DevTools, one move every frame or so. Chromium only. */
class Finger implements Reader {
  readonly accounted = false;
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
  private async dragBy(dy: number, step: number) {
    const steps = Math.max(1, Math.round(Math.abs(dy) / step));
    for (let i = 0; i < steps; i++) {
      this.y += dy / steps;
      await this.send("touchMove", this.y);
      await pause(16);
    }
  }
  /** Driven from here, one touch event at a time: the browser turns them into the scroll, and a finger that is down holds the board whatever the gaps. */
  async gesture(ms: number) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      await this.dragBy(-90, 3);
      await this.dragBy(90, 3);
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
 * would. A real TouchEvent where the engine has the constructors (Chromium with touch emulation); where it has not
 * (WebKit has no `Touch` constructor), a plain event with the same `touches`, which is all the page reads of it.
 */
class SyntheticFinger implements Reader {
  readonly accounted = true;
  private y = 0;
  /** "TouchEvent" or "Event": what the last event was made of. */
  shape = "";
  swept?: Sweep;
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
  /** A touchmove and a step of the page on every frame, all inside the page (see `sweep`). */
  async gesture(ms: number) {
    this.swept = await sweep(this.page, { ms, finger: true, y: this.y });
    this.y = this.swept.y;
    this.shape = this.swept.shape || this.shape;
  }
  async up() {
    await this.fire("touchend", this.y);
  }
  /**
   * The gesture and then the lift of a flick, in one go inside the page: the finger drags for `ms`, lifts a frame
   * after its last move, and the page glides on without it for `glide` ms (see `sweep`).
   */
  async flick(ms: number, glide: number) {
    this.swept = await sweep(this.page, { ms, finger: true, y: this.y, flick: { glide, x: this.x } });
    this.y = this.swept.y;
    this.shape = this.swept.shape || this.shape;
  }
}

/**
 * No finger: the page scrolled a step at a time (a wheel, the glide of a flick), which is scroll events alone, with
 * a mouse resting on the card the reader is on.
 */
class Scroller implements Reader {
  readonly accounted = true;
  private y = 0;
  /** When, in the page's clock, the page was last scrolled. */
  movedAt = 0;
  swept?: Sweep;
  get at() {
    return this.y;
  }
  constructor(
    private readonly page: Page,
    private readonly x: number,
  ) {}
  async down(y: number) {
    this.y = y;
    // The engine's own mouse goes to the card, not only a pointermove made in the page: an engine reports the mouse
    // again as the page scrolls (WebKit does, at wherever it last was, such as the Refresh button that was clicked
    // to get here), so a mouse left elsewhere would be the newest thing the page heard of.
    await this.page.mouse.move(this.x, y);
    // And the same move made in the page, for an engine whose mouse does not reach it (touch emulation).
    await this.page.evaluate(
      ([x, y]) => {
        const target = document.elementFromPoint(x, y) ?? document.body;
        const init = { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y };
        target.dispatchEvent(new PointerEvent("pointermove", { ...init, bubbles: true, composed: true }));
      },
      [this.x, y],
    );
  }
  /** A step of the page on every frame, all inside the page (see `sweep`). */
  async gesture(ms: number) {
    this.swept = await sweep(this.page, { ms, finger: false, y: this.y });
    this.movedAt = this.swept.lastStepAt;
  }
  async up() {}
}

/** Where a mouse can be left over the board: a window place over a piece of it that a new row does not move. */
type MousePlace = { x: number; y: number; piece: string };

/**
 * How far down the window the floating bar can reach, in px, and a slide's worth more. Below 64rem the bar is fixed
 * at the top of the window, and its Refresh button is the rightmost thing in it, where a mouse place is. A bar that
 * is hidden does not take a pointer, a bar that is up does, and one that is sliding in (it rises 8 px) is where it
 * is only part way. So the top of the window, as far down as the bar's lowest pose (from its layout, as a transform
 * does not move it, and from where it is now) and 8 px more, is out for a place: one there is over the board only at
 * the instant it was found, as the rounded corner of the bar and the Refresh button's leave the point uncovered by a
 * pixel.
 */
async function barClearance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('section[aria-label="Board controls"]');
    const box = bar?.getBoundingClientRect();
    const style = bar ? getComputedStyle(bar) : null;
    const fixed = style?.position === "fixed" ? Number.parseFloat(style.top) + (box?.height ?? 0) : 0;
    return Math.max(box?.bottom ?? 0, fixed) + 8;
  });
}

/** What is left above Recent changes, past the bar and the sweep's reach, for the search to try a few places in: px. */
const ROOM_ABOVE_FEED = 24;

/**
 * For a mouse over the board, the card the reader is on is the first one after Recent changes, with the row and a
 * stretch of the board above it in view for the mouse to be over, as in WebKit's layout of the same page. The page
 * is first put where the card is `at` px from the top of the window. On a short screen that leaves the row too close
 * to the top (an iPhone 17 Pro's 681 px puts it 141 px down, with 64 px of the bar and 90 px of the sweep to fit
 * above it), so the page then goes back by what is missing: the place is clear of the bar, which cannot move, and the
 * room is made for it by the page. Returns the top of that card, for the finger to be put on it.
 */
async function showBoardAboveFeed(page: Page, cardAt: number): Promise<number> {
  const clear = await barClearance(page);
  return page.evaluate(
    ([cardAt, clear, reach, margin]) => {
      const feed = document.querySelector('section[aria-labelledby="recent-heading"]');
      const card = [...document.querySelectorAll('article[id^="service-"]')].find(
        (c) => feed && feed.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      if (!feed || !card) return Number.NaN;
      window.scrollBy(0, card.getBoundingClientRect().top - cardAt);
      const missing = clear + reach + margin - feed.getBoundingClientRect().top;
      if (missing > 0) window.scrollBy(0, -missing);
      return card.getBoundingClientRect().top;
    },
    [cardAt, clear, SWEEP_REACH, ROOM_ABOVE_FEED] as const,
  );
}

/**
 * A place near the right-hand edge of the board, over a piece that keeps its place when a row comes into Recent
 * changes: one that comes before the row (a card above it, the "Needs a look" panel), as it did in WebKit. A page
 * that takes the newest pointer it heard of for the reader, whatever the finger did, holds that piece and lets the
 * card below the row drop. The piece is marked `data-mouse-piece`, for the frames to follow.
 *
 * The place is fixed in the window while the page is not, so it has to stay over such a piece wherever the sweep
 * takes the page and whatever the floating bar is doing:
 * - clear of the bar (`barClearance`).
 * - and far enough above the row for the sweep's reach (`SWEEP_REACH`). The sweep only takes the content up from
 *   where it began, so what is at the place later is what was further down then, up to a reach, and the row is what
 *   must not get there. What is above the place does not matter: the board's top is not a bound.
 */
async function findMousePlace(page: Page): Promise<MousePlace> {
  const clear = await barClearance(page);
  const place = await page.evaluate(
    ([clear, reach]) => {
      const feed = document.querySelector('section[aria-labelledby="recent-heading"]');
      const board = document.getElementById("services");
      if (!feed || !board) return null;
      const x = board.getBoundingClientRect().right - 12;
      // What a mouse can be left over (kept for `watchMouseArrival`, which asks it of whatever is under the mouse then).
      const isPiece = (target: Element | null): boolean => {
        if (!target || target === board || !board.contains(target) || target.contains(feed)) return false;
        return Boolean(feed.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING);
      };
      (window as Window & { __isPiece?: typeof isPiece }).__isPiece = isPiece;
      const to = Math.min(feed.getBoundingClientRect().top - reach, window.innerHeight);
      for (let y = Math.ceil(clear / 8) * 8; y < to; y += 8) {
        const target = document.elementFromPoint(x, y);
        if (!target || !isPiece(target)) continue;
        target.setAttribute("data-mouse-piece", "");
        return { x, y, piece: `${target.tagName} at ${Math.round(x)},${y}` };
      }
      return null;
    },
    [clear, SWEEP_REACH] as const,
  );
  expect(place, "a mouse can be left over a piece of the board that a new row does not move").not.toBeNull();
  return place as MousePlace;
}

/**
 * The reader's hand on the mouse, for a test whose mouse moves after the finger has lifted. A real mouse (a trusted
 * pointermove) first reaching `place` after the lift is kept in `__mouseOnAt`, in the page's clock. From then on the
 * piece of the board under the mouse is picked on every frame (and marked `data-mouse-piece`, with `mouseId` and
 * `piece` on the frame) until the update lands, as the page picks what it holds right before it: the element at the
 * mouse's place, whatever the glide has put there, so the piece judged is the one that is held and not one chosen
 * before the gesture. It is left unmarked on a frame where what is under the mouse is not a piece a new row does not
 * move (see `findMousePlace`), which the test then reports.
 */
async function watchMouseArrival(page: Page, place: MousePlace, rows0: number): Promise<void> {
  await page.evaluate(
    ([x, y, rows0]) => {
      const tracked = window as Window & {
        __lifted?: boolean;
        __mouseOnAt?: number;
        __mouseMoves?: string[];
        __isPiece?: (target: Element | null) => boolean;
        __held?: HeldPiece;
      };
      const ids = new WeakMap<Element, number>();
      let issued = 0;
      const held: HeldPiece = {
        rows0: rows0 as number,
        on: false,
        landed: false,
        pick() {
          const under = document.elementFromPoint(x as number, y as number);
          const piece = tracked.__isPiece?.(under) ? under : null;
          for (const old of document.querySelectorAll("[data-mouse-piece]")) {
            if (old !== piece) old.removeAttribute("data-mouse-piece");
          }
          if (!piece) {
            held.id = undefined;
            held.piece = under ? `${under.tagName}${under.id ? `#${under.id}` : ""}.${under.className}` : "nothing";
            return;
          }
          piece.setAttribute("data-mouse-piece", "");
          if (!ids.has(piece)) ids.set(piece, ++issued);
          held.id = ids.get(piece);
          held.piece = `${piece.tagName}${piece.id ? `#${piece.id}` : ""}.${piece.className}`;
        },
      };
      tracked.__held = held;
      document.addEventListener(
        "pointermove",
        (event) => {
          if (!event.isTrusted || event.pointerType !== "mouse" || !tracked.__lifted) return;
          // What each move said of itself, for a run where the page took none of them for the mouse moving.
          tracked.__mouseMoves = tracked.__mouseMoves ?? [];
          tracked.__mouseMoves.push(
            `${Math.round(event.clientX)},${Math.round(event.clientY)} by ${event.movementX},${event.movementY}`,
          );
          if (Math.abs(event.clientX - (x as number)) > 1 || Math.abs(event.clientY - (y as number)) > 1) return;
          tracked.__mouseOnAt ??= performance.now();
          held.on = true;
        },
        { capture: true },
      );
    },
    [place.x, place.y, rows0],
  );
}

/**
 * The engine's own mouse left at `place`, as a click on Refresh leaves it, with no pointerup or pointerleave to say it
 * went, and reported again as the page scrolls, as WebKit does: a pointermove and a mousemove at the cursor's own
 * place after every scroll event, which say that the mouse did not move (no movement, the same place on the
 * screen). The cursor is where the engine has it, and what is replayed is read from the engine's last report of
 * it, so the page is told what a device would tell it. A browser whose mouse does not reach the page (touch
 * emulation) gets the same move made in the page.
 *
 * `fake` goes on to what WebKit also does a moment after a page has scrolled, to update what is hovered: a pointermove
 * and a mousemove 100 ms after the last scroll event, at a window place that the page did not see the mouse at (over
 * another piece of the board that a new row does not move), though the cursor has not moved on the screen: no
 * movement, and the same place on the screen as the last report (a fixed, real one where the engine's reports have
 * none: they are 0,0 on every move made by automation under WebKit; after a wheel the engine's own reports carry a real
 * screen place, screen = client). The page makes them itself (a script cannot send a
 * trusted event), so what the product tells them by must be what they say, not that they are trusted. The times they
 * were made at are kept in `__fakedAt`, to know they came before the update landed.
 */
async function leaveMouse(page: Page, place: MousePlace, { fake }: { fake: boolean }): Promise<void> {
  await page.evaluate(() => {
    const tracked = window as Window & { __cursor?: Record<string, number> | null };
    tracked.__cursor = null;
    document.addEventListener(
      "pointermove",
      (event) => {
        if (event.isTrusted && event.pointerType === "mouse") {
          tracked.__cursor = { x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY };
        }
      },
      { capture: true },
    );
  });
  await page.mouse.move(place.x, place.y);
  await page.evaluate(
    ([x, y, fake]) => {
      const tracked = window as Window & { __cursor?: Record<string, number> | null; __fakedAt?: number[] };
      const piece = document.querySelector("[data-mouse-piece]") ?? document.body;
      const fire = (target: Element, at: { x: number; y: number }, screen: { x: number; y: number }, moved: number) => {
        const init = {
          clientX: at.x,
          clientY: at.y,
          screenX: screen.x,
          screenY: screen.y,
          movementX: moved,
          movementY: moved,
          bubbles: true,
          composed: true,
        };
        target.dispatchEvent(
          new PointerEvent("pointermove", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }),
        );
        target.dispatchEvent(new MouseEvent("mousemove", init));
      };
      // The mouse did not reach the page: it is made there, as a move (it has come from somewhere).
      if (!tracked.__cursor) {
        tracked.__cursor = {
          x: x as number,
          y: y as number,
          screenX: window.screenX + (x as number),
          screenY: window.screenY + (y as number),
        };
        fire(
          piece,
          { x: x as number, y: y as number },
          { x: tracked.__cursor.screenX, y: tracked.__cursor.screenY },
          1,
        );
      }
      const cursor = () => tracked.__cursor as Record<string, number>;
      const feed = document.querySelector('section[aria-labelledby="recent-heading"]');
      const board = document.getElementById("services");
      // Another piece of the board that a new row does not move, at least 4 px from the cursor, as it is at the time.
      const elsewhere = () => {
        const { x, y } = cursor();
        for (let at = 0; at < window.innerHeight; at += 2) {
          const target = document.elementFromPoint(x - 2, at);
          if (Math.abs(at - y) < 4 || !target || !feed || !board || target === board || !board.contains(target))
            continue;
          if (target.contains(feed) || !(feed.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING))
            continue;
          return { target, at: { x: x - 2, y: at } };
        }
        return { target: piece, at: { x: x + 2, y: y + 14 } };
      };
      // The same place on the screen for every such report, and a real one: where the engine gives none (WebKit puts
      // 0,0 on every move made by automation) a move and this look alike in what the event says, so the made report
      // stands for a device that has one, as it would on a Mac. The place is the one the engine itself gives for that
      // cursor (the window's place on the screen + the client place). The first made report is turned away because no
      // real screen place came before it; the later ones by being at the same screen place.
      let fakeScreen: { x: number; y: number } | null = null;
      const screenOfFake = () => {
        const { x, y, screenX, screenY } = cursor();
        fakeScreen ??=
          screenX !== 0 || screenY !== 0
            ? { x: screenX, y: screenY }
            : { x: window.screenX + x, y: window.screenY + y };
        return fakeScreen;
      };
      let timer = 0;
      window.addEventListener(
        "scroll",
        () => {
          const { x, y, screenX, screenY } = cursor();
          fire(piece, { x, y }, { x: screenX, y: screenY }, 0);
          if (!fake) return;
          clearTimeout(timer);
          timer = window.setTimeout(() => {
            const { target, at } = elsewhere();
            fire(target, at, screenOfFake(), 0);
            tracked.__fakedAt = [...(tracked.__fakedAt ?? []), performance.now()];
          }, 100);
        },
        { passive: true },
      );
    },
    [place.x, place.y, fake],
  );
}

/**
 * The distance, in px, a frame moved the card on screen beyond what the reader's own scroll accounts for.
 *
 * A reader that says how far it scrolled the page (`accounted`) is judged on what is on screen: the card's top,
 * plus the reader's scroll in that frame. Whoever held the place, the page with `scrollBy` or the browser with its
 * own scroll anchoring, leaves that at 0, and a card that the layout pushed down by a row and nobody held shows as
 * the row. A reader that does not (a real touch drag over DevTools) is judged on the card's place on the page, less
 * what the page scrolled itself by, which counts the page's `scrollBy` only: the run of it has no scroll anchoring.
 */
function jumps(frames: Frame[], card: string, accounted: boolean): number[] {
  return jumpsBetween(frames, card, accounted).map((jump) => jump.move);
}

/** A frame's move of the card (see `jumps`), with the two frames it was measured between. */
type Jump = { move: number; from: Frame; to: Frame };

function jumpsBetween(frames: Frame[], card: string, accounted: boolean): Jump[] {
  const out: Jump[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const [from, to] = [a.tops[card], b.tops[card]];
    if (from === undefined || to === undefined) continue;
    // The piece under the mouse is a different element when the mouse is over another: no move of one to the other.
    if (card === "mouse" && a.mouseId !== b.mouseId) continue;
    out.push({
      move: accounted ? to - from + (b.reader - a.reader) : to + b.y - (from + a.y) - (b.by - a.by),
      from: a,
      to: b,
    });
  }
  return out;
}

/** A flick (see `SyntheticFinger.flick`), and what the page read as the finger lifted. */
async function flick(reader: SyntheticFinger, glide: number): Promise<NonNullable<Sweep["lifted"]>> {
  await reader.flick(4_500, glide);
  const lifted = reader.swept?.lifted;
  if (!lifted) throw new Error("the finger did not lift");
  return lifted;
}

/**
 * The reader is on a card below Recent changes. Two and a half seconds before the board's check at the turn of a
 * slot, `reader` starts to move the page, for about four and a half seconds, so the turn falls inside the gesture.
 * Then it stops (a finger rests, still down, for a moment and lifts), and the check must land after, with the card
 * the reader is on where it was.
 *
 * `touching` is whether `reader` is a finger: Recent changes must not change while it is down, even while it rests.
 *
 * `anchoring` is what the browser does about scroll anchoring, which holds the place by itself where it works:
 * - "off": the page's rule switches it off (`overflow-anchor: none`), as on a browser that has none, so only the
 *   page's own scroll can hold the card;
 * - "claimed": the browser says it anchors (the property is supported and the page asks for it) but does not,
 *   here, because the board is out of its reach. Only the page's own scroll can hold the card, as in "off", and a
 *   page that takes the browser's word for it is wrong;
 * - "native": the browser does as it does, with nothing switched off.
 *
 * `strayMouse` leaves the engine's mouse over the board above Recent changes before the gesture, and reports it again
 * as the page scrolls (see `leaveMouse`); `fakeMove` adds the report WebKit makes once the page has scrolled, at a
 * place of the cursor that the page had not seen it at, with no move. Neither is the reader acting: the card under
 * the finger must stay put. `mouseMoves` is the other way round: a real mouse move (with steps, so it has movement)
 * onto that board after the finger lifts, which is the reader acting, so what the mouse is over is held and the
 * card, which no longer is, drops by the row. It needs a flick, for the glide to move the mouse in.
 */
async function acrossTheTurn(
  page: Page,
  testInfo: TestInfo,
  makeReader: (viewport: { width: number; height: number }) => Promise<Reader> | Reader,
  {
    touching,
    anchoring = "off",
    strayMouse = false,
    fakeMove = false,
    mouseMoves = false,
    glide = 0,
  }: {
    touching: boolean;
    anchoring?: "off" | "claimed" | "native";
    strayMouse?: boolean;
    fakeMove?: boolean;
    mouseMoves?: boolean;
    glide?: number;
  },
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
  if (anchoring === "off") {
    // Safari has no scroll anchoring, and the page cannot lean on it.
    await page.addStyleTag({ content: "html, body { overflow-anchor: none !important; }" });
  } else if (anchoring === "claimed") {
    // The document asks for anchoring, and the browser supports the property, so the page is told it is held. The
    // body is out of the browser's reach (an element that is not a candidate takes its whole subtree with it).
    await page.addStyleTag({
      content: "html { overflow-anchor: auto !important; } body { overflow-anchor: none !important; }",
    });
    // Whether the browser reflects the property at all is noted, not required: a browser that does not (or whose
    // computed value is "none" under the rule above) is the "off" case, and the card must be held there too.
    const says = await page.evaluate(
      () =>
        CSS.supports("overflow-anchor", "auto") && getComputedStyle(document.documentElement).overflowAnchor === "auto",
    );
    testInfo.annotations.push({ type: "claims anchoring", description: String(says) });
  }

  // The reader is on a card below Recent changes.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  // With a mouse over the board, the card is the first one after Recent changes, with the row and the board
  // above it in view for the mouse to be over (see `showBoardAboveFeed`).
  const overBoard = strayMouse || mouseMoves;
  let readerAt = viewport.height * 0.7;
  if (overBoard) {
    const cardTop = await showBoardAboveFeed(page, viewport.height * 0.66);
    // The finger is on the card, a little way in, wherever the room above the row put it.
    readerAt = Math.max(readerAt, cardTop + 24);
    expect(readerAt, "the reader's card is on screen under the finger").toBeLessThan(viewport.height - 8);
  } else {
    await page.evaluate(
      ([id, at]) => {
        const next = document.getElementById(id as string);
        if (next) window.scrollBy(0, next.getBoundingClientRect().top - (at as number));
      },
      ["service-spotify", viewport.height * 0.6],
    );
  }
  const rows0 = await feedRows(page).count();

  // Two and a half seconds before the board's check at the turn of a slot.
  const msToTurn = await page.evaluate((slot) => slot - (Date.now() % slot), SLOT_MS);
  await page.clock.fastForward(Math.max(0, msToTurn - 2_500));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(await feedRows(page).count(), "the turn has not come yet").toBe(rows0);

  const reader = await makeReader(viewport);
  await logFrames(page);
  // A mouse that moves after the lift comes from far off. It is not left where the Refresh click put it, a few px from
  // the place: WebKit reports an unmoved cursor again as the page glides, and the page tells that from a move by its
  // window place, so a move of 1 or 2 px would be taken for it (and the arrival, within 1 px of the place, would be
  // counted for the old cursor's reports).
  const park = { x: 4, y: viewport.height - 4 };
  if (mouseMoves) await page.mouse.move(park.x, park.y);
  const place = overBoard ? await findMousePlace(page) : undefined;
  if (place && mouseMoves) {
    expect(
      Math.hypot(place.x - park.x, place.y - park.y),
      "the real mouse move covers a distance the page can tell from a re-report of the cursor",
    ).toBeGreaterThan(50);
  }
  if (place && strayMouse) await leaveMouse(page, place, { fake: fakeMove });
  if (place && mouseMoves) await watchMouseArrival(page, place, rows0);
  const stray = strayMouse && place ? place.piece : "";
  await reader.down(readerAt);
  const downAt = await page.evaluate(() => Date.now());
  expect(await feedRows(page).count(), "the turn had not come when the reader started").toBe(rows0);
  // About four and a half seconds of dragging, up and down so the card stays on screen, across the turn.
  // A flick is the whole of it in the page, the lift included: a finger that lifts a few round trips after the last
  // scroll has rested, as far as the board can tell, and the update lands before the page glides on.
  const flicking = glide > 0 && reader instanceof SyntheticFinger ? flick(reader, glide) : undefined;
  if (flicking && mouseMoves && place) {
    // The finger has lifted and the page glides on: the reader puts a hand on the mouse, a real move of it.
    await page.waitForFunction(() => (window as Window & { __lifted?: boolean }).__lifted === true, null, {
      polling: "raf",
    });
    await page.mouse.move(place.x, place.y, { steps: 5 });
  }
  const flicked = await flicking;
  if (!flicked) await reader.gesture(4_500);
  let rowsWhileTouching = rows0;
  if (touching && !flicked) {
    // The finger rests a moment, still down, before it lifts: no scroll events, and still not the time to update.
    await pause(400);
    rowsWhileTouching = await feedRows(page).count();
  }
  if (flicked) rowsWhileTouching = flicked.rows;
  // Where the gesture ends, in the page's clock: the lift of a finger, else the last scroll step.
  const liftedAt = flicked
    ? flicked.at
    : touching
      ? await page.evaluate(() => performance.now())
      : (reader.movedAt ?? Number.NaN);
  // The card the reader is on as the gesture ends: the one they are looking at.
  let card =
    flicked?.card ??
    (await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('article[id^="service-"]')?.id ?? "",
      [viewport.width / 2, reader.at],
    ));
  expect(card, "the reader is on a card").not.toBe("");
  const upAt = flicked ? flicked.date : await page.evaluate(() => Date.now());
  if (flicked) {
    // The page moved under the finger as it glided. What the reader is on now is what is under it, which the page
    // holds, and not the card it began on: a tag cleared higher up in the same card moves the card's top, not that.
    // Between two cards it is on the one below. The frames follow it as "probe".
    expect(reader.swept?.probed, "the reader is on something after the glide").toBe(true);
    card = "probe";
  } else {
    await reader.up();
  }
  // The turn of the slot fell inside the gesture: without it the test would hold nothing back.
  const turnAt = (Math.floor(downAt / SLOT_MS) + 1) * SLOT_MS;
  expect(upAt, "the reader was still moving the page at the turn of the slot").toBeGreaterThanOrEqual(turnAt);
  // The check lands once the page is still.
  await expect.poll(() => feedRows(page).count(), { timeout: 5_000 }).toBeGreaterThan(rows0);
  await page.waitForTimeout(400);
  const frames = await stopLogging(page);

  const moves = jumps(frames, card, reader.accounted);
  const worst = Math.max(...moves.map(Math.abs));
  const landed = frames.find((frame) => frame.rows > rows0);
  const before = landed ? frames[frames.indexOf(landed) - 1] : undefined;
  const topOf = (frame: Frame | undefined) => frame?.tops[card] ?? Number.NaN;
  const gaps = reader.swept
    ? `; ${reader.swept.events} scroll events, longest gap between them ${reader.swept.longestGap.toFixed(0)} ms (the board waits ${SETTLE_MS})`
    : "";
  const shape = reader instanceof SyntheticFinger ? `; events made as ${reader.shape}` : "";
  testInfo.annotations.push({
    type: "numbers",
    description: `${card}: ${stray ? `mouse left on ${stray}; ` : ""}${frames.length} frames; worst card jump ${worst.toFixed(1)} px; rows ${touching ? "while touching" : "during the scroll"} ${rowsWhileTouching} (was ${rows0}); landed ${landed ? Math.round(landed.t - liftedAt) : "never"} ms after ${touching ? "the lift" : "the last scroll"}${shape}${gaps}`,
  });
  console.log(testInfo.annotations.at(-1)?.description);
  // The frames around the landing are printed when asked for, and whenever the card jumped, so a run that fails says where.
  if ((process.env.SCROLL_JUMP_TRACE || worst > 1) && landed) {
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

  if (worst > 1) {
    // Which frames, and what they were doing, when it was not at the landing. The frames the jump was measured between,
    // not the ones at its place in the list: a card that is not on every frame (the probe) has no jump for the others.
    const jump = jumpsBetween(frames, card, reader.accounted).find((one) => Math.abs(one.move) === worst);
    for (const frame of jump ? [jump.from, jump.to] : []) {
      console.log(
        `worst jump, ${JSON.stringify({ ...frame, tops: frame.tops[card], t: Math.round(frame.t - liftedAt) })}`,
      );
    }
  }

  // A flick's update lands once the glide is over. One that landed in the middle of it is the board not waiting for the
  // glide, unless the page was left still for as long as the board waits: a gap between two scroll events that began after
  // the lift, with the update landing once that wait was up and before the gap ended (a frame of slack for the frame that
  // saw it). That is the machine stalling (the glide is a step a frame, and the card the reader is on is only marked when
  // it is over), and is reported as that. A gap in the finger's drag cannot be the reason: a finger that is down holds the
  // board whatever the gaps.
  const glideGap = reader.swept?.glideGap;
  const stalled = Boolean(
    flicked &&
      landed &&
      glideGap &&
      glideGap.length >= SETTLE_MS &&
      landed.t >= glideGap.startedAt + SETTLE_MS &&
      landed.t <= glideGap.endedAt + FRAME_SLACK_MS,
  );
  const scrollGaps = reader.swept
    ? `${reader.swept.events} scroll events, longest gap between them ${reader.swept.longestGap.toFixed(0)} ms, longest after the lift ${(glideGap?.length ?? 0).toFixed(0)} ms (the board waits ${SETTLE_MS})`
    : "no scroll events";
  if (flicked && landed && landed.t < liftedAt + glide - FRAME_SLACK_MS) {
    const msEarly = Math.round(liftedAt + glide - landed.t);
    if (stalled) {
      expect(
        glideGap?.length ?? 0,
        `the machine stalled: the update landed ${msEarly} ms before the glide was over, after ${(glideGap?.length ?? 0).toFixed(0)} ms between two scroll events, longer than the ${SETTLE_MS} ms the board waits for a page to be still`,
      ).toBeLessThan(SETTLE_MS);
    }
    expect(
      landed.t,
      `the board did not wait for the glide: the update landed ${Math.round(landed.t - liftedAt)} ms after the lift, ${msEarly} ms before the glide of ${glide} ms was over, with no stall to explain it (${scrollGaps})`,
    ).toBeGreaterThanOrEqual(liftedAt + glide - FRAME_SLACK_MS);
  }

  // With no finger, a row that came in during the gesture is the board's fault only if the page was left still: a gap between two
  // scroll events as long as the board's wait, with the row coming in once that wait was up and before the gap ended (a frame of
  // slack for the frame that saw it), is the machine stalling, and is reported as that. Any other early row is a failure as it is.
  const early = frames.find((frame) => frame.rows > rows0 && frame.t < liftedAt);
  const stall = reader.swept;
  if (
    early &&
    !touching &&
    stall &&
    stall.longestGap >= SETTLE_MS &&
    early.t >= stall.gapStartedAt + SETTLE_MS &&
    early.t <= stall.gapEndedAt + FRAME_SLACK_MS
  ) {
    expect(
      stall.longestGap,
      `the machine stalled: ${stall.longestGap.toFixed(0)} ms between two scroll events, ending ${(stall.gapEndedAt - stall.startedAt).toFixed(0)} ms into the gesture, longer than the ${SETTLE_MS} ms the board waits for a page to be still, and a row came in ${(early.t - stall.startedAt).toFixed(0)} ms into it`,
    ).toBeLessThan(SETTLE_MS);
  }
  // Nothing came in under the finger, across the turn of the slot.
  expect(rowsWhileTouching, "Recent changes did not change while the finger was down").toBe(rows0);
  // Nor while the page was being scrolled: every frame up to the end of the gesture shows the rows it began with.
  expect(
    frames.filter((frame) => frame.t < liftedAt).every((frame) => frame.rows === rows0),
    "no row came in during the gesture",
  ).toBe(true);
  // And the card never moved on screen beyond the finger, a frame at a time.
  if (mouseMoves) {
    // The reader moved the mouse onto the board above the row: that is what they are on, and it stays where it is,
    // while the card the finger was on drops by the row.
    // From the moment the mouse is on the board: until then the page holds the card the finger left, so whatever moves
    // the piece before (a layout shift above it, say) is not the hold's to answer for. The piece is the one under the
    // mouse on each frame up to the landing (see `watchMouseArrival`): the one the page holds is the one under it on the
    // last frame before. Its moves are judged on the frames it was under the mouse, the landing included.
    const onAt = await page.evaluate(() => (window as Window & { __mouseOnAt?: number }).__mouseOnAt);
    expect(onAt, "the mouse reached the place after the finger lifted").toBeDefined();
    expect(
      onAt ?? Number.NaN,
      `the mouse reached the place ${Math.round((onAt ?? 0) - (landed?.t ?? 0))} ms after the update landed (the mouse ${Math.round((onAt ?? Number.NaN) - liftedAt)} ms after the lift, the update ${Math.round((landed?.t ?? Number.NaN) - liftedAt)} ms after it, the glide ${glide} ms; ${scrollGaps}), so there was nothing for the hold to keep${stalled ? " (the machine stalled)" : ""}`,
    ).toBeLessThan(landed?.t ?? Number.POSITIVE_INFINITY);
    const mouseSaid = await page.evaluate(() => (window as Window & { __mouseMoves?: string[] }).__mouseMoves ?? []);
    console.log(
      `the mouse reached the place ${Math.round((onAt ?? Number.NaN) - liftedAt)} ms after the lift, the update landed ${Math.round((landed?.t ?? Number.NaN) - liftedAt)} ms after it; its moves: ${mouseSaid.join(" | ")}`,
    );
    const held = frames.filter((frame) => frame.t >= (onAt ?? Number.POSITIVE_INFINITY));
    const heldBefore = held.filter((frame) => landed && frame.t < landed.t).at(-1);
    expect(
      heldBefore?.mouseId,
      `what is under the mouse when the update lands is a piece of the board that a new row does not move: ${heldBefore?.piece}`,
    ).toBeDefined();
    const pieceJumps = jumpsBetween(held, "mouse", true);
    expect(
      pieceJumps.some((jump) => jump.to === landed),
      "the landing is among the frames judged for the piece under the mouse",
    ).toBe(true);
    const piece = Math.max(...pieceJumps.map((jump) => Math.abs(jump.move)));
    if (piece > 1) {
      // Where the move was, and what was under the mouse then and now, for a run that fails to say.
      const worstPiece = pieceJumps.find((jump) => Math.abs(jump.move) === piece);
      for (const frame of worstPiece ? [worstPiece.from, worstPiece.to] : []) {
        console.log(
          `worst piece jump, ${JSON.stringify({ ...frame, tops: frame.tops.mouse, t: Math.round(frame.t - liftedAt) })}`,
        );
      }
      const now = await page.evaluate(
        ([x, y]) => {
          const under = document.elementFromPoint(x, y);
          return under ? `${under.tagName}#${under.id}.${under.className}` : "nothing";
        },
        [place?.x ?? 0, place?.y ?? 0],
      );
      console.log(
        `under the mouse at the end: ${now}; landed ${Math.round((landed?.t ?? 0) - liftedAt)} ms after the lift`,
      );
    }
    expect(
      piece,
      `the piece of the board under the mouse jumped ${piece.toFixed(1)} px in a frame`,
    ).toBeLessThanOrEqual(1);
    expect(worst, "the card the finger left drops by the row, as the mouse is what is held").toBeGreaterThan(20);
  } else {
    expect(worst, `the card jumped ${worst.toFixed(1)} px in a frame`).toBeLessThanOrEqual(1);
  }
  // The update lands after the gesture, a moment after the page is still, with the card still where it was.
  expect(landed, "the check landed").toBeDefined();
  if (fakeMove && landed) {
    // The report with no move came after the lift and before the update landed, or the test holds nothing back.
    const fakedAt = await page.evaluate(() => (window as Window & { __fakedAt?: number[] }).__fakedAt ?? []);
    expect(
      fakedAt.some((at) => at >= liftedAt && at < landed.t),
      `a report with no move came between the lift (${Math.round(liftedAt)}) and the landing (${Math.round(landed.t)}): ${JSON.stringify(fakedAt.map(Math.round))}`,
    ).toBe(true);
  }
  if (landed && before) {
    expect(landed.t, "the check lands after the lift").toBeGreaterThanOrEqual(liftedAt);
    // With no finger to wait for, it waits out the page's own stillness: 150 ms after the last scroll event.
    if (!touching) expect(landed.t - liftedAt, "the check waits for the page to be still").toBeGreaterThanOrEqual(100);
    if (!mouseMoves) {
      expect(
        Math.abs(topOf(landed) - topOf(before)),
        "the card is where it was when the check landed",
      ).toBeLessThanOrEqual(1);
    }
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

test("floating bar: holds the card under the finger, not a mouse that was left over the board above it", async ({
  page,
  hasTouch,
}, testInfo) => {
  test.skip(!hasTouch, "a finger is a touch project's");
  // As on an iPad or iPhone in WebKit after a click on Refresh: the mouse is still at the top right, and is reported
  // again as the page scrolls, after the finger's last touch. The finger is where the reader is, and the card under
  // it must stay put; a page that held what the mouse is over (the top of the board) would let it drop by a row.
  await acrossTheTurn(page, testInfo, (viewport) => new SyntheticFinger(page, viewport.width / 2), {
    touching: true,
    strayMouse: true,
  });
});

test("floating bar: holds the card of a flick, although a mouse left over the board is reported again as the page glides", async ({
  page,
  hasTouch,
}, testInfo) => {
  test.skip(!hasTouch, "a finger is a touch project's");
  // The finger has lifted (its touchend is the last the page hears of it) and the page glides on, as after a flick,
  // while the engine reports the old mouse place at every scroll. Only the place being the same as the one the mouse
  // was last seen at tells the page that it is not the mouse moving; the card must stay put as the row comes in.
  await acrossTheTurn(page, testInfo, (viewport) => new SyntheticFinger(page, viewport.width / 2), {
    touching: true,
    strayMouse: true,
    glide: 400,
  });
});

test("floating bar: holds the card of a flick, although the browser reports a mouse that has not moved at another place after the glide", async ({
  page,
  hasTouch,
}, testInfo) => {
  test.skip(!hasTouch, "a finger is a touch project's");
  // As WebKit does once a page has scrolled, to update what is hovered: a pointermove and mousemove 100 ms
  // after the last scroll (made by the page here, standing for the engine's own), at the place its cursor really is, which the page had not seen the mouse at. The cursor
  // did not move on the screen, which the event says (no movement, the same screen place), so it is not the reader.
  await acrossTheTurn(page, testInfo, (viewport) => new SyntheticFinger(page, viewport.width / 2), {
    touching: true,
    strayMouse: true,
    fakeMove: true,
    glide: 400,
  });
});

test("floating bar: holds what a mouse is over once it moves after the finger has lifted", async ({
  page,
  hasTouch,
}, testInfo) => {
  test.skip(!hasTouch, "a finger is a touch project's");
  // The other way round: a real move of the mouse (with steps, so it has movement) while the page glides on is the
  // reader acting, so the piece of the board it is over is held and the card the finger left is let go.
  await acrossTheTurn(page, testInfo, (viewport) => new SyntheticFinger(page, viewport.width / 2), {
    touching: true,
    mouseMoves: true,
    // Long enough for the mouse to get there: its steps are a round trip each, and the update lands a moment after the glide.
    glide: 1_500,
  });
});

test("floating bar: holds the card when the browser does not anchor scroll although it says it supports it", async ({
  page,
  hasTouch,
}, testInfo) => {
  test.skip(!hasTouch, "a finger is a touch project's");
  await acrossTheTurn(page, testInfo, (viewport) => new SyntheticFinger(page, viewport.width / 2), {
    touching: true,
    anchoring: "claimed",
  });
});

test("floating bar: holds the card, once and not twice, with the browser's own scroll anchoring left on", async ({
  page,
  hasTouch,
}, testInfo) => {
  test.skip(!hasTouch, "a finger is a touch project's");
  // Nothing is switched off. Whatever the browser holds, the page scrolls by what is left, so a card that is held
  // twice (the browser's scroll and the page's on top of it) would show here as a jump the other way. It runs on
  // WebKit too, whose anchoring differs by version: the card must not move on screen whichever it does.
  await acrossTheTurn(page, testInfo, (viewport) => new SyntheticFinger(page, viewport.width / 2), {
    touching: true,
    anchoring: "native",
  });
});

test("floating bar: Recent changes holds the height of its first row on a first visit", async ({ page }) => {
  // Nothing saved: the load's own check is the first row, and the card reserved for "Waiting for the first check."
  // would grow by it a third of a second after hydration, pushing the whole board down. A slot that turns while the
  // page loads would add a second row, so the page's clock is well inside a slot.
  await pinToSlot(page);
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
        top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom,
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        willChange: style.willChange,
        inert: element.hasAttribute("inert"),
        ariaHidden: element.getAttribute("aria-hidden"),
      };
    });
  const hidden = await look();
  expect(hidden.blur, "the hidden bar keeps its blur").toContain("blur(");
  // A phone's bar is off the screen by its transform and fully opaque; a tablet's fades out and slides 8px.
  const phone = (page.viewportSize()?.width ?? 0) < 640;
  const gone = async () => {
    const now = await look();
    return phone ? now.bottom <= 0.5 : now.opacity === "0";
  };
  const here = async () => {
    const now = await look();
    return phone ? Math.abs(now.top) <= 0.5 : now.opacity === "1";
  };
  expect(hidden.opacity).toBe(phone ? "1" : "0");
  expect(hidden.visibility, "it is hidden by opacity or by the screen's edge, not visibility").toBe("visible");
  expect(hidden.pointerEvents).toBe("none");
  if (!phone) expect(hidden.willChange).toContain("opacity");
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
  await barBack(page);
  await expect(bar).toHaveAttribute("data-shown", "true");
  await expect.poll(here).toBe(true);
  if (await isPhone(page)) {
    // A phone's bar also leaves on a scroll down, parked above the screen, and keeps the same layer doing it.
    await page.evaluate(() => window.scrollBy(0, -60));
    await page.evaluate(() => window.scrollBy(0, 120));
    await expect(bar).toHaveAttribute("data-shown", "false");
    await expect.poll(gone).toBe(true);
    expect((await look()).blur, "the parked bar keeps its blur").toContain("blur(");
    await page.evaluate(() => window.scrollBy(0, -40));
    await expect(bar).toHaveAttribute("data-shown", "true");
    await expect.poll(here).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar).toHaveAttribute("data-shown", "false");
  await expect.poll(gone).toBe(true);
  const blurless = await page.evaluate(() => {
    const tracked = window as Window & { __blurless?: number; __watching?: boolean };
    tracked.__watching = false;
    return tracked.__blurless;
  });
  expect(blurless, "frames without the blur across a show and a hide").toBe(0);
});
