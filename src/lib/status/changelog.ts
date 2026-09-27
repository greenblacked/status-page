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

const OS_FAMILIES = ["iOS", "iPadOS", "macOS", "watchOS", "tvOS", "visionOS"] as const;

// A RouterOS version as the NEWEST* files write it ("7.16.2", "7.17beta4",
// "7.17rc1"). It becomes a path segment of the changelog URL below and
// appears on the card, so anything else (a slash, "..", a query, markup)
// is treated as an unreadable file rather than trusted.
const MIKROTIK_VERSION = /^\d[\w.-]*$/;

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
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^what's new in /i.test(line));
  const bullet = lines.find((line) => /^\*\)/.test(line));
  const note = bullet ? bullet.replace(/^\*\)\s*/, "").replace(/;\s*$/, "") : "";
  if (heading && note) return `${heading.replace(/:$/, "")} — ${note}`;
  return heading?.replace(/:$/, "") || note || "RouterOS changelog loaded.";
}

export function parseAppleOsTitle(title: string): { family: string; version: string; beta: boolean } | null {
  const match = title.trim().match(/^(iOS|iPadOS|macOS|watchOS|tvOS|visionOS)\s+(.+)$/i);
  if (!match) return null;
  const family = OS_FAMILIES.find((name) => name.toLowerCase() === match[1].toLowerCase());
  if (!family) return null;
  return {
    family,
    version: match[2].trim(),
    beta: /\b(beta|rc)\b/i.test(title),
  };
}

export function appleOsReleases(
  items: Array<{ title: string; pubDate?: string; link?: string }>,
): OsRelease[] {
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

export function latestAppleOsByFamily(
  items: Array<{ title: string; pubDate?: string; link?: string }>,
): OsRelease[] {
  const seen = new Set<string>();
  const latest: OsRelease[] = [];
  for (const release of appleOsReleases(items)) {
    if (seen.has(release.family)) continue;
    seen.add(release.family);
    latest.push(release);
    if (latest.length === OS_FAMILIES.length) break;
  }
  return latest.sort(
    (a, b) => OS_FAMILIES.indexOf(a.family as (typeof OS_FAMILIES)[number]) - OS_FAMILIES.indexOf(b.family as (typeof OS_FAMILIES)[number]),
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
