import { MAX_NOTE_CHARS, MAX_NOTE_LINES } from "./bounds.ts";
import type { ComponentHealth, ReleaseFeed, ReleaseFeedEntry, ReleaseInfo, ServiceSnapshot } from "./types.ts";
import { vendorUrl } from "./vendor-url.ts";

/** A date a release tracker gave: the moment, and whether the source gave only a day (then it is a UTC calendar day). */
export type ReleaseDate = { at: number; dayOnly: boolean };

/** One row of a release tracker's Details: a channel, an OS or a Windows version. */
export type ReleaseEntry = {
  /** The channel, OS or version the tracker lists it under: "RouterOS 7 stable", "iOS", "26H2". */
  name: string;
  /** The version, when it says more than the name does. Without the collector's release data, the card's own detail line. */
  version?: string;
  build?: string;
  releasedAt?: ReleaseDate;
  /** The latest update, only when it is a different day from the release. */
  updatedAt?: ReleaseDate;
  /** Released in the last two weeks: the collectors mark it as maintenance, and the card says "New release". */
  fresh: boolean;
  /** The vendor's page for it, https only; the tracker's own page when the release has none. */
  url: string;
  /** Whether `url` is this release's own page, not the tracker's page. */
  own: boolean;
  /** What the collector calls the link ("Release notes", "Apple Developer post"); absent when it did not say. */
  linkLabel?: string;
  /** A few plain-text lines from the vendor's notes; empty when the source has none. */
  notes: string[];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A date from a release, or undefined when it is missing or unreadable. A bare "2026-09-29" is a UTC day. */
export function releaseDate(value: string | undefined): ReleaseDate | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? { at, dayOnly: DAY.test(value) } : undefined;
}

const sameDay = (a: ReleaseDate, b: ReleaseDate) =>
  new Date(a.at).toISOString().slice(0, 10) === new Date(b.at).toISOString().slice(0, 10);

/**
 * Whether a service has Details to open: a release tracker (the Releases
 * category) that lists at least one channel, OS or version, or a status card
 * whose vendor's release feed was read. A tracker that could not be read lists
 * none, and a feed that could not be read is absent: neither has a true thing
 * to show.
 */
export function hasReleaseDetails(service: Pick<ServiceSnapshot, "category" | "components" | "releaseFeed">): boolean {
  if (service.category === "updates") return service.components.length > 0;
  return (service.releaseFeed?.entries.length ?? 0) > 0;
}

/** The status card's release feed, when it has one to show: the Releases trackers never do. */
export function releaseFeedOf(service: Pick<ServiceSnapshot, "category" | "releaseFeed">): ReleaseFeed | undefined {
  return service.category !== "updates" && service.releaseFeed && service.releaseFeed.entries.length > 0
    ? service.releaseFeed
    : undefined;
}

/** Where the Details' entries come from, for their links and the "no notes" line: the feed's name, or the tracker's. */
export function releaseSource(service: ServiceSnapshot): { name: string; url: string } {
  const feed = releaseFeedOf(service);
  return feed ? { name: feed.sourceName, url: feed.sourceUrl } : { name: service.sourceName, url: service.sourceUrl };
}

// Plain text, whatever came in: a few lines, each short.
function noteLinesOf(release: ReleaseInfo): string[] {
  return (Array.isArray(release.notes) ? release.notes : [])
    .filter((line): line is string => typeof line === "string" && line.trim() !== "")
    .slice(0, MAX_NOTE_LINES)
    .map((line) => (line.length > MAX_NOTE_CHARS ? `${line.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : line));
}

function entryOf(service: ServiceSnapshot, component: ComponentHealth): ReleaseEntry {
  const release = component.release;
  const url = vendorUrl(release?.url, service.sourceUrl);
  const base = {
    name: component.name,
    fresh: component.health === "maintenance",
    url,
    own: Boolean(release?.url) && url !== service.sourceUrl,
  };
  if (!release) {
    // A snapshot from a collector that predates the Details: the one-line version it did print, and no more.
    return { ...base, version: component.detail || undefined, notes: [] };
  }
  const releasedAt = releaseDate(release.releasedAt);
  const updatedAt = releaseDate(release.updatedAt);
  return {
    ...base,
    version: release.version && release.version !== component.name ? release.version : undefined,
    build: release.build || undefined,
    linkLabel: typeof release.linkLabel === "string" && release.linkLabel.trim() ? release.linkLabel : undefined,
    releasedAt,
    updatedAt: updatedAt && (!releasedAt || !sameDay(updatedAt, releasedAt)) ? updatedAt : undefined,
    notes: noteLinesOf(release),
  };
}

// An entry of a vendor's feed: named by its title, never "New release" (that tag is the trackers' 14-day rule),
// and its version shown only when the title does not already say it.
function feedEntryOf(feed: ReleaseFeed, entry: ReleaseFeedEntry): ReleaseEntry {
  const { release } = entry;
  const url = vendorUrl(release.url, feed.sourceUrl);
  return {
    name: entry.title,
    version: release.version && !entry.title.includes(release.version) ? release.version : undefined,
    fresh: false,
    url,
    own: url !== feed.sourceUrl,
    linkLabel: typeof release.linkLabel === "string" && release.linkLabel.trim() ? release.linkLabel : undefined,
    releasedAt: releaseDate(release.releasedAt),
    notes: noteLinesOf(release),
  };
}

/**
 * Everything the Details list: a tracker's channels, OS or versions in the
 * order its collector gives them, or a status card's feed entries, newest
 * first.
 */
export function releaseEntries(service: ServiceSnapshot): ReleaseEntry[] {
  if (!hasReleaseDetails(service)) return [];
  const feed = releaseFeedOf(service);
  if (feed) return feed.entries.map((entry) => feedEntryOf(feed, entry));
  return service.components.map((component) => entryOf(service, component));
}
