import { boundSnapshot } from "./bounds.ts";
import {
  mikrotikChangelogIsFor,
  mikrotikChangelogNote,
  mikrotikChangelogNotes,
  mikrotikChangelogUrl,
  summarizeMikrotikChangelog,
} from "./changelog.ts";
import { fetchText } from "./http.ts";
import { RELEASE_FEED_RETRY_MS } from "./release-feeds.server.ts";
import type { ReleaseNote, ServiceSnapshot } from "./types.ts";

// The notes of a MikroTik card: the newest release's first changelog note as the card's summary, each version's
// first few notes in its Details, and a short note per version (how many changes, which areas, how many the vendor
// flags important) for its row and its Details. They are advisory, like the release feeds
// (release-feeds.server.ts), and follow the same rules: the MikroTik collector reads the version channels only,
// which is all its health and versions need; the changelogs are read after the health sweep has settled
// (collect-board.ts), in the background and never waited for, and cached for the next board. A changelog host that
// is slow, failing or gone therefore cannot delay the sweep or change any result: the card keeps the "Latest
// RouterOS ..." line and the versions without notes until a read succeeds.
//
// A released version's changelog does not change, so a read that parsed is kept for the isolate (at most
// NOTES_REMEMBERED versions, oldest out first); one that failed or did not parse is left alone for
// RELEASE_FEED_RETRY_MS, as a failed feed is, and then asked for again.

/**
 * What the row, the Details and the summary take from one version's changelog. `note` is absent when the section
 * cannot be counted for certain (it may have been cut off by the read), while the first notes are still there.
 */
export type MikrotikNotes = { summary: string; notes: string[]; note?: ReleaseNote };

const NOTES_REMEMBERED = 16;
/** Like every side request: short, because the board never waits on it. */
const NOTES_TIMEOUT_MS = 4000;
/**
 * RouterOS changelogs run to hundreds of kilobytes and the newest release's notes are the first lines: ask for the
 * start. A server that ignores the range sends the whole file, which fetchText caps.
 */
const CHANGELOG_RANGE_BYTES = 65_536;

/**
 * Whether a read is certainly the entire file, judged from bytes and HTTP metadata and never from the decoded text
 * (a cut can fall inside a multi-byte character, so the text's length says nothing about it): a body shorter than
 * the range asked for was not cut by our own limit, and a 206 whose Content-Range total equals what arrived is the
 * whole file. Exactly the range's size, an unknown ("*") or missing total, or anything else is not known to be whole.
 */
export function isWholeChangelog(received: number, status: number, contentRange: string): boolean {
  if (received < CHANGELOG_RANGE_BYTES) return true;
  if (status !== 206) return false;
  const match = /^bytes 0-(\d{1,15})\/(\d{1,15})$/.exec(contentRange.trim());
  return match !== null && Number(match[2]) === received && Number(match[1]) === received - 1;
}

const readings = new Map<string, { at: number; read: MikrotikNotes | undefined }>();

function remember(version: string, read: MikrotikNotes | undefined): void {
  readings.delete(version);
  // Oldest first out: a Map iterates in insertion order. The channels list five versions at most.
  while (readings.size >= NOTES_REMEMBERED) {
    const oldest = readings.keys().next();
    if (oldest.done) break;
    readings.delete(oldest.value);
  }
  readings.set(version, { at: Date.now(), read });
}

/** Forgets the changelogs read so far; for tests, which serve different files under the same version. */
export function clearMikrotikNotesCache(): void {
  readings.clear();
}

function isDue(version: string): boolean {
  const seen = readings.get(version);
  return !seen || (!seen.read && Date.now() - seen.at >= RELEASE_FEED_RETRY_MS);
}

/** The versions a MikroTik card lists, once each, or none for a card that could not be read. */
function versionsOf(service: ServiceSnapshot): string[] {
  if (service.id !== "mikrotik" || service.failure) return [];
  const versions = new Set<string>();
  for (const component of service.components) {
    const version = component.release?.version;
    if (version) versions.add(version);
  }
  return [...versions];
}

async function readNotes(version: string): Promise<MikrotikNotes | undefined> {
  // The collector already refuses a malformed version; building the URL through the same check keeps it that way.
  const url = mikrotikChangelogUrl(version);
  if (!url) return undefined;
  try {
    const { body, bytes, status, contentRange } = await fetchText(url, {
      headers: { Range: `bytes=0-${CHANGELOG_RANGE_BYTES - 1}` },
      timeoutMs: NOTES_TIMEOUT_MS,
    });
    // A body with no "What's new in" section and a bullet under it (empty, truncated, an HTML error page served
    // with a 200), or one whose section is for another version, is a failed read, not this version's changelog.
    if (!mikrotikChangelogIsFor(body, version)) return undefined;
    const notes = mikrotikChangelogNotes(body);
    if (notes.length === 0) return undefined;
    const note = mikrotikChangelogNote(body, version, {
      whole: isWholeChangelog(bytes.byteLength, status, contentRange),
    });
    return { summary: summarizeMikrotikChangelog(body), notes, ...(note ? { note } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Starts reading the changelog of every version the MikroTik card lists that is not in the cache (or failed
 * long enough ago), all at once, and returns at once. The promise settles when every read has finished and been
 * cached for the next board; it never rejects. Call it only once the health sweep has settled.
 */
export function startMikrotikNotes(services: readonly ServiceSnapshot[]): Promise<void> {
  const versions = new Set(services.flatMap(versionsOf));
  const reads: Promise<void>[] = [];
  for (const version of versions) {
    if (!isDue(version)) continue;
    reads.push(
      readNotes(version).then(
        (read) => remember(version, read),
        // readNotes does not throw; if it ever did, the version is simply left for a retry period.
        () => remember(version, undefined),
      ),
    );
  }
  return Promise.all(reads).then(() => undefined);
}

/**
 * The services with the MikroTik notes the cache holds at this moment added: each version's notes on its
 * component, and the newest release's first note as the summary. Only those two are touched: health, versions,
 * incidents and the other cards are exactly the collector's.
 */
export function withMikrotikNotes(services: ServiceSnapshot[]): ServiceSnapshot[] {
  return services.map((service) => {
    if (versionsOf(service).length === 0) return service;
    const known = (version: string | undefined) => (version ? readings.get(version)?.read : undefined);
    let changed = false;
    const components = service.components.map((component) => {
      const read = known(component.release?.version);
      if (!read || !component.release) return component;
      changed = true;
      return {
        ...component,
        release: { ...component.release, notes: read.notes, ...(read.note ? { note: read.note } : {}) },
      };
    });
    // The notes summary is the newest release by date (the first channel when none is dated). The collector's
    // own no-notes line names the stable channel when there is one, so the two can describe different releases.
    const newest = service.components.reduce((current, next) => {
      const currentTime = Date.parse(current.release?.releasedAt ?? "") || 0;
      const nextTime = Date.parse(next.release?.releasedAt ?? "") || 0;
      return nextTime > currentTime ? next : current;
    }, service.components[0]);
    const summary = known(newest?.release?.version)?.summary;
    if (summary) changed = true;
    return changed ? boundSnapshot({ ...service, components, ...(summary ? { summary } : {}) }) : service;
  });
}
