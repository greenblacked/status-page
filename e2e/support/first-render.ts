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
 */

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
