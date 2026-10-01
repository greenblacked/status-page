/**
 * The Android OS releases the Android Developers Blog announces, read from its
 * Atom feed (https://developer.android.com/static/blog/atom.xml). Google
 * publishes no feed or API of OS releases themselves, so the posts that
 * announce one are the official machine-readable record: "Android 17 is here",
 * "Android 17 QPR1 is rolling out". A release Google announces in a new post
 * shows up here with no code change, so nothing below lists versions.
 *
 * The feed holds only the blog's latest posts (about twenty, some weeks),
 * so a release drops out of it when newer posts push it off. The collector
 * says so on the card instead of reading it as broken.
 *
 * Titles are vendor text of any length and shape, so the reading is one pass
 * over bounded pieces, never a regex that can backtrack against itself.
 */
export type AndroidRelease = {
  /** "17 QPR1", "17" or "16.1": the version as the post names it. */
  version: string;
  /** "Android 17 QPR1": the version with the OS name, what the card shows. */
  name: string;
  /** The post's publication time as ISO 8601. */
  publishedAt?: string;
};

export const ANDROID_NAME = "Android";

/** The blog's Atom feed, the one place the posts are read from. */
export const ANDROID_FEED_URL = "https://developer.android.com/static/blog/atom.xml";

/** Newest releases kept: the ones recent enough to still be in the feed. */
const MAX_RELEASES = 4;
/** A title is read up to this long; the rest of a runaway one is never looked at. */
const MAX_TITLE_READ = 300;

// A post about a build that is not out yet is not a release. Compared with
// whole words from the title, so "Betamax" does not count and "Beta 2" does.
const PRE_RELEASE_WORDS = new Set([
  "beta",
  "beta1",
  "beta2",
  "beta3",
  "preview",
  "previews",
  "canary",
  "alpha",
  "rc",
  "rc1",
  "rc2",
  "candidate",
  "developer",
  "dp1",
  "dp2",
  "dp3",
  "dp4",
  "dp5",
  "coming",
  "soon",
  "upcoming",
  "expect",
]);

// The words a post uses to say a version is out.
const RELEASE_WORDS = new Set([
  "here",
  "released",
  "releases",
  "live",
  "available",
  "rolling",
  "rolls",
  "launches",
  "launched",
  "stable",
  "arrives",
  "out",
]);

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

// Up to `max` digits at `at`; the digits, or "" when there are none or more than `max` of them.
function digitsAt(text: string, at: number, max: number): string {
  let end = at;
  while (isDigit(text[end])) end += 1;
  return end > at && end - at <= max ? text.slice(at, end) : "";
}

/**
 * The version a release post's title names, or null when the title is not an
 * announcement that a stable Android version is out. The title starts with
 * "Android" and a version ("17", "16.1"), then optionally "QPR" and a number
 * ("16 QPR2"), and says it is out ("is here", "is released to AOSP",
 * "is rolling out") without being about a beta, a preview or a release candidate.
 */
export function parseAndroidReleaseTitle(title: string): string | null {
  let text = title.trim().slice(0, MAX_TITLE_READ);
  if (text.slice(0, 4).toLowerCase() === "the ") text = text.slice(4).trimStart();
  if (text.slice(0, 8).toLowerCase() !== "android ") return null;

  let at = 8;
  const major = digitsAt(text, at, 2);
  if (!major) return null;
  at += major.length;
  let version = major;
  if (text[at] === "." && digitsAt(text, at + 1, 2)) {
    const minor = digitsAt(text, at + 1, 2);
    version = `${major}.${minor}`;
    at += 1 + minor.length;
  }
  // The version ends at a space or punctuation, not in the middle of a word or number.
  if (/[\p{L}\p{N}.]/u.test(text[at] ?? "")) return null;

  if (text[at] === " " && text.slice(at + 1, at + 4).toLowerCase() === "qpr") {
    const level = digitsAt(text, at + 4, 2);
    if (level && !/[\p{L}\p{N}]/u.test(text[at + 4 + level.length] ?? "")) {
      version = `${version} QPR${level}`;
      at += 4 + level.length;
    }
  }

  let release = false;
  for (const word of text
    .slice(at)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (PRE_RELEASE_WORDS.has(word)) return null;
    if (RELEASE_WORDS.has(word)) release = true;
  }
  return release ? version : null;
}

/**
 * The Android releases among a feed's posts, newest first, one per version
 * (when a version has two posts, the newest counts), at most MAX_RELEASES.
 * Posts with no readable date rank last. An empty list is a feed with no
 * release post in it, which is not an error.
 */
export function androidReleases(posts: Array<{ title: string; publishedAt?: string }>): AndroidRelease[] {
  const byVersion = new Map<string, AndroidRelease>();
  for (const post of posts) {
    const version = parseAndroidReleaseTitle(post.title);
    if (!version) continue;
    const time = Date.parse(post.publishedAt ?? "");
    const publishedAt = Number.isFinite(time) ? new Date(time).toISOString() : undefined;
    const earlier = byVersion.get(version);
    if (!earlier || (publishedAt ?? "") > (earlier.publishedAt ?? "")) {
      byVersion.set(version, { version, name: `${ANDROID_NAME} ${version}`, publishedAt });
    }
  }
  return [...byVersion.values()]
    .sort((a, b) =>
      (a.publishedAt ?? "") === (b.publishedAt ?? "")
        ? a.version < b.version
          ? 1
          : -1
        : (a.publishedAt ?? "") < (b.publishedAt ?? "")
          ? 1
          : -1,
    )
    .slice(0, MAX_RELEASES);
}
