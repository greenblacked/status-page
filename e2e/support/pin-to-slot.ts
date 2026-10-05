import type { Page } from "@playwright/test";
import { expect } from "../test";

/**
 * Moves the page's Date to 30 s into a two-minute slot, and lets it run on from there. The turn of a slot adds a row
 * to Recent changes, which grows the board body and makes the dock measure again (rightly); with the page 30 s in,
 * the next turn and the wall-clock refetch are 90 s or more away. Only Date moves. page.clock.install would do the
 * same, but it also replaces requestAnimationFrame with a timer that fires every 16 ms of clock time whether or not
 * the page has rendered: three of those "frames" can pass before the page has rendered once, and so before a resize
 * reaches it (the resize event is sent in a rendering update, ahead of the frame callbacks).
 *
 * Call it before the first goto of the test (an init script runs on the loads that come after it). The page is then in
 * the slot the wall clock is in, so a test that reads the clock itself (the saved checks it seeds, a time it
 * computes) agrees with the page about the slot, however near the turn the wall clock is when the test starts.
 * A test that moves the page's Date on from here must wrap this Date, not assign Date.now: this one answers
 * `Date.now` itself, and an assignment would never be seen.
 */
export async function pinToSlot(page: Page): Promise<void> {
  const offset = Math.floor(Date.now() / 120_000) * 120_000 + 30_000 - Date.now();
  await page.addInitScript((shift) => {
    const Native = Date;
    let stopped: number | null = null;
    const now = () => stopped ?? Native.now() + shift;
    (window as Window & { __stopClock?: () => void }).__stopClock = () => {
      stopped ??= now();
    };
    window.Date = new Proxy(Native, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
      apply: (target) => new target(now()).toString(),
      get: (target, key) => (key === "now" ? now : Reflect.get(target, key, target)),
    });
  }, offset);
}

/**
 * Stops the page's Date where it is, on a page that pinToSlot moved (timers and frames run on). Every text on the board
 * that counts from now stands still once the page has drawn the stopped time, which it does on its next one-second
 * tick (useNow), so this waits that tick out and two frames after it: a minute can turn between the last tick and the
 * stop, and the tick after it would draw the new minute under whatever the caller starts watching. What stands still:
 * the running time of an incident, the countdown, the ages. A test of the board's geometry or of its layout shifts
 * is about what its own actions move, and a clock that crosses a minute under it moves text that has nothing to do
 * with them. The e2e payloads make that likely and not rare: the dates of
 * a canned payload are moved to the moment it is read, and several of its incidents began a whole number of hours
 * before, so "since 14:05 UTC (3h)" reads "(3h 1m)", 23px wider, a minute after the board was built, wherever in a
 * test that falls (Chromium counts it as a layout shift of 0.0004).
 */
export async function stopClock(page: Page): Promise<void> {
  const stopped = await page.evaluate(() => {
    const stop = (window as Window & { __stopClock?: () => void }).__stopClock;
    stop?.();
    return stop !== undefined;
  });
  expect(stopped, "the page's clock was pinned (pinToSlot) before it could be stopped").toBe(true);
  // useNow redraws on a 1 s interval, whose next run is due within 1 s of now and so runs before this timer does;
  // the frames let what it rendered be laid out and reported.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 1_100),
      ),
  );
}
