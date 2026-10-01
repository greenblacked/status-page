import { MAX_NOTE_CHARS, MAX_NOTE_LINES } from "./bounds.ts";
import type { ComponentHealth, ServiceSnapshot } from "./types.ts";
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
 * category) that lists at least one channel, OS or version. A tracker that
 * could not be read lists none, and has nothing true to show.
 */
export function hasReleaseDetails(service: Pick<ServiceSnapshot, "category" | "components">): boolean {
  return service.category === "updates" && service.components.length > 0;
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
    releasedAt,
    updatedAt: updatedAt && (!releasedAt || !sameDay(updatedAt, releasedAt)) ? updatedAt : undefined,
    // Plain text, whatever came in: a few lines, each short.
    notes: (Array.isArray(release.notes) ? release.notes : [])
      .filter((line): line is string => typeof line === "string" && line.trim() !== "")
      .slice(0, MAX_NOTE_LINES)
      .map((line) => (line.length > MAX_NOTE_CHARS ? `${line.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : line)),
  };
}

/** Everything a tracker lists, in the order its collector gives, for the Details pop-up. */
export function releaseEntries(service: ServiceSnapshot): ReleaseEntry[] {
  return hasReleaseDetails(service) ? service.components.map((component) => entryOf(service, component)) : [];
}
