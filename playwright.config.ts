import { defineConfig, devices } from "@playwright/test";

// Browser tests against the production build, served the way CI's smoke
// test serves it: run `pnpm run build` first. `pnpm run test:e2e` runs them.
//
// The board reads live vendors on the server, so what the cards say varies
// from run to run (and is all Unknown without network access). The tests
// only assert what holds either way: the page, its accessibility, keyboard
// paths and URL state, never a particular vendor's health.
// PLAYWRIGHT_PORT moves the preview off 4173 when something else holds it.
const port = Number(process.env.PLAYWRIGHT_PORT) || 4173;
const baseURL = `http://127.0.0.1:${port}`;

// A browser Playwright did not download, such as a preinstalled Chromium in
// a container: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome. It applies to
// the Chromium projects only; the WebKit ones always use Playwright's own.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // No retries: a test that passes on its second try is hiding a bug.
  retries: 0,
  // "list" prints each test as it starts and ends, so a job that hits its
  // timeout shows which tests were running; "github" alone shows only dots.
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  // The first page load reads every vendor, up to their 9-second timeout.
  timeout: 45_000,
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
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions: { executablePath } } },
    // An iPad's size in Chromium: 834px is still the narrow layout (below 64rem) but wide enough (from 40rem)
    // for the bar's lead text to sit in the flow before the field's slot, which only WebKit's iPad would
    // otherwise cover. It runs the tests of the search reveal (the bar's copy of the field), the field's fill, the
    // floating bar and the font swap (where a line wraps depends on the width), not the whole suite: the rest has
    // its Chromium coverage at the other two sizes.
    {
      name: "tablet",
      grep: /search reveal|floating bar|field's fill|Inter replaces its fallback/i,
      use: { ...devices["iPad Pro 11"], defaultBrowserType: "chromium", launchOptions: { executablePath } },
    },
    { name: "Desktop Safari", use: { ...devices["Desktop Safari"] } },
    { name: "iPhone 17 Pro", use: { ...devices["iPhone 17 Pro"] } },
    { name: "iPad Pro 11", use: { ...devices["iPad Pro 11"] } },
  ],
  webServer: {
    command: `pnpm run preview --port ${port} --strictPort`,
    // /healthz never reads the board, so the server is up before any vendor answers.
    url: `${baseURL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
