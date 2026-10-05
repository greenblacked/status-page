import type { Page } from "@playwright/test";

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
