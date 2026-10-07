import { defineConfig, devices } from "@playwright/test";
import { chromiumArgs } from "./e2e/support/chromium-args.ts";
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
//
// E2E_SERVER=node serves the same build with the production Node server (src/node/serve.ts, the one the Docker
// image runs) instead of `vite preview`, so the @node-server tests can check what only it does: the caching of
// /assets/*, compression and the security headers on static files.
const port = Number(process.env.PLAYWRIGHT_PORT) || 4173;
const nodeServer = process.env.E2E_SERVER === "node";
const baseURL = `http://127.0.0.1:${port}`;

// One nonce per run for the preview's vendor log (e2e/support/vendor-log.ts). The config is loaded again in
// every worker, so the first load puts it in the environment, which the workers inherit.
process.env.E2E_RUN ||= `${process.pid}-${Date.now()}`;
const run = process.env.E2E_RUN;

// A browser Playwright did not download, such as a preinstalled Chromium in
// a container: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome. It applies to
// the Chromium projects only; the WebKit ones always use Playwright's own.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

// Chromium's other hosts are cut off at launch (e2e/support/chromium-args.ts), not with a route, which would switch
// off its HTTP cache.
const chromiumLaunch = { executablePath, args: chromiumArgs };

// Chrome on Android no longer sends the device's Android version or model: with the reduced user agent its user
// agent reads `Android 10; K` and `Chrome/<major>.0.0.0`, whatever the phone, and a tablet leaves
// out "Mobile". The real version and model are only in the client hints (`Sec-CH-UA-Platform-Version`,
// `Sec-CH-UA-Model`). Playwright's Android profiles carry an older, full user agent that Chrome no longer
// sends ("Android 14; Pixel 7", "Android 16; Pixel 10", "Android 8.0.0; SM-G965U"), so the Android projects use
// this to send what Chrome on Android sends today, on Android 17 (the newest release, API 37) as on any other
// version; Pixel 10 is the newest Pixel profile Playwright ships. Only the user agent changes: the profile's own viewport,
// scale factor and touch stay, and no test or page code reads the user agent. The Chrome major comes from the
// profile itself, which Playwright keeps at the Chromium it ships, because the user agent should name the engine
// that runs (a "Chrome/155" on Chromium 153 would be a claim the engine cannot back). The 153 is Playwright's
// Chromium, which may be newer than the stable Chrome phones run today. The `Mobile` token stays on every phone
// profile, including the unfolded Galaxy Z Fold 7 (984px wide), where real Chrome may differ; no test reads it.
// A profile that is not Android (the iPad-sized Chromium tablet) is returned as it is.
// https://www.chromium.org/updates/ua-reduction/
// https://developer.android.com/about/versions/17
// https://developer.chrome.com/docs/privacy-security/user-agent-client-hints
function reducedAndroidUserAgent<T extends { userAgent: string }>(profile: T): T {
  const { userAgent } = profile;
  if (!userAgent.includes("; Android ")) return profile;
  return {
    ...profile,
    userAgent: userAgent
      .replace(/\(Linux; Android [^;)]+; [^)]*\)/, "(Linux; Android 10; K)")
      .replace(/Chrome\/(\d+)\.\d+\.\d+\.\d+/, "Chrome/$1.0.0.0"),
  };
}

// The tests of how the page lays out on a screen carry this tag (e2e/mobile-layout.spec.ts). The projects of the
// extra screens run nothing else, and every other project runs them with the rest.
const LAYOUT = /@layout/;

// The extra screens, with the engine their device profile belongs to: Playwright's own profile for each, named by it.
const LAYOUT_DEVICES = [
  { name: "Galaxy S9+", browser: "chromium" },
  { name: "Pixel 10", browser: "chromium" },
  { name: "Galaxy Z Fold 7", browser: "chromium" },
  { name: "Galaxy Z Fold 7 Cover", browser: "chromium" },
  { name: "Galaxy Tab S9", browser: "chromium" },
  { name: "Pixel 7 landscape", browser: "chromium" },
  { name: "iPhone SE (3rd gen)", browser: "webkit" },
  { name: "iPhone 17 Pro Max", browser: "webkit" },
  { name: "iPad Mini", browser: "webkit" },
  { name: "iPhone 17 Pro landscape", browser: "webkit" },
] as const;

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
    { name: "mobile", use: { ...reducedAndroidUserAgent(devices["Pixel 7"]), launchOptions: chromiumLaunch } },
    // An iPad's size in Chromium: 834px is still the narrow layout (below 64rem) but wide enough (from 40rem)
    // for the bar's lead text to sit in the flow before the field's slot, which only WebKit's iPad would
    // otherwise cover. It runs the tests of the search reveal (the bar's copy of the field), the field's fill, the
    // floating bar, the self-hosted Inter (a late or a cached one, on a hero that wraps differently by width), the
    // page's hydration under its Content-Security-Policy, the tilt lighting performance run, the lone Needs a look card and the layout tests
    // (@layout), not the whole suite: the rest has its Chromium coverage at the other two sizes.
    {
      name: "tablet",
      grep: /search reveal|floating bar|field's fill|self-hosted Inter|content security policy|tilt performance|lone Needs a look|@layout/i,
      use: { ...devices["iPad Pro 11"], defaultBrowserType: "chromium", launchOptions: chromiumLaunch },
    },
    { name: "Desktop Safari", use: { ...devices["Desktop Safari"] } },
    { name: "iPhone 17 Pro", use: { ...devices["iPhone 17 Pro"] } },
    { name: "iPad Pro 11", use: { ...devices["iPad Pro 11"] } },
    // More screens, each running only the tests tagged @layout (e2e/mobile-layout.spec.ts): the sizes the projects above
    // do not cover, where a layout breaks first. Narrow (a 320px Galaxy S9+), short (an iPhone SE), large (an iPhone
    // 17 Pro Max), foldable (a Galaxy Z Fold 7 open and on its cover screen), an Android tablet, and phones on their
    // side. The suite's other tests are not about a size, so the projects above have them.
    ...LAYOUT_DEVICES.map(({ name, browser }) => ({
      name,
      grep: LAYOUT,
      use:
        browser === "chromium"
          ? { ...reducedAndroidUserAgent(devices[name]), launchOptions: chromiumLaunch }
          : { ...devices[name] },
    })),
  ],
  webServer: {
    command: nodeServer ? "node src/node/serve.ts" : `pnpm run preview --port ${port} --strictPort`,
    // /healthz never reads the board, so the server is up before any vendor answers.
    url: `${baseURL}/healthz`,
    // Always its own: a server that was started by hand does not have the vendors cut off.
    reuseExistingServer: false,
    env: {
      ...(nodeServer ? { PORT: String(port), HOST: "127.0.0.1" } : {}),
      // Added to any NODE_OPTIONS already set (a memory limit, a CA bundle), and found from this file, not the cwd.
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./e2e/support/no-vendors.mjs", import.meta.url).href}`.trim(),
      E2E_VENDOR_LOG: vendorLogPath(port, run),
    },
    timeout: 60_000,
  },
});
