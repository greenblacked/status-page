import { defineConfig, devices } from "@playwright/test";
import { vendorLogPath } from "./e2e/support/vendor-log.ts";

// Browser tests against the production build, served the way CI's smoke
// test serves it: run `pnpm run build` first. `pnpm run test:e2e` runs them.
//
// The board reads vendors on the server, which the tests must not depend on:
// the preview is started with e2e/support/no-vendors.mjs, which answers a
// vendor's URL from the canned payload the collector unit tests read and
// refuses every other host. The page's first render is then the same board
// wherever the suite runs, and a test that needs a particular state serves a
// fixture board (e2e/fixture-board.ts). The setup proves the cut-off before
// the first test and reports it after the last.
// PLAYWRIGHT_PORT moves the preview off 4173 when something else holds it.
const port = Number(process.env.PLAYWRIGHT_PORT) || 4173;
const baseURL = `http://127.0.0.1:${port}`;

// One nonce per run for the preview's vendor log (e2e/support/vendor-log.ts). The config is loaded again in
// every worker, so the first load puts it in the environment, which the workers inherit.
process.env.E2E_RUN ||= `${process.pid}-${Date.now()}`;
const run = process.env.E2E_RUN;

// A browser Playwright did not download, such as a preinstalled Chromium in
// a container: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome. It applies to
// the Chromium projects only; the WebKit ones always use Playwright's own.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

// Chromium may resolve this machine and nothing else, so a page that asks another host fails to connect (and e2e/test.ts
// fails the test). It is done here, not with a route, because a routed page has no HTTP cache, which the tests of the
// self-hosted Inter need.
const chromiumLaunch = {
  executablePath,
  args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // No retries: a test that passes on its second try is hiding a bug.
  retries: 0,
  // "list" prints each test as it starts and ends, so a job that hits its
  // timeout shows which tests were running; "github" alone shows only dots.
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  // Generous on purpose: some tests wait out the board's own two-minute refetch clock.
  timeout: 45_000,
  globalSetup: "./e2e/support/global-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Times show in the viewer's own zone once the page has hydrated. Pinning UTC
    // and a locale makes that text equal the server's UTC text ("14:05 UTC"), so
    // the suite stays deterministic wherever it runs. One test sets its own zone.
    timezoneId: "UTC",
    locale: "en-GB",
  },
  // The board is built for Apple devices first, so Safari's engine runs
  // every test too: a Mac, an iPhone and an iPad, alongside Chromium on a
  // desktop, an Android phone and an iPad-sized tablet. `pnpm exec playwright install chromium webkit`.
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: chromiumLaunch } },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions: chromiumLaunch } },
    // An iPad's size in Chromium: 834px is still the narrow layout (below 64rem) but wide enough (from 40rem)
    // for the bar's lead text to sit in the flow before the field's slot, which only WebKit's iPad would
    // otherwise cover. It runs the tests of the search reveal (the bar's copy of the field), the field's fill, the
    // floating bar and the self-hosted Inter (a late or a cached one, on a hero that wraps differently by width), not the whole suite: the rest has
    // its Chromium coverage at the other two sizes.
    {
      name: "tablet",
      grep: /search reveal|floating bar|field's fill|self-hosted Inter/i,
      use: { ...devices["iPad Pro 11"], defaultBrowserType: "chromium", launchOptions: chromiumLaunch },
    },
    { name: "Desktop Safari", use: { ...devices["Desktop Safari"] } },
    { name: "iPhone 17 Pro", use: { ...devices["iPhone 17 Pro"] } },
    { name: "iPad Pro 11", use: { ...devices["iPad Pro 11"] } },
  ],
  webServer: {
    command: `pnpm run preview --port ${port} --strictPort`,
    // /healthz never reads the board, so the server is up before any vendor answers.
    url: `${baseURL}/healthz`,
    // Always its own: a server that was started by hand does not have the vendors cut off.
    reuseExistingServer: false,
    env: {
      // Added to any NODE_OPTIONS already set (a memory limit, a CA bundle), and found from this file, not the cwd.
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./e2e/support/no-vendors.mjs", import.meta.url).href}`.trim(),
      E2E_VENDOR_LOG: vendorLogPath(port, run),
    },
    timeout: 60_000,
  },
});
