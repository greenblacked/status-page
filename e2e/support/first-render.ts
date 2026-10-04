/**
 * What the server's first page render carries from the background reads (the release feeds, the MikroTik
 * changelogs), pinned for the global setup and for the first-render test.
 *
 * A board is built from the health sweep alone; the feeds and the changelogs are read right after it and join the
 * next board build (src/lib/status/collect-board.ts), which the board cache makes 45 seconds away. A render that
 * came first would show no release line, and the hydration of one would go untested. The setup therefore waits
 * for the reads and for a page that carries them (e2e/support/global-setup.ts); these are what it, and the first
 * render, must carry. Change them when you change a canned feed (src/lib/status/__fixtures__) or its collector
 * on purpose.
 *
 * That holds while the canned feeds are young. A release feed is cached for RELEASE_FEED_TTL_MS (30 minutes,
 * src/lib/status/release-feeds.server.ts); after that a board build leaves it out and reads it again in the
 * background, so a render in a run older than that has no release line until a build later. The setup records
 * when it read them (FIRST_RENDER_AT_ENV) and the first-render test asks for the lines only within
 * RELEASE_LINES_GUARANTEED_MS of it; a longer run (every project, WebKit last) checks only that nothing
 * unexpected is there.
 */

/** The environment variable the global setup sets to the time (ms) at which it had the board read the release feeds. */
export const FIRST_RENDER_AT_ENV = "E2E_FIRST_RENDER_AT";

/**
 * How long after the setup's first board the first render is held to carry the release lines: under the feeds'
 * 30-minute cache (RELEASE_FEED_TTL_MS, which scripts/ci/first-render.test.ts keeps it below), with room for a
 * board cached for 45 seconds and served stale for 75 more.
 */
export const RELEASE_LINES_GUARANTEED_MS = 25 * 60_000;

/**
 * Whether the first render of this run still has to carry the release lines and the MikroTik notes: true until
 * RELEASE_LINES_GUARANTEED_MS after the setup read them, and when the setup left no time (a spec run on its own).
 */
export function firstRenderCarriesReleaseLines(
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): boolean {
  const at = Number(env[FIRST_RENDER_AT_ENV]);
  return !Number.isFinite(at) || now - at < RELEASE_LINES_GUARANTEED_MS;
}

/** The services whose canned feed has entries, so whose card shows a release line (`data-release-line`). */
export const EXPECTED_RELEASE_LINES: readonly string[] = ["aws", "azure", "cs2-europe", "gcp", "github", "gitlab"];

/**
 * A note from a canned MikroTik changelog (the development channel's first line): it reaches the page only
 * through the notes read after the sweep, in the Details of the MikroTik card.
 */
export const MIKROTIK_NOTE = "bgp - fixed route refresh handling when the peer restarts";

/** The ids of the cards in a server-rendered page that show a release line, sorted. */
export function releaseLineIds(html: string): string[] {
  const ids: string[] = [];
  for (const card of html.matchAll(/<article\b[^>]*\bid="service-([a-z0-9-]+)"[\s\S]*?<\/article>/g)) {
    if (card[0].includes("data-release-line")) ids.push(card[1]);
  }
  return ids.sort();
}

/** What a page lacks of the pinned first render, or nothing when it has it all: for a failure message. */
export function missingFromFirstRender(html: string): string[] {
  const found = new Set(releaseLineIds(html));
  const lacking = EXPECTED_RELEASE_LINES.filter((id) => !found.has(id)).map((id) => `release line of ${id}`);
  const extra = [...found]
    .filter((id) => !EXPECTED_RELEASE_LINES.includes(id))
    .map((id) => `unexpected release line of ${id}`);
  return [...lacking, ...extra, ...(html.includes(MIKROTIK_NOTE) ? [] : ["MikroTik changelog notes"])];
}
