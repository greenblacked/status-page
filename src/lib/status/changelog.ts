import { clip, MAX_NOTE_CHARS } from "./bounds.ts";

export type ChannelRelease = {
  name: string;
  version: string;
  releasedAt?: string;
};

export type OsRelease = {
  family: string;
  title: string;
  version: string;
  beta: boolean;
  publishedAt?: string;
  link?: string;
};

const MAX_OS_VERSION_CHARS = 64;

const OS_FAMILIES = ["iOS", "iPadOS", "macOS", "watchOS", "tvOS", "visionOS"] as const;

// A RouterOS version as the NEWEST* files write it ("7.16.2", "7.17beta4",
// "7.17rc1"). It becomes a path segment of the changelog URL below and
// appears on the card, so anything else (a slash, "..", a query, markup)
// is treated as an unreadable file rather than trusted.
const MIKROTIK_VERSION = /^\d[\w.-]{0,31}$/;

export function isMikrotikVersion(version: string): boolean {
  return MIKROTIK_VERSION.test(version) && !version.includes("..");
}

/** The official changelog for a version, or null for one that fails isMikrotikVersion. */
export function mikrotikChangelogUrl(version: string): string | null {
  return isMikrotikVersion(version) ? `https://download.mikrotik.com/routeros/${version}/CHANGELOG` : null;
}

export function parseMikrotikNewest(body: string): { version: string; releasedAt?: string } | null {
  const match = body.trim().match(/^(\S+)(?:\s+(\d{9,}))?/);
  if (!match?.[1] || !isMikrotikVersion(match[1])) return null;
  const timestamp = match[2] ? Number(match[2]) * 1000 : NaN;
  return {
    version: match[1],
    releasedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined,
  };
}

export function summarizeMikrotikChangelog(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.find((line) => /^what's new in /i.test(line));
  const bullet = lines.find((line) => /^\*\)/.test(line));
  const note = bullet ? bullet.replace(/^\*\)\s*/, "").replace(/;\s*$/, "") : "";
  if (heading && note) return `${heading.replace(/:$/, "")} — ${note}`;
  return heading?.replace(/:$/, "") || note || "RouterOS changelog loaded.";
}

/** How many bullets of a release's changelog its Details keep. */
export const MAX_MIKROTIK_NOTES = 4;

// The most of a changelog read for notes: its first section is at the top, and a file that never
// reaches a second heading within this much is not read further.
const MAX_NOTES_SCAN_CHARS = 64_000;

/**
 * The first few notes of a RouterOS changelog's newest section: the bullets
 * ("*) bridge - fixed ...;" and the important "!) ..." ones) between the first
 * "What's new in" heading and the next, without the marker or the trailing
 * semicolon, each cut to MAX_NOTE_CHARS. Plain text only: the file is vendor
 * text and is shown as text. An empty list when the file has no such section.
 *
 * One forward pass over at most MAX_NOTES_SCAN_CHARS, line by line with
 * indexOf, that stops at the second heading or the fourth bullet.
 */
export function mikrotikChangelogNotes(text: string, max: number = MAX_MIKROTIK_NOTES): string[] {
  const end = Math.min(text.length, MAX_NOTES_SCAN_CHARS);
  const notes: string[] = [];
  let inSection = false;
  let pos = 0;
  while (pos < end && notes.length < max) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 || newline > end ? end : newline;
    const line = text.slice(pos, lineEnd).trim();
    pos = lineEnd + 1;
    if (line.length === 0) continue;
    if (line.slice(0, 13).toLowerCase() === "what's new in") {
      if (inSection) break;
      inSection = true;
      continue;
    }
    if (!inSection || line.length < 2 || line[1] !== ")" || (line[0] !== "*" && line[0] !== "!")) continue;
    const note = line.slice(2).trim().replace(/;$/, "").trim();
    if (note) notes.push(clip(note, MAX_NOTE_CHARS));
  }
  return notes;
}

/**
 * An Apple OS version split from its build: "27.2 beta 2 (24B5089g)" is the
 * version "27.2 beta 2" and the build "24B5089g". A version with no trailing
 * parenthesis, or one whose parenthesis is not a build number (letters and
 * digits only), is returned whole with no build.
 */
export function splitAppleBuild(version: string): { version: string; build?: string } {
  const text = version.trim();
  if (!text.endsWith(")")) return { version: text };
  const open = text.lastIndexOf("(");
  const build = open === -1 ? "" : text.slice(open + 1, -1).trim();
  const head = open === -1 ? "" : text.slice(0, open).trim();
  if (!head || build.length < 4 || build.length > 12 || !/^[0-9A-Za-z]+$/.test(build)) return { version: text };
  return { version: head, build };
}

export function parseAppleOsTitle(title: string): { family: string; version: string; beta: boolean } | null {
  // "<family> <version>": the family, whitespace, then the rest of one line.
  // Read with startsWith and trimStart, not `^(...)\s+(.+)$`, whose `\s+`
  // and `.+` both match spaces and backtrack against each other when the
  // version holds a line break (quadratic in the run of spaces before it).
  const text = title.trim();
  const family = OS_FAMILIES.find((name) => text.slice(0, name.length).toLowerCase() === name.toLowerCase());
  if (!family) return null;
  const rest = text.slice(family.length);
  if (rest.trimStart() === rest) return null;
  const version = rest.trim();
  if (!version || /[\n\r\u2028\u2029]/.test(version)) return null;
  return {
    family,
    // A version is a few words ("26.1 beta 3 (23B5045g)"); the title can be
    // anything, and the version goes into meta and the pulse log.
    version: clip(version, MAX_OS_VERSION_CHARS),
    beta: /\b(beta|rc)\b/i.test(title),
  };
}

export function appleOsReleases(items: Array<{ title: string; pubDate?: string; link?: string }>): OsRelease[] {
  const releases: OsRelease[] = [];
  for (const item of items) {
    const parsed = parseAppleOsTitle(item.title);
    if (!parsed) continue;
    releases.push({
      family: parsed.family,
      title: item.title,
      version: parsed.version,
      beta: parsed.beta,
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
      link: item.link,
    });
  }
  return releases;
}

export function latestAppleOsByFamily(items: Array<{ title: string; pubDate?: string; link?: string }>): OsRelease[] {
  const seen = new Set<string>();
  const latest: OsRelease[] = [];
  for (const release of appleOsReleases(items)) {
    if (seen.has(release.family)) continue;
    seen.add(release.family);
    latest.push(release);
    if (latest.length === OS_FAMILIES.length) break;
  }
  return latest.sort(
    (a, b) =>
      OS_FAMILIES.indexOf(a.family as (typeof OS_FAMILIES)[number]) -
      OS_FAMILIES.indexOf(b.family as (typeof OS_FAMILIES)[number]),
  );
}

export function formatReleaseAge(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

export function isFreshRelease(iso?: string, now = Date.now(), windowMs = 14 * 24 * 60 * 60 * 1000): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && now - time >= 0 && now - time <= windowMs;
}

export function formatVersionMap(entries: Array<{ name: string; version: string }>): string {
  return entries
    .filter((entry) => entry.name && entry.version)
    .map((entry) => `${entry.name}=${entry.version}`)
    .join("|");
}

export function parseVersionMap(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  const map: Record<string, string> = {};
  for (const part of raw.split("|")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    map[part.slice(0, index)] = part.slice(index + 1);
  }
  return map;
}

export function describeVersionChanges(
  previous: string | number | undefined,
  next: string | number | undefined,
): string {
  const before = parseVersionMap(previous);
  const after = parseVersionMap(next);
  const found: string[] = [];
  for (const [name, version] of Object.entries(after)) {
    if (before[name] !== version) found.push(`${name} ${version}`);
  }
  return found.join(" · ");
}

export function versionFingerprint(meta?: Record<string, string | number>): string {
  if (!meta) return "";
  if (typeof meta.versions === "string" && meta.versions) return meta.versions;
  if (typeof meta.latest === "string" && meta.latest) return meta.latest;
  return "";
}

export const MIKROTIK_CHANNELS: Array<{ name: string; file: string }> = [
  { name: "RouterOS 7 stable", file: "NEWESTa7.stable" },
  { name: "RouterOS 7 long-term", file: "NEWESTa7.long-term" },
  { name: "RouterOS 7 testing", file: "NEWESTa7.testing" },
  { name: "RouterOS 7 development", file: "NEWESTa7.development" },
  { name: "RouterOS 6 long-term", file: "NEWESTa6.long-term" },
];
