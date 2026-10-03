import { test as base, expect } from "@playwright/test";

// Every spec imports `test` and `expect` from here, not from @playwright/test. It is the same test, plus one
// automatic fixture: the browser may ask this machine for anything and no one else. The page's own origin is
// the preview server, whose vendor requests are refused (support/no-vendors.mjs); a request the page makes to
// another host fails the test that made it, so a vendor (or any outside service) can never be what a test passed
// or failed on. A test that needs to answer an outside URL says so with its own page.route, which takes
// precedence over this one.
//
// Chromium is watched, not routed: a routed page has its HTTP cache switched off, and the tests of the
// self-hosted Inter (a font that is only used on a view that has it cached) are about that cache. There the
// other hosts are cut off at the resolver instead (--host-resolver-rules in playwright.config.ts), so a stray
// request fails to connect and is reported here. WebKit has no such switch, so its stray requests are aborted.

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isStray = (href: string) => {
  const url = new URL(href);
  return url.protocol.startsWith("http") && !LOCAL.has(url.hostname);
};

export const test = base.extend<{ stayLocal: undefined }>({
  stayLocal: [
    async ({ context, browserName }, use) => {
      const strays: string[] = [];
      if (browserName === "chromium") {
        context.on("request", (request) => {
          if (isStray(request.url())) strays.push(request.url());
        });
      } else {
        await context.route(
          (url) => isStray(url.href),
          (route) => {
            strays.push(route.request().url());
            return route.abort("blockedbyclient");
          },
        );
      }
      await use(undefined);
      expect(strays, "the page asked a host that is not this machine").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
