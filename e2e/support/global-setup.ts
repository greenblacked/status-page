import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { CACHE_TTL_MS, MIN_FORCED_REFRESH_MS } from "../../src/lib/status/schedule.ts";
import type { BoardSnapshot, Health } from "../../src/lib/status/types.ts";
import { chromiumArgs } from "./chromium-args.ts";
import { FIRST_RENDER_AT_ENV, missingFromFirstRender } from "./first-render.ts";
import { VENDOR_LOG_PREFIX, vendorLogPath } from "./vendor-log.ts";

type Entry = { kind: "active" | "served" | "refused"; host?: string; path?: string };

const entries = (file: string): Entry[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry)
    : [];

/**
 * What each of the catalog's services reads on the canned first render: the health its collector gives from the
 * fixture that stands in for the vendor (src/lib/status/__fixtures__, routed in canned-vendors.mjs), or Unknown
 * for the services with no canned payload. Pinned so that a collector whose URL changed (the fixture is then no
 * longer served, and the service quietly reads Unknown), a fixture that drifted, or a window that no longer
 * holds an outage fails here, by name, and not as a test that cannot find its card. Change an entry when you
 * change the fixture or the collector on purpose.
 */
const EXPECTED_HEALTH: Record<string, Health> = {
  gcp: "outage",
  aws: "degraded",
  azure: "outage",
  steam: "unknown",
  "cs2-europe": "unknown",
  epic: "unknown",
  fortnite: "unknown",
  spotify: "unknown",
  apple: "unknown",
  android: "degraded",
  github: "degraded",
  gitlab: "degraded",
  confluence: "outage",
  grok: "degraded",
  chatgpt: "unknown",
  claude: "unknown",
  mikrotik: "operational",
  "apple-os": "operational",
  windows: "operational",
  "android-os": "operational",
};

const count = (list: Entry[], kind: Entry["kind"]) => list.filter((entry) => entry.kind === kind).length;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * How long the page may take to carry the release lines and the changelog notes when nothing forces a new board.
 * They are read after the sweep and join a board only when the board is built again. The page and the JSON API
 * share one board cache, so the board the setup builds first (without them) is what the page is served for the
 * cache's whole lifetime (CACHE_TTL_MS, 45 s) and a build later; this covers that, with a margin. It is the slow
 * path: the setup normally forces the new build itself (refreshBoardOnce) and the first request finds them.
 */
const FIRST_RENDER_DEADLINE_MS = CACHE_TTL_MS + 45_000;

/**
 * Has the board built again now that the release feeds and the changelog notes are settled, as a visitor does by
 * pressing Refresh: opens the page in a short-lived Chromium and presses it (the server function is the page's
 * own; its URL is not something to rebuild by hand). The cache refuses a forced build within
 * MIN_FORCED_REFRESH_MS of the last one, so the caller waits that out first. Returns whether a forced response
 * came back; a browser that cannot be started or a press that goes unanswered returns false, and the setup falls
 * back to waiting for the cache to expire (FIRST_RENDER_DEADLINE_MS).
 */
async function refreshBoardOnce(baseURL: string): Promise<boolean> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: chromiumArgs,
    });
    const page = await browser.newPage({ baseURL });
    await page.goto("/");
    const answered = page.waitForResponse(
      (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
      { timeout: 20_000 },
    );
    // Before hydration the button does nothing, so press it until the server answers.
    const button = page.getByRole("button", { name: "Refresh status now" }).first();
    const pressing = (async () => {
      for (;;) {
        await button.click({ timeout: 5_000 });
        await sleep(500);
      }
    })();
    pressing.catch(() => {});
    const response = await answered;
    return response.ok();
  } catch {
    return false;
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Waits until the vendor log has stopped growing for `quietMs` (the background reads are done), or `limitMs`. */
async function waitForQuietLog(log: string, quietMs = 500, limitMs = 10_000): Promise<void> {
  const until = Date.now() + limitMs;
  let size = -1;
  let since = Date.now();
  while (Date.now() < until) {
    const now = entries(log).length;
    if (now !== size) {
      size = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
    await sleep(100);
  }
}

/**
 * Proves, before the first test, that the preview server cannot reach a vendor (support/no-vendors.mjs is
 * loaded into it): asks it for a board and checks that its vendor requests were answered from the canned
 * payloads or refused, and that the board it built has states on it (not all Unknown), so the first render
 * and the hydration after it are tested with outages, incidents and release lines, and that every service reads
 * the health pinned for it (EXPECTED_HEALTH). If the server were reading live vendors, or the preload did not
 * load, this fails instead of the suite quietly depending on them.
 *
 * It then makes the first page render carry what the background reads add. A board is built from the health
 * sweep alone; the release feeds and the MikroTik changelogs are read right after it and join the next build
 * (src/lib/status/collect-board.ts), and the page, the JSON API and the other server routes share one board for 45
 * seconds, so a page served the board built before the reads had settled would show no release line to every
 * test that starts in that window. The setup waits until the vendor log is quiet (those reads are done, in
 * milliseconds on the canned payloads), has the board built again by pressing Refresh in a browser of its own
 * once the cache allows it (MIN_FORCED_REFRESH_MS after the first board; if it cannot, it waits for the cache to
 * expire), only then asks for the page the tests will render, and pins what it carries
 * (EXPECTED_RELEASE_LINES and MIKROTIK_NOTE in first-render.ts): that page is the board the first tests are
 * served (for the first RELEASE_LINES_GUARANTEED_MS of the run: the feeds are cached for 30 minutes, after which
 * a build leaves them out until they are read again, so the first-render test stops asking for them). If the reads were late the page is asked again until it has them (at most FIRST_RENDER_DEADLINE_MS),
 * then this fails, by name, and not as a test that cannot find a line. The returned function reports the counts
 * of the whole run after the last test.
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const baseURL = config.projects[0].use.baseURL ?? "";
  const port = Number(new URL(baseURL).port);
  const run = process.env.E2E_RUN;
  if (!run) throw new Error("playwright.config.ts did not set E2E_RUN, the run's id for the vendor log.");
  const log = vendorLogPath(port, run);

  // The logs of earlier runs (a killed run never reaches its teardown) are of no use to this one.
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(`${VENDOR_LOG_PREFIX}${port}-`) && join(tmpdir(), name) !== log) {
      rmSync(join(tmpdir(), name), { force: true });
    }
  }

  // The feeds are read right after this board's sweep and cached for 30 minutes (RELEASE_FEED_TTL_MS); the workers
  // inherit this, and the first-render test asks for the release lines only while they are younger than that.
  process.env[FIRST_RENDER_AT_ENV] = String(Date.now());
  const response = await fetch(new URL("/api/status.json", baseURL));
  const board = (await response.json()) as BoardSnapshot;
  const builtAt = Date.now();
  const unknown = board.services.filter((service) => service.health === "unknown").length;
  const seen = entries(log);
  const served = count(seen, "served");
  const refused = count(seen, "refused");
  if (count(seen, "active") === 0 || served + refused === 0 || unknown === board.services.length) {
    throw new Error(
      `The preview server is not running with e2e/support/no-vendors.mjs (${unknown} of ${board.services.length} services Unknown, ${served} vendor requests answered from fixtures, ${refused} refused). The browser tests must not read live vendors: stop whatever holds port ${port}, or set PLAYWRIGHT_PORT.`,
    );
  }
  const actual = Object.fromEntries(board.services.map((service) => [service.id, service.health]));
  const drift = [...new Set([...Object.keys(EXPECTED_HEALTH), ...Object.keys(actual)])]
    .filter((id) => EXPECTED_HEALTH[id] !== actual[id])
    .map(
      (id) => `${id}: expected ${EXPECTED_HEALTH[id] ?? "no such service"}, read ${actual[id] ?? "no such service"}`,
    );
  if (drift.length > 0) {
    throw new Error(
      `The canned first render does not read as pinned in e2e/support/global-setup.ts (EXPECTED_HEALTH):\n  ${drift.join("\n  ")}\nA service that reads Unknown here usually means its collector asked a URL e2e/support/canned-vendors.mjs does not route, or its fixture no longer parses; otherwise update the map if the change is on purpose.`,
    );
  }
  console.log(
    `e2e: the server is cut off from the vendors (building a board: ${served} requests answered from fixtures, ${refused} refused, ${board.services.length - unknown} of ${board.services.length} services with a state)`,
  );

  // The release feeds and the changelog notes are read after that sweep; let them settle, then get the page.
  const waited = Date.now();
  await waitForQuietLog(log);
  // The board just built has none of them (it was built before they were read) and the cache would serve it to
  // the page for 45 seconds; a forced build joins them, once the cache allows one.
  await sleep(Math.max(0, builtAt + MIN_FORCED_REFRESH_MS + 500 - Date.now()));
  const refreshed = await refreshBoardOnce(baseURL);
  let missing: string[] = [];
  let attempts = 0;
  for (const deadline = Date.now() + FIRST_RENDER_DEADLINE_MS; ; await sleep(1000)) {
    attempts += 1;
    missing = missingFromFirstRender(await (await fetch(new URL("/", baseURL))).text());
    if (missing.length === 0 || Date.now() >= deadline) break;
  }
  if (missing.length > 0) {
    throw new Error(
      `The first page render does not carry the release feeds and changelog notes within ${FIRST_RENDER_DEADLINE_MS / 1000} s (${attempts} requests): missing ${missing.join(", ")}.\nThe browser tests would hydrate a page without them. Check that the feed URLs are routed in e2e/support/canned-vendors.mjs and still parse, and update EXPECTED_RELEASE_LINES / MIKROTIK_NOTE in e2e/support/first-render.ts if the change is on purpose.`,
    );
  }
  console.log(
    `e2e: the first page render carries the release lines (${attempts} request${attempts === 1 ? "" : "s"}, ${((Date.now() - waited) / 1000).toFixed(1)} s after the board${refreshed ? "" : "; the board was not refreshed, so it waited for the cache to expire"})`,
  );

  return async () => {
    const all = entries(log);
    console.log(
      `e2e: ${count(all, "served")} vendor requests answered from fixtures and ${count(all, "refused")} refused in all; none left the machine (the stub has no other route)`,
    );
    rmSync(log, { force: true });
  };
}
