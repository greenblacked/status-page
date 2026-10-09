// The canned vendor payloads the e2e preview server answers with (see no-vendors.mjs, which installs them as
// the server's `fetch`), kept apart from that file because importing it replaces the global `fetch`: this one
// only reads files, so the unit tests (scripts/ci/canned-vendors.test.ts) can import it.
import { existsSync, readFileSync } from "node:fs";

const FIXTURES = new URL("../../src/lib/status/__fixtures__/", import.meta.url);

const DAY = 86_400_000;

// The moment each group of fixtures was written around: the clock the collector tests pin for it
// (src/lib/status/collectors.test.ts and release-feeds.test.ts). A fixture's dates move by the distance from
// its group's moment to now, so every payload keeps the age it has in the unit tests: the collectors' windows
// (14 days and the like) see an active outage as active, a stale one as stale, and a release as fresh as it was
// there. One shift for all of them would put a feed written later than the status payloads in the future.
/** Status payloads, MikroTik channels and changelogs, Grok and the component lists: the "vendor payload fixtures" clock. */
export const ANCHOR_STATUS = Date.parse("2026-09-20T12:00:00.000Z");
/** Apple Developer Releases: the clock that keeps its Sep 21 betas in the window and its Sep 14 releases out. */
export const ANCHOR_APPLE = Date.parse("2026-09-29T12:00:00.000Z");
/** The Windows release table (26H2 available Sep 29) and the Android versions page (recorded that day). */
export const ANCHOR_WINDOWS = Date.parse("2026-10-01T12:00:00.000Z");
/** The release feeds (What's New, release notes, changelogs): written 2026-10-01 and -02, read at this clock. */
export const ANCHOR_RELEASES = Date.parse("2026-10-02T12:00:00.000Z");

const at = (anchor, file, more = {}) => ({ file, anchor, ...more });

// Vendor URL -> fixture file and the moment it was written around. `utf16` is the AWS Health feed, which is
// UTF-16 on the wire.
export const ROUTES = {
  "https://status.cloud.google.com/incidents.json": at(ANCHOR_STATUS, "gcp/incidents.json"),
  "https://status.cloud.google.com/products.json": at(ANCHOR_STATUS, "gcp/products.json"),
  "https://status.play.google.com/incidents.json": at(ANCHOR_STATUS, "play/incidents.json"),
  "https://status.play.google.com/products.json": at(ANCHOR_STATUS, "play/products.json"),
  "https://health.aws.amazon.com/public/currentevents": at(ANCHOR_STATUS, "aws/currentevents.json", { utf16: true }),
  "https://rssfeed.azure.status.microsoft/en-us/status/feed/": at(ANCHOR_STATUS, "azure/feed.xml"),
  "https://www.githubstatus.com/api/v2/summary.json": at(ANCHOR_STATUS, "github/summary.json"),
  "https://confluence.status.atlassian.com/api/v2/summary.json": at(ANCHOR_STATUS, "confluence/summary.json"),
  "https://api.status.io/1.0/status/5b36dc6502d06804c08349f7": at(ANCHOR_STATUS, "gitlab/status.json"),
  "https://status.x.ai/feed.xml": at(ANCHOR_STATUS, "grok/feed.xml"),
  "https://status.x.ai/v2/components.json": at(ANCHOR_STATUS, "grok/components.json"),
  "https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0": at(
    ANCHOR_STATUS,
    "steam/cm-list.json",
  ),
  "https://developer.apple.com/news/releases/rss/releases.rss": at(ANCHOR_APPLE, "apple-os/releases.rss"),
  "https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information": at(
    ANCHOR_WINDOWS,
    "windows/windows11-release-information.html",
  ),
  "https://developer.android.com/about/versions": at(ANCHOR_WINDOWS, "android-os/versions.html"),
  "https://aws.amazon.com/about-aws/whats-new/recent/feed/": at(ANCHOR_RELEASES, "aws/whats-new.xml"),
  "https://cloud.google.com/feeds/gcp-release-notes.xml": at(ANCHOR_RELEASES, "gcp/release-notes.xml"),
  "https://www.microsoft.com/releasecommunications/api/v2/azure/rss": at(ANCHOR_RELEASES, "azure/updates.xml"),
  "https://github.blog/changelog/feed/": at(ANCHOR_RELEASES, "github/changelog.xml"),
  "https://docs.gitlab.com/releases/all-releases.xml": at(ANCHOR_RELEASES, "gitlab/releases.xml"),
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=300&feeds=steam_community_announcements":
    at(ANCHOR_RELEASES, "steam/cs2-news.json"),
};

/** RouterOS: the channel files (upgrade.mikrotik.com/routeros/NEWESTa7.stable) and one CHANGELOG per version. */
function mikrotik(url) {
  const channel = /^https:\/\/upgrade\.mikrotik\.com\/routeros\/(NEWESTa\d\.[a-z-]+)$/.exec(url.href);
  if (channel) return at(ANCHOR_STATUS, `mikrotik/${channel[1]}`);
  const notes = /^https:\/\/download\.mikrotik\.com\/routeros\/([0-9a-z.]+)\/CHANGELOG$/.exec(url.href);
  return notes ? at(ANCHOR_STATUS, `mikrotik/${notes[1]}/CHANGELOG`) : undefined;
}

const pad = (value, width = 2) => String(value).padStart(width, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = MONTHS.join("|");

const day = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const clock = (date) => `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

// Every date the routed fixtures spell, one alternative each, so a stamp is matched by one rule and moved once.
// A date in running text ("On September 23, 2026, we released ...") is not one of them: no collector reads it.
const DATES = new RegExp(
  [
    // ISO 8601, with a fraction or without, in Z or in an offset: 2026-09-20T12:00:00Z, ...T05:00:00.000-07:00
    String.raw`\b(?<isoWall>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?<isoFraction>\.\d+)?(?<isoZone>Z|[+-]\d\d:?\d\d)`,
    // RFC 822 / 2822, as an RSS pubDate has it, in GMT, a US zone name, Z or a numeric offset:
    // Sun, 20 Sep 2026 09:30:00 GMT | ... PDT | ... +0000 | ... Z
    String.raw`\b(?:(?<rfcWeekday>${WEEKDAYS.join("|")}), )?(?<rfcDay>\d{1,2}) (?<rfcMonth>${MONTH}) (?<rfcYear>\d{4}) (?<rfcTime>\d\d:\d\d:\d\d) (?<rfcZone>[A-Z]{1,5}|[+-]\d{4})(?![\w+-])`,
    // RouterOS changelog headings: 2026-Sep-19 12:00 (the time is optional)
    String.raw`\b(?<mtYear>\d{4})-(?<mtMonth>${MONTH})-(?<mtDay>\d\d)(?: (?<mtHour>\d\d):(?<mtMinute>\d\d))?(?![\w-])`,
    // A bare day, as the Windows table has it: 2026-09-29. Not one inside an id or a slug (2026-09-20-title).
    String.raw`(?<![\w-])(?<dayYear>\d{4})-(?<dayMonth>\d\d)-(?<dayDay>\d\d)(?![\w-])`,
    // Unix seconds, 2020 to 2029, alone (a 10-digit run inside a longer number, a word or a decimal is not one).
    String.raw`(?<![\w.])(?<epoch>1[6-8]\d{8})(?![\w.])`,
  ].join("|"),
  "g",
);

/**
 * `text` with every date in it moved from the moment `from` to the moment `to` (ms since the epoch), each
 * spelled the way it was: ISO stamps keep their fraction and zone, RFC 822 stamps their weekday, padding and
 * zone name, RouterOS headings their month name, and Unix seconds stay seconds. The wall clock of a stamp
 * moves by the whole distance and its zone stays; a bare day (no time to carry the hours) moves by the number
 * of UTC days between the two moments, so a day stays a day.
 */
export function shiftDates(text, from, to) {
  const delta = to - from;
  const days = Math.floor(to / DAY) - Math.floor(from / DAY);
  return text.replace(DATES, (match, ...rest) => {
    const g = rest.at(-1);
    if (g.isoWall) {
      const moved = new Date(Date.parse(`${g.isoWall}${g.isoFraction ?? ""}Z`) + delta);
      if (Number.isNaN(moved.getTime())) return match;
      const wall = `${day(moved)}T${clock(moved)}`;
      // The fraction keeps its length: its first three digits are the milliseconds, any more stay as they were.
      const digits = g.isoFraction?.slice(1) ?? "";
      const millis = pad(moved.getUTCMilliseconds(), 3);
      const fraction = digits
        ? `.${digits.length < 3 ? millis.slice(0, digits.length) : millis + digits.slice(3)}`
        : "";
      return `${wall}${fraction}${g.isoZone}`;
    }
    if (g.rfcMonth) {
      const month = MONTHS.indexOf(g.rfcMonth);
      const [hour, minute, second] = g.rfcTime.split(":").map(Number);
      const base = Date.UTC(Number(g.rfcYear), month, Number(g.rfcDay), hour, minute, second);
      const moved = new Date(base + delta);
      if (Number.isNaN(moved.getTime())) return match;
      const date = g.rfcDay.length === 2 ? pad(moved.getUTCDate()) : String(moved.getUTCDate());
      const weekday = g.rfcWeekday ? `${WEEKDAYS[moved.getUTCDay()]}, ` : "";
      return `${weekday}${date} ${MONTHS[moved.getUTCMonth()]} ${moved.getUTCFullYear()} ${clock(moved)} ${g.rfcZone}`;
    }
    if (g.mtMonth) {
      const month = MONTHS.indexOf(g.mtMonth);
      const timed = g.mtHour !== undefined;
      const base = Date.UTC(
        Number(g.mtYear),
        month,
        Number(g.mtDay),
        timed ? Number(g.mtHour) : 0,
        timed ? Number(g.mtMinute) : 0,
      );
      const moved = new Date(base + (timed ? delta : days * DAY));
      const date = `${moved.getUTCFullYear()}-${MONTHS[moved.getUTCMonth()]}-${pad(moved.getUTCDate())}`;
      return timed ? `${date} ${pad(moved.getUTCHours())}:${pad(moved.getUTCMinutes())}` : date;
    }
    if (g.dayYear) {
      const base = Date.UTC(Number(g.dayYear), Number(g.dayMonth) - 1, Number(g.dayDay));
      const valid = new Date(base);
      // 2026-13-45 and the like are not days: leave them.
      if (Number.isNaN(base) || day(valid) !== match) return match;
      return day(new Date(base + days * DAY));
    }
    return String(Math.round(Number(g.epoch) + delta / 1000));
  });
}

/**
 * The canned answer for a vendor URL, or undefined for a URL with none: the fixture's text with its dates
 * moved from the moment it was written around to `now`, and how to put it on the wire.
 */
export function cannedPayload(url, now) {
  const route = ROUTES[url.href] ?? mikrotik(url);
  if (!route) return undefined;
  const path = new URL(route.file, FIXTURES);
  if (!existsSync(path)) return undefined;
  const body = shiftDates(readFileSync(path, "utf8"), route.anchor, now);
  const type = route.file.endsWith(".json") ? "application/json" : "text/xml";
  return { body, type, utf16: route.utf16 === true };
}
