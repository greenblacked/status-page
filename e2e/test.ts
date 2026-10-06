import { type BrowserContext, test as base, expect, type Request } from "@playwright/test";
import { pinToSlot } from "./support/pin-to-slot";

// Every spec imports `test` and `expect` from here, not from @playwright/test. It is the same test, plus one
// automatic fixture: the browser may ask this machine for anything and no one else. The page's own origin is
// the preview server, whose vendor requests are refused (support/no-vendors.mjs); a request the page makes to
// another host fails the test that made it, so a vendor (or any outside service) can never be what a test passed
// or failed on. A test that needs to answer an outside URL says so with its own page.route, which takes
// precedence over this one.
//
// Chromium is watched, not routed: a routed page has its HTTP cache switched off, and the tests of the
// self-hosted Inter (a font that is only used on a view that has it cached) are about that cache. There the
// other hosts are cut off at the resolver instead (--host-resolver-rules in e2e/support/chromium-args.ts), so a
// stray request fails to connect and is reported here. A request that does finish was answered by the test's own
// page.route, so it is not a stray. WebKit has no such switch, so its stray requests are aborted.

// The board's appearance is its own choice now (src/lib/theme.ts): a stored one, else the visitor's clock, night
// from 20:00 to 06:00. A test that emulates a colour scheme, or says nothing and gets Playwright's light, means
// that appearance, and must not turn out to be the one the machine's clock gives at 22:00. So every page of the
// test's context stores the theme that matches the scheme it is emulating, at each load and again when the
// emulated scheme changes (emulateMedia on a loaded page), and the board is told to read it. Tests that are about
// the choice or the clock turn this off with `test.use({ pinTheme: false })` and set their own.
export const PIN_THEME = `(() => {
  try {
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const pin = () => {
      try {
        localStorage.setItem("theme", dark.matches ? "night" : "day");
      } catch {}
    };
    pin();
    dark.addEventListener("change", () => {
      pin();
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } catch {}
})();`;

// The board adds a row to Recent changes and clears the "Changed" tags at every turn of a two-minute slot of the wall
// clock, and what the reader is holding scrolls by what is left. A test that happens to run (or load) across a turn
// sees the board move by tens of pixels that its own actions did not cause, which fails it one run in a hundred and
// no more than that, on a slow runner, in a place that has nothing to do with what it checks. So every page of every
// test starts 30 s into a slot (pinToSlot, e2e/support/pin-to-slot.ts): the next turn is 90 s away, and the clock
// runs on from there. Only the start is pinned, the clock is not stopped; a test that needs it still (a board's
// geometry over a long run) stops it with stopClock. A test that moves the page's time itself (page.clock) or that
// crosses a slot on purpose turns this off with `test.use({ pinSlot: false })`.
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const isStray = (href: string) => {
  const url = new URL(href);
  return url.protocol.startsWith("http") && !LOCAL.has(url.hostname);
};

/**
 * Watches a Chromium context, which has its other hosts cut off at the resolver, so a stray request never finishes. Returns
 * the strays so far: the outside URLs the page asked and nobody answered (a request that did finish was answered by
 * the test's own page.route).
 */
export function watchStrays(context: BrowserContext): () => string[] {
  const asked = new Set<Request>();
  context.on("request", (request) => {
    if (isStray(request.url())) asked.add(request);
  });
  context.on("requestfinished", (request) => asked.delete(request));
  return () => [...asked].map((request) => request.url());
}

export const test = base.extend<{ stayLocal: undefined; pinTheme: boolean; pinSlot: boolean }>({
  pinTheme: [true, { option: true }],
  pinSlot: [true, { option: true }],
  page: async ({ page, pinSlot }, use) => {
    if (pinSlot) await pinToSlot(page);
    await use(page);
  },
  context: async ({ context, pinTheme }, use) => {
    if (pinTheme) await context.addInitScript(PIN_THEME);
    await use(context);
  },
  stayLocal: [
    async ({ context, browserName }, use) => {
      const aborted: string[] = [];
      const watched = browserName === "chromium" ? watchStrays(context) : undefined;
      if (!watched) {
        await context.route(
          (url) => isStray(url.href),
          (route) => {
            aborted.push(route.request().url());
            return route.abort("blockedbyclient");
          },
        );
      }
      await use(undefined);
      expect(watched ? watched() : aborted, "the page asked a host that is not this machine").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
