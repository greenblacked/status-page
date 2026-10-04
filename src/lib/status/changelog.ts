import { clip, MAX_NOTE_CHARS, MAX_NOTE_LINES, MAX_TEXT_CHARS } from "./bounds.ts";
import type { ReleaseNote } from "./types.ts";

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

// A date as ISO 8601, or undefined when it is not one a Date can hold:
// `new Date(NaN).toISOString()` throws a RangeError, and a vendor field must
// cost at most its own line of detail, not the whole card.
function isoOrUndefined(value: string | number): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function parseMikrotikNewest(body: string): { version: string; releasedAt?: string } | null {
  const match = body.trim().match(/^(\S+)(?:\s+(\d{9,}))?/);
  if (!match?.[1] || !isMikrotikVersion(match[1])) return null;
  return { version: match[1], releasedAt: match[2] ? isoOrUndefined(Number(match[2]) * 1000) : undefined };
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

/** The start of a section heading, with the space after "in" so "What's new information" is not one. */
const SECTION_HEADING = "what's new in ";

function isSectionHeading(line: string): boolean {
  return line.slice(0, SECTION_HEADING.length).toLowerCase() === SECTION_HEADING;
}

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
    if (isSectionHeading(line)) {
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

/** Areas the row names before "+N more". */
const NOTE_ROW_AREAS = 3;
/** Distinct areas the Details name; every area is counted, and the ones past this are left unnamed ("and 15 more"). */
const NOTE_MAX_AREAS = 30;
/** The longest text before " - " that still reads as an area ("dhcpv4-server", "ipv6 nd"), not a sentence. */
const NOTE_AREA_CHARS = 24;

// An area is a short run of the characters MikroTik's own area names use. The text it is tested on is at most
// NOTE_AREA_CHARS long and the class is a single repeat, so the test is linear.
const NOTE_AREA = /^[A-Za-z0-9][A-Za-z0-9 ._,/()+-]*$/;

/** The area of a change line ("bgp" in "bgp - fixed a leak"), or undefined when the line does not start with one. */
function changeArea(body: string): string | undefined {
  // Look only as far as an area could reach, so a long line is not scanned for a " - " it cannot use.
  const dash = body.slice(0, NOTE_AREA_CHARS + 3).indexOf(" - ");
  if (dash < 1) return undefined;
  const area = body.slice(0, dash).trim();
  return area.length > 0 && area.length <= NOTE_AREA_CHARS && NOTE_AREA.test(area) ? area : undefined;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * A short note on one RouterOS release, from that version's own changelog section ("What's new in <version>")
 * and nothing else: how many change lines it has, the areas they name in order of first appearance (the text
 * before " - " in "*) bridge - fixed ..."), and the lines MikroTik flags important ("!) ..."). The row gets
 * "23 changes: bgp, wifi, container +9 more · 2 important"; the Details get every area and the important lines'
 * text. Undefined when:
 * - the section is not for `version` (the first heading must name it exactly), or has no change lines;
 * - the section may have been cut: a count is made only when a later "What's new in" heading shows that this
 *   section ended, or when `whole` says the text is certainly the entire file and the scan reached its end within
 *   MAX_NOTES_SCAN_CHARS. Whether a read was cut is a matter of bytes and HTTP metadata, which the text cannot show
 *   (a cut that falls among multi-byte characters still decodes to fewer characters than the byte limit), so the
 *   caller says it; without `whole` the text is taken as possibly cut, and an unclosed section has no note.
 *
 * One forward pass over at most MAX_NOTES_SCAN_CHARS, line by line with indexOf; the area test sees at most
 * NOTE_AREA_CHARS characters of a line.
 */
export function mikrotikChangelogNote(
  text: string,
  version: string,
  { whole = false }: { whole?: boolean } = {},
): ReleaseNote | undefined {
  if (!mikrotikChangelogIsFor(text, version)) return undefined;
  const end = Math.min(text.length, MAX_NOTES_SCAN_CHARS);
  // Every distinct area is counted (lowercase, so "BGP" and "bgp" are one); only the first NOTE_MAX_AREAS are named.
  const seenAreas = new Set<string>();
  const areas: string[] = [];
  const important: string[] = [];
  let changes = 0;
  let flagged = 0;
  let inSection = false;
  let ended = false;
  let pos = 0;
  while (pos < end) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 || newline > end ? end : newline;
    const line = text.slice(pos, lineEnd).trim();
    pos = lineEnd + 1;
    if (line.length === 0) continue;
    if (isSectionHeading(line)) {
      if (inSection) {
        ended = true;
        break;
      }
      inSection = true;
      continue;
    }
    if (!inSection || line.length < 2 || line[1] !== ")" || (line[0] !== "*" && line[0] !== "!")) continue;
    // The text of the change, as the first notes read it: a bullet with nothing after it is not a change.
    const body = line.slice(2).trim().replace(/;$/, "").trim();
    if (!body) continue;
    changes += 1;
    const area = changeArea(body);
    if (area && !seenAreas.has(area.toLowerCase())) {
      seenAreas.add(area.toLowerCase());
      if (areas.length < NOTE_MAX_AREAS) areas.push(area);
    }
    if (line[0] === "!") {
      flagged += 1;
      if (important.length < MAX_NOTE_LINES) important.push(clip(body, MAX_NOTE_CHARS));
    }
  }
  // A later heading closed the section, or the text is the whole file and was scanned to its end: either way the
  // count is the section's. Anything else may have lost lines to a cut, and a count would be a guess.
  if (changes === 0 || (!ended && !(whole && text.length <= MAX_NOTES_SCAN_CHARS))) return undefined;

  const total = seenAreas.size;
  const more = total - NOTE_ROW_AREAS;
  const count = plural(changes, "change", "changes");
  let row = count;
  if (total > 0) row += `: ${areas.slice(0, NOTE_ROW_AREAS).join(", ")}${more > 0 ? ` +${more} more` : ""}`;
  if (flagged > 0) row += ` · ${flagged} important`;
  // The Details hold at most MAX_TEXT_CHARS, and a longer text is cut at its end, which would lose the "and N more"
  // and the important-lines sentence. So the end is written first and the areas are named only as far as the
  // whole fits, with "and N more" counting every area left unnamed. (The row is short by construction: three
  // areas of at most NOTE_AREA_CHARS and three counts, far under MAX_NOTE_CHARS.)
  // The Details list at most MAX_NOTE_LINES important lines; say so when the release has more.
  const importantSentence =
    flagged > important.length ? ` ${flagged} are marked important; the first ${important.length} are listed.` : "";
  const detailWith = (named: number) => {
    if (total === 0) return `${count}.${importantSentence}`;
    const head = `${count} in ${plural(total, "area", "areas")}`;
    if (named === 0) return `${head}.${importantSentence}`;
    const left = total - named;
    return `${head}: ${areas.slice(0, named).join(", ")}${left > 0 ? ` and ${left} more` : ""}.${importantSentence}`;
  };
  // The most areas named that still fit; not "stop at the first that does not", because naming the last area
  // drops the "and N more" and can fit where the one before it did not.
  let named = areas.length;
  while (named > 0 && detailWith(named).length > MAX_TEXT_CHARS) named -= 1;
  const detail = detailWith(named);
  return { text: row, detail, ...(important.length > 0 ? { important } : {}) };
}

/**
 * Whether a RouterOS changelog's first non-empty line is the "What's new in <version>" heading of
 * exactly this version (case-insensitive): after the version comes the end of the line, a space,
 * "(" or ":", so "7.2" does not match a "7.21" heading. Only the first line is read.
 */
export function mikrotikChangelogIsFor(text: string, version: string): boolean {
  const end = Math.min(text.length, MAX_NOTES_SCAN_CHARS);
  let pos = 0;
  while (pos < end) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 || newline > end ? end : newline;
    const line = text.slice(pos, lineEnd).trim();
    pos = lineEnd + 1;
    if (line.length === 0) continue;
    if (!isSectionHeading(line)) return false;
    const rest = line.slice(SECTION_HEADING.length);
    if (rest.slice(0, version.length).toLowerCase() !== version.toLowerCase()) return false;
    const next = rest[version.length];
    return next === undefined || next === " " || next === "(" || next === ":";
  }
  return false;
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
      publishedAt: item.pubDate ? isoOrUndefined(item.pubDate) : undefined,
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

// The calendar day in UTC, like every time the server writes (AGENTS.md: never formatted on the server in a
// zone). A host's own zone would move a day the vendor gave as midnight UTC (a Windows release) to the day before
// in the Americas, and an evening release to the day after in the Pacific.
const RELEASE_DAY_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

export function formatReleaseAge(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return RELEASE_DAY_FORMAT.format(date);
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
