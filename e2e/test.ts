import { test as base, expect } from "@playwright/test";

// Every spec imports `test` and `expect` from here, not from @playwright/test. It is the same test, plus one
// automatic fixture: the browser may ask this machine for anything and no one else. The page's own origin is
// the preview server, whose vendor requests are refused (support/no-vendors.mjs); a request the page makes to
// another host is aborted and fails the test that made it, so a vendor (or any outside service) can never be
// what a test passed or failed on. A test that needs to answer an outside URL says so with its own page.route,
// which takes precedence over this one.

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const test = base.extend<{ stayLocal: undefined }>({
  stayLocal: [
    async ({ context }, use) => {
      const strays: string[] = [];
      await context.route(
        (url) => url.protocol.startsWith("http") && !LOCAL.has(url.hostname),
        (route) => {
          strays.push(route.request().url());
          return route.abort("blockedbyclient");
        },
      );
      await use(undefined);
      expect(strays, "the page asked a host that is not this machine").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
