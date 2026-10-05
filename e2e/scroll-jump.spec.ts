import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { SETTLE_MS } from "../src/lib/status/page-motion.ts";
import { fixtureBoard, serveBoard } from "./fixture-board";
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

type Frame = { t: number; tops: Record<string, number>; y: number; rows: number; by: number; reader: number };

/**
 * Logs the cards on every frame: the top in the window of each one in view, the scroll position, how many rows
 * Recent changes has, how far the page has scrolled itself by (window.scrollBy, which is how the page keeps a
 * place) and how far the reader has scrolled it (for the readers that scroll it from the page).
 */
async function logFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tracked = window as Window & { __frames?: Frame[]; __logging?: boolean; __by?: number; __reader?: number };
    tracked.__frames = [];
    tracked.__logging = true;
    const rows = () => document.querySelectorAll('section[aria-labelledby="recent-heading"] li').length;
    const frame = () => {
      if (!tracked.__logging) return;
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
    ({ ms, finger, y, flick }) =>
      new Promise<Sweep>((resolve) => {
        const STEP = 3;
        const RUN = 30;
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
              resolve({
                y: at,
                lastStepAt,
                events: seen.length,
                longestGap,
                gapStartedAt,
                gapEndedAt,
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
    { ms, finger, y, flick },
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
 * A place near the right-hand edge of the board, over a piece that keeps its place when a row comes into Recent
 * changes: one that comes before the row (a card above it, the "Needs a look" panel), as it did in WebKit. A page
 * that takes the newest pointer it heard of for the reader, whatever the finger did, holds that piece and lets the
 * card below the row drop. The piece is marked `data-mouse-piece`, for the frames to follow.
 */
async function findMousePlace(page: Page): Promise<MousePlace> {
  const place = await page.evaluate(() => {
    const feed = document.querySelector('section[aria-labelledby="recent-heading"]');
    const board = document.getElementById("services");
    if (!feed || !board) return null;
    const x = board.getBoundingClientRect().right - 12;
    for (let y = 8; y < window.innerHeight; y += 8) {
      const target = document.elementFromPoint(x, y);
      if (!target || target === board || !board.contains(target) || target.contains(feed)) continue;
      if (!(feed.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
      target.setAttribute("data-mouse-piece", "");
      return { x, y, piece: `${target.tagName} at ${Math.round(x)},${y}` };
    }
    return null;
  });
  expect(place, "a mouse can be left over a piece of the board that a new row does not move").not.toBeNull();
  return place as MousePlace;
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
 * movement, and the same place on the screen as the last report. The page makes them itself (a script cannot send a
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
            fire(target, at, { x: cursor().screenX, y: cursor().screenY }, 0);
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
  const out: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const [from, to] = [a.tops[card], b.tops[card]];
    if (from === undefined || to === undefined) continue;
    out.push(accounted ? to - from + (b.reader - a.reader) : to + b.y - (from + a.y) - (b.by - a.by));
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
  // above it in view for the mouse to be over, as in WebKit's layout of the same page.
  const overBoard = strayMouse || mouseMoves;
  await page.evaluate(
    ([id, at, first]) => {
      const feed = document.querySelector('section[aria-labelledby="recent-heading"]');
      const next = first
        ? [...document.querySelectorAll('article[id^="service-"]')].find(
            (card) => feed && feed.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : document.getElementById(id as string);
      if (next) window.scrollBy(0, next.getBoundingClientRect().top - (at as number));
    },
    ["service-spotify", viewport.height * (overBoard ? 0.66 : 0.6), overBoard],
  );
  const rows0 = await feedRows(page).count();

  // Two and a half seconds before the board's check at the turn of a slot.
  const msToTurn = await page.evaluate((slot) => slot - (Date.now() % slot), SLOT_MS);
  await page.clock.fastForward(Math.max(0, msToTurn - 2_500));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(await feedRows(page).count(), "the turn has not come yet").toBe(rows0);

  const reader = await makeReader(viewport);
  await logFrames(page);
  const place = overBoard ? await findMousePlace(page) : undefined;
  if (place && strayMouse) await leaveMouse(page, place, { fake: fakeMove });
  const stray = strayMouse && place ? place.piece : "";
  await reader.down(viewport.height * 0.7);
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
    // Which frame, and what it was doing, when it was not at the landing.
    const at = moves.findIndex((move) => Math.abs(move) === worst) + 1;
    for (const frame of frames.slice(Math.max(0, at - 1), at + 1)) {
      console.log(
        `worst jump, ${JSON.stringify({ ...frame, tops: frame.tops[card], t: Math.round(frame.t - liftedAt) })}`,
      );
    }
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
    const piece = Math.max(...jumps(frames, "mouse", true).map(Math.abs));
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
    glide: 400,
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
