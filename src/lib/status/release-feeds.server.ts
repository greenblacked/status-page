import {
  boundReleaseFeed,
  clip,
  MAX_FEED_ENTRIES,
  MAX_FEED_TITLE_CHARS,
  MAX_NOTE_CHARS,
  MAX_NOTE_LINES,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
} from "./bounds.ts";
import { fetchText, HEAD_BYTES, meterBytes, PayloadError } from "./http.ts";
import {
  classifyFailure,
  decodeXmlEntities,
  decodeXmlField,
  epochToIso,
  isoTimestamp,
  MAX_RSS_SCANNED,
  records,
  stripHtml,
} from "./sources.server.ts";
import type { ReleaseFeed, ReleaseFeedEntry, ReleaseInfo, ServiceId, ServiceSnapshot, SourceFailure } from "./types.ts";
import { vendorUrl } from "./vendor-url.ts";

// What a vendor's own release or changelog feed adds to a status card: the
// newest entry on the card's second line, a few more behind its Details. It is
// advisory. Nothing here touches a card's health: the feeds are read beside the
// health collectors and never waited for (a board takes the feeds that are in
// hand when its health sweep ends, and a slower one joins the next board), a
// feed that cannot be read is logged (`release_feed_failed`), reported by
// `npm run source-health`, and leaves the card exactly as it was.
//
// Release feeds change slowly, so they are not part of every sweep. Each one is
// read at most once per RELEASE_FEED_TTL_MS in an isolate (RELEASE_FEED_RETRY_MS
// after a failure), which keeps the board's subrequests where they were: see
// SECURITY.md#release-feeds.

/** How long an isolate keeps a feed it read, before reading it again. */
export const RELEASE_FEED_TTL_MS = 30 * 60_000;
/** How long an isolate leaves a feed that failed alone before trying it again. */
export const RELEASE_FEED_RETRY_MS = 5 * 60_000;
/** The deadline of one feed read: short, like every side request. The board never waits on it (collect-board.ts). */
const RELEASE_TIMEOUT_MS = 4000;
/** Most of one entry's text looked at: only its first lines are ever shown. */
const MAX_ENTRY_CHARS = 100_000;
/** Newest entries read in full before the unusable ones are dropped and MAX_FEED_ENTRIES kept. */
const MAX_ENTRIES_READ = 12;
/** Most text blocks (paragraphs, list items, headings) read from one entry, and tags looked at to find them. */
const MAX_BLOCKS = 60;
const MAX_BLOCK_SCAN = 500;
/**
 * The part of a feed asked for when a vendor's whole history would pass the body cap. Range is only a hint (GitLab
 * and Google both ignore it and send everything): the body is cut at HEAD_BYTES as it is read, so the cut does
 * not depend on the server. Both feeds that need it list newest first, so the start of the body is the newest entries.
 */
const HEAD_RANGE = `bytes=0-${HEAD_BYTES - 1}`;

// ------------------------------------------------------------ XML entries ---

/** One entry of an RSS (`<item>`) or Atom (`<entry>`) feed, as text; cleaning and shaping come after. */
export type FeedItem = {
  title: string;
  /** The entry's description or content, decoded but still markup. */
  body: string;
  link?: string;
  /** ISO 8601, when the entry has a readable date. */
  at?: string;
};

const TAG_PATTERNS = new Map<string, { open: RegExp; close: RegExp }>();

// Two literal searches per field, like parseRssItems: the text between the
// first `<tag ...>` and the first `</tag>` after it. A self-closing or unclosed
// tag has no text. The patterns are global so the search can start at an index
// instead of slicing a copy of the entry.
function tagText(chunk: string, tag: string): string | undefined {
  let patterns = TAG_PATTERNS.get(tag);
  if (!patterns) {
    patterns = { open: new RegExp(`<${tag}(?=[\\s>/])`, "gi"), close: new RegExp(`</${tag}\\s*>`, "gi") };
    TAG_PATTERNS.set(tag, patterns);
  }
  patterns.open.lastIndex = 0;
  const start = patterns.open.exec(chunk);
  if (!start) return undefined;
  const gt = chunk.indexOf(">", start.index);
  if (gt === -1 || chunk[gt - 1] === "/") return undefined;
  patterns.close.lastIndex = gt + 1;
  const end = patterns.close.exec(chunk);
  return end ? chunk.slice(gt + 1, end.index) : undefined;
}

const LINK_TAG = /<link(?=[\s/>])[^<>]*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const REL = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const MAX_LINK_TAGS = 20;

// An Atom entry's `<link rel="alternate" href="..."/>` (no rel means alternate);
// self, enclosure and edit links are not the entry's page.
function atomLink(chunk: string): string | undefined {
  const tags = new RegExp(LINK_TAG.source, "gi");
  for (let seen = 0; seen < MAX_LINK_TAGS; seen += 1) {
    const tag = tags.exec(chunk)?.[0];
    if (tag === undefined) return undefined;
    const href = HREF.exec(tag);
    if (!href) continue;
    const rel = REL.exec(tag);
    if ((rel?.[1] ?? rel?.[2] ?? "alternate").trim().toLowerCase() !== "alternate") continue;
    return decodeXmlEntities(href[1] ?? href[2] ?? "").trim();
  }
  return undefined;
}

function linkOf(chunk: string): string | undefined {
  const atom = atomLink(chunk);
  if (atom) return atom;
  const text = tagText(chunk, "link");
  return text === undefined ? undefined : decodeXmlField(text).trim();
}

// RSS says pubDate, Atom published (first published) or updated, Dublin Core dc:date.
const DATE_TAGS = ["pubDate", "published", "updated", "dc:date"];

function dateOf(chunk: string): string | undefined {
  for (const tag of DATE_TAGS) {
    const raw = tagText(chunk, tag);
    if (raw === undefined) continue;
    const iso = isoTimestamp(decodeXmlField(raw).trim());
    if (iso) return iso;
  }
  return undefined;
}

/**
 * The newest entries of an RSS or Atom feed, newest first (at most
 * MAX_ENTRIES_READ). Every entry up to MAX_RSS_SCANNED is dated, because a
 * feed does not say which end is newest; only the newest are read in full.
 * An entry with no readable date ranks last and ties keep the feed's order.
 * Linear: each field is found by literal searches inside its own entry.
 */
export function parseFeedItems(xml: string, kind: "item" | "entry"): FeedItem[] {
  const open = new RegExp(`<${kind}[\\s>]`, "gi");
  const close = new RegExp(`</${kind}\\s*>`, "i");
  const scanned: Array<{ chunk: string; at: string | undefined; time: number; index: number }> = [];
  let match = open.exec(xml);
  while (match && scanned.length < MAX_RSS_SCANNED) {
    const next = open.exec(xml);
    const block = xml.slice(match.index + match[0].length, next ? next.index : xml.length);
    const closed = block.search(close);
    const chunk = closed === -1 ? block : block.slice(0, closed);
    const at = dateOf(chunk);
    scanned.push({ chunk, at, time: at ? Date.parse(at) : Number.NEGATIVE_INFINITY, index: scanned.length });
    match = next;
  }
  return scanned
    .sort((a, b) => (a.time === b.time ? a.index - b.index : a.time > b.time ? -1 : 1))
    .slice(0, MAX_ENTRIES_READ)
    .map(({ chunk, at }) => {
      const body = tagText(chunk, "description") ?? tagText(chunk, "content") ?? tagText(chunk, "summary") ?? "";
      return {
        title: decodeXmlField((tagText(chunk, "title") ?? "").slice(0, MAX_TITLE_CHARS * 4)).trim(),
        body: decodeXmlField(body.slice(0, MAX_ENTRY_CHARS)),
        link: linkOf(chunk),
        at,
      };
    });
}

// ------------------------------------------------------------- plain text ---

const SCRIPT_OPEN = /<(script|style)(?=[\s>/])/gi;

/**
 * `html` without its <script> and <style> elements, content included: their
 * text is code, not something a person reads. An element that never closes
 * runs to the end. Each tag is found once and the search for its end starts
 * where it began, so the cost is linear.
 */
export function dropScripts(html: string): string {
  const opener = new RegExp(SCRIPT_OPEN.source, "gi");
  let out = "";
  let from = 0;
  for (let cuts = 0; cuts < MAX_BLOCK_SCAN; cuts += 1) {
    const open = opener.exec(html);
    if (!open) break;
    out += html.slice(from, open.index);
    const close = new RegExp(`</${open[1]}\\s*>`, "gi");
    close.lastIndex = open.index;
    const end = close.exec(html);
    from = end ? end.index + end[0].length : html.length;
    opener.lastIndex = from;
    if (!end) break;
  }
  return out + html.slice(from);
}

// The named character references a vendor's HTML uses that XML does not predefine: punctuation, quotes and
// symbols (WordPress and Azure write &hellip; and &rsquo; into titles and excerpts). A small fixed list; an
// unknown name stays as written. A Map, so a name like "constructor" is never a key.
const HTML_NAMED_ENTITIES = new Map<string, string>([
  ["nbsp", " "],
  ["hellip", "\u2026"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["sbquo", "\u201a"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
  ["bdquo", "\u201e"],
  ["ndash", "\u2013"],
  ["mdash", "\u2014"],
  ["bull", "\u2022"],
  ["middot", "\u00b7"],
  ["copy", "\u00a9"],
  ["reg", "\u00ae"],
  ["trade", "\u2122"],
  ["laquo", "\u00ab"],
  ["raquo", "\u00bb"],
  ["times", "\u00d7"],
  ["deg", "\u00b0"],
  ["euro", "\u20ac"],
  ["pound", "\u00a3"],
  ["rarr", "\u2192"],
  ["larr", "\u2190"],
]);
// Lowercase letters only and at most eight of them: a bounded run after each "&", so linear in the text.
const HTML_NAMED_ENTITY = /&([a-z]{2,8});/g;

/** `text` with the common HTML named character references replaced; the XML ones are decoded elsewhere. */
export function decodeHtmlNames(text: string): string {
  return text.replace(HTML_NAMED_ENTITY, (match, name: string) => HTML_NAMED_ENTITIES.get(name) ?? match);
}

/**
 * `text` with its HTML character references read once: the named ones first, then the XML five and the numeric
 * ones. In that order a name written behind an escaped ampersand ("&amp;hellip;", a code span that shows the
 * entity) survives the first pass and is read only as "&hellip;", not as the ellipsis it names.
 */
function decodeHtmlText(text: string): string {
  return decodeXmlEntities(decodeHtmlNames(text));
}

/** Plain text from markup: scripts gone, tags gone, entities decoded, whitespace collapsed. */
function plainText(html: string): string {
  return decodeHtmlText(stripHtml(dropScripts(html)));
}

/**
 * A title from the feed's already XML-decoded field, read as HTML like a note is: markup gone, character
 * references read once ("Q&amp;amp;A" in the feed is "Q&amp;A" here, and "Q&A" on the card), whitespace collapsed.
 */
function titleText(raw: string): string {
  return decodeHtmlText(stripHtml(dropScripts(raw)));
}

const BLOCK_OPEN = /<(h[1-6]|p|li|div|br|tr|td|dd|dt)(?=[\s>/])[^<>]*>/gi;

export type TextBlock = { tag: string; text: string };

/**
 * The text of a piece of HTML, one block per heading, paragraph, list item or
 * line break, in order, each as plain text: tags gone, entities already decoded
 * by the caller, whitespace collapsed. Text before the first tag is a "text"
 * block. At most MAX_BLOCKS blocks and MAX_BLOCK_SCAN tags are looked at, in
 * the first MAX_ENTRY_CHARS characters. Linear: a tag body stops at the next
 * `<` or `>`.
 */
export function htmlBlocks(html: string): TextBlock[] {
  const source = dropScripts(html.slice(0, MAX_ENTRY_CHARS));
  const opener = new RegExp(BLOCK_OPEN.source, "gi");
  const blocks: TextBlock[] = [];
  let tag = "text";
  let from = 0;
  for (let scans = 0; scans < MAX_BLOCK_SCAN; scans += 1) {
    const match = opener.exec(source);
    const text = plainText(source.slice(from, match ? match.index : source.length));
    if (text) {
      blocks.push({ tag, text });
      if (blocks.length >= MAX_BLOCKS) break;
    }
    if (!match) break;
    tag = (match[1] ?? "text").toLowerCase();
    from = match.index + match[0].length;
  }
  return blocks;
}

// WordPress feeds (GitHub's changelog) end an excerpt with a line about the post.
const POST_FOOTER = /^the post .{1,300}? appeared first on /i;
const LINK_ONLY = /^(?:read|learn|find out) more[.!…]*$/i;

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const MORE_LINKS = ["learn more", "read more", "find out more"];

// Stripped markup leaves a space where a tag was ("<code>x</code>." reads "x ."), and a paragraph often ends in
// its "Learn more" link, which is a link and not a note. Plain string searches, so linear.
function tidy(text: string): string {
  let out = text.split(" .").join(".").split(" ,").join(",").split(" ;").join(";").split(" :").join(":");
  const lower = out.toLowerCase();
  for (const phrase of MORE_LINKS) {
    for (const end of [phrase, `${phrase}.`]) {
      if (lower.endsWith(end) && out.length > end.length) {
        out = out.slice(0, out.length - end.length).trimEnd();
        return out;
      }
    }
  }
  return out;
}

function isNote(text: string, title: string): boolean {
  if (text.length < 3 || sameText(text, title)) return false;
  const head = text.slice(0, MAX_NOTE_CHARS * 2);
  return !POST_FOOTER.test(head) && !LINK_ONLY.test(head);
}

/** The first paragraphs and list items of an entry as short plain lines, never repeating its title. */
function noteLines(blocks: TextBlock[], title: string): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (/^h[1-6]$/.test(block.tag) || !isNote(block.text, title)) continue;
    lines.push(clip(tidy(block.text), MAX_NOTE_CHARS));
    if (lines.length >= MAX_NOTE_LINES) break;
  }
  return lines;
}

// ----------------------------------------------------------------- shapes ---

type Shape = { title: string; version?: string; notes: string[] };
/** How an entry reads, or undefined for an entry the card should not show at all. */
type Shaper = (item: FeedItem, blocks: TextBlock[]) => Shape | undefined;

const plainShape: Shaper = (item, blocks) => ({ title: item.title, notes: noteLines(blocks, item.title) });

// GitLab: "GitLab 19.4 release notes" (the monthly release; older posts said "GitLab 18.4 released with ..."),
// "GitLab Patch Release: 19.4.1, 19.3.3, 19.2.7" and "GitLab Critical Patch Release: ...". The feed also carries
// "GitLab AI Gateway Critical Patch Release: ..." posts, which name no GitLab version and are left out.
// Anchored, with bounded runs of spaces, so the cost is linear in the title.
const GITLAB_RELEASED = /^GitLab\s{1,5}(\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)\s{1,5}(?:released|release\s{1,5}notes)\b/i;
const GITLAB_PATCH = /^GitLab\s{1,5}(?:critical\s{1,5})?patch\s{1,5}releases?\b/i;
const SEMVER = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const MAX_PATCH_VERSIONS = 12;

function versionKey(version: string): number[] {
  return version.split(".").map(Number);
}

/** Positive when dotted version `a` is higher than `b`, negative when lower, 0 when equal; number by number. */
function compareVersions(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const diff = (left[at] ?? 0) - (right[at] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The highest of some dotted versions, compared number by number. */
function newestVersion(versions: string[]): string | undefined {
  let best: string | undefined;
  for (const version of versions) {
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/**
 * The version a GitLab release post is about, or undefined for a title that
 * names none. A release post names its own version ("18.4"); a patch release
 * lists several (the supported branches), and the newest is the one that
 * moved.
 */
export function gitlabVersion(title: string): string | undefined {
  const text = title.slice(0, MAX_TITLE_CHARS);
  const released = GITLAB_RELEASED.exec(text);
  if (released) return released[1];
  const patch = GITLAB_PATCH.exec(text);
  if (!patch) return undefined;
  return newestVersion((text.slice(patch[0].length).match(SEMVER) ?? []).slice(0, MAX_PATCH_VERSIONS));
}

const gitlabShape: Shaper = (item, blocks) => {
  const version = gitlabVersion(item.title);
  // A post that names no GitLab version (the AI Gateway's patches) is not a GitLab release: it must never be the line.
  if (!version) return undefined;
  const label = `GitLab ${version}`;
  // The label is all the line says; the post's own title (which patch branches, what is new) is the first note.
  return { title: label, version, notes: [clip(item.title, MAX_NOTE_CHARS), ...noteLines(blocks, item.title)] };
};

// Google Cloud: an entry is a day ("September 30, 2025") holding a heading per
// product, then notes. The day is what the line's date already says, so the
// entry is named by its products: "Cloud Run, BigQuery and 3 more".
function gcpShape(item: FeedItem, blocks: TextBlock[]): Shape {
  const products: string[] = [];
  const notes: string[] = [];
  let product = "";
  for (const block of blocks) {
    if (block.tag === "h2") {
      product = clip(block.text, 60);
      if (!products.includes(product)) products.push(product);
    } else if (block.tag === "p" || block.tag === "li") {
      if (notes.length < MAX_NOTE_LINES && isNote(block.text, item.title)) {
        const text = tidy(block.text);
        notes.push(clip(product && !text.startsWith(product) ? `${product}: ${text}` : text, MAX_NOTE_CHARS));
      }
    }
  }
  const [first, second] = products;
  const title =
    first === undefined
      ? item.title
      : second === undefined
        ? first
        : products.length === 2
          ? `${first} and ${second}`
          : `${first}, ${second} and ${products.length - 2} more`;
  return { title, notes };
}

// ------------------------------------------------------------------ Steam ---

type SteamNewsItem = { gid?: unknown; title?: unknown; date?: unknown; contents?: unknown };

// Steam news is BBCode: [h1]Title[/h1], [list][*]item[/list], [url=...]text[/url], and
// {STEAM_CLAN_IMAGE}/path placeholders for pictures. Each pattern is bounded and
// stops at the next bracket, so a run of brackets costs one step each.
const BBCODE = /\[\/?[a-z*][a-z0-9*]{0,15}(?:=[^[\]]{0,200})?\]/gi;
const STEAM_IMAGE = /\{STEAM_CLAN_(?:LOADING_)?IMAGE\}\/[^\s[\]]{0,200}/g;
const STEAM_UPDATE_POST = /\b(?:update|release notes|patch)\b/i;
const MAX_STEAM_CONTENT_CHARS = 4000;

/** A Steam news post's text as short plain lines: BBCode, picture placeholders and markup gone. */
export function steamNoteLines(contents: string, title: string): string[] {
  const lines: string[] = [];
  for (const raw of contents.slice(0, MAX_STEAM_CONTENT_CHARS).split(/\r?\n/)) {
    const text = plainText(raw.replace(STEAM_IMAGE, " ").replace(BBCODE, " "));
    if (!isNote(text, title)) continue;
    lines.push(clip(tidy(text), MAX_NOTE_CHARS));
    if (lines.length >= MAX_NOTE_LINES) break;
  }
  return lines;
}

function steamEntries(source: ReleaseSource, payload: unknown): ReleaseFeedEntry[] {
  const list = (payload as { appnews?: { newsitems?: unknown } } | null)?.appnews?.newsitems;
  const posts = records<SteamNewsItem>(list).flatMap((row, index) => {
    const title = typeof row.title === "string" ? titleText(row.title.slice(0, MAX_TITLE_CHARS * 4)) : "";
    if (!title) return [];
    const at = epochToIso(row.date, 1000);
    return [{ row, title, at, time: at ? Date.parse(at) : Number.NEGATIVE_INFINITY, index }];
  });
  posts.sort((a, b) => (a.time === b.time ? a.index - b.index : a.time > b.time ? -1 : 1));
  // Patch notes are the posts called an update; a board with none of those shows the newest posts instead.
  const updates = posts.filter((post) => STEAM_UPDATE_POST.test(post.title.slice(0, MAX_FEED_TITLE_CHARS)));
  return (updates.length > 0 ? updates : posts).slice(0, MAX_FEED_ENTRIES).map(({ row, title, at }) => {
    const gid = typeof row.gid === "string" || typeof row.gid === "number" ? String(row.gid) : "";
    // Built from the numeric id rather than taken from the payload, whose `url` is a CDN redirect.
    const link = /^\d{1,24}$/.test(gid) ? `${source.pageUrl}/view/${gid}` : undefined;
    const notes = typeof row.contents === "string" ? steamNoteLines(row.contents, title) : [];
    return releaseEntry(source, { title, notes }, { link, at });
  });
}

// ---------------------------------------------------------------- sources ---

/** One vendor release feed: where it is read, how it reads, and where its links may go. */
export type ReleaseSource = {
  id: ServiceId;
  /** The name `source-health` and the logs use: "GitLab releases". */
  label: string;
  /** The feed's name in the Details: "GitLab releases". */
  name: string;
  /** The official feed (a documented RSS, Atom or JSON URL). */
  url: string;
  /** The vendor's page for the same thing, where the Details' fallback link goes. */
  pageUrl: string;
  /** Hosts an entry's link may be on (or a subdomain of one); any other link falls back to `pageUrl`. */
  hosts: string[];
  /** What an entry's link is called in the Details. */
  linkLabel: string;
  headers?: Record<string, string>;
  /** Read only the first HEAD_BYTES of the body (cut as it streams in) instead of refusing one over the body cap. */
  head?: boolean;
  /** Reads the response body into entries, newest first; throws PayloadError for a body that is not this feed. */
  read: (source: ReleaseSource, body: string) => ReleaseFeedEntry[];
  /** How an RSS or Atom entry becomes a title, a version and notes; plain text by default. */
  shape?: Shaper;
};

function releaseEntry(source: ReleaseSource, shaped: Shape, from: { link?: string; at?: string }): ReleaseFeedEntry {
  const notes = shaped.notes.filter((line) => line.trim() !== "").slice(0, MAX_NOTE_LINES);
  const release: ReleaseInfo = {
    // The vendor's version number, or "" for a changelog that does not number its entries.
    version: shaped.version ?? "",
    ...(from.at ? { releasedAt: from.at } : {}),
    url: vendorUrl(from.link, source.pageUrl, source.hosts),
    linkLabel: source.linkLabel,
    ...(notes.length > 0 ? { notes } : {}),
  };
  return { title: clip(shaped.title, MAX_FEED_TITLE_CHARS), release };
}

/**
 * Entries of one day, highest version first. A vendor that releases several branches in a day (GitLab's
 * patch posts) lists the older branch first, and the line shows the first entry. Newest day first, as the
 * entries came; entries without a version keep their feed order, after the numbered ones of the same day.
 */
function sameDayNewestFirst(entries: ReleaseFeedEntry[]): ReleaseFeedEntry[] {
  const time = (entry: ReleaseFeedEntry) =>
    entry.release.releasedAt ? Date.parse(entry.release.releasedAt) : Number.NEGATIVE_INFINITY;
  return entries
    .map((entry, index) => ({ entry, index, at: time(entry) }))
    .sort((a, b) => {
      if (a.at !== b.at) return a.at > b.at ? -1 : 1;
      const [x, y] = [a.entry.release.version, b.entry.release.version];
      if (x && y) return compareVersions(y, x) || a.index - b.index;
      // An entry with a version outranks one without, so the order stays a consistent one.
      return x ? -1 : y ? 1 : a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export function xmlEntries(source: ReleaseSource, body: string): ReleaseFeedEntry[] {
  // RSS says channel, Atom says feed; anything else (an HTML error page, a login wall) is not a feed.
  const kind = /<(?:rss|channel)[\s>]/i.test(body) ? "item" : /<feed[\s>]/i.test(body) ? "entry" : undefined;
  if (!kind) throw new PayloadError(`${source.label} was not an RSS or Atom feed.`);
  const shape = source.shape ?? plainShape;
  const entries = parseFeedItems(body, kind).flatMap((item) => {
    const title = titleText(item.title);
    if (!title) return [];
    const shaped = shape({ ...item, title }, htmlBlocks(item.body));
    return shaped?.title.trim() ? [releaseEntry(source, shaped, item)] : [];
  });
  if (entries.length === 0) throw new PayloadError(`${source.label} had no readable entries.`);
  return sameDayNewestFirst(entries).slice(0, MAX_FEED_ENTRIES);
}

export function jsonEntries(source: ReleaseSource, body: string): ReleaseFeedEntry[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new PayloadError(`${source.label} was not valid JSON.`);
  }
  const entries = steamEntries(source, payload);
  if (entries.length === 0) throw new PayloadError(`${source.label} had no readable entries.`);
  return entries;
}

/**
 * Every release feed the board reads. Official, machine-readable feeds only;
 * a vendor with none (Confluence, Claude, ChatGPT, Grok, Spotify, Epic,
 * Fortnite, Apple, Android / Play) has no entry. Dropping a source is
 * deleting its object: nothing else refers to it.
 */
export const RELEASE_SOURCES: readonly ReleaseSource[] = [
  {
    id: "aws",
    label: "AWS releases",
    name: "AWS What's New",
    url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
    pageUrl: "https://aws.amazon.com/new/",
    hosts: ["aws.amazon.com"],
    linkLabel: "What's New post",
    read: xmlEntries,
  },
  {
    id: "gcp",
    label: "Google Cloud releases",
    name: "Google Cloud release notes",
    // Moves to docs.cloud.google.com; http.ts allows that one redirect.
    url: "https://cloud.google.com/feeds/gcp-release-notes.xml",
    pageUrl: "https://cloud.google.com/release-notes",
    hosts: ["cloud.google.com"],
    linkLabel: "Release notes",
    headers: { Range: HEAD_RANGE },
    head: true,
    shape: gcpShape,
    read: xmlEntries,
  },
  {
    id: "azure",
    label: "Azure releases",
    name: "Azure Updates",
    url: "https://www.microsoft.com/releasecommunications/api/v2/azure/rss",
    pageUrl: "https://azure.microsoft.com/en-us/updates",
    hosts: ["microsoft.com"],
    linkLabel: "Azure update",
    read: xmlEntries,
  },
  {
    id: "github",
    label: "GitHub releases",
    name: "GitHub Changelog",
    url: "https://github.blog/changelog/feed/",
    pageUrl: "https://github.blog/changelog/",
    hosts: ["github.blog", "github.com"],
    linkLabel: "Changelog post",
    read: xmlEntries,
  },
  {
    id: "gitlab",
    label: "GitLab releases",
    name: "GitLab releases",
    // Monthly and patch release posts in one feed. It moved from about.gitlab.com/releases.xml,
    // which now redirects off the vendor's host; this URL answers directly.
    url: "https://docs.gitlab.com/releases/all-releases.xml",
    pageUrl: "https://docs.gitlab.com/releases/",
    hosts: ["docs.gitlab.com", "about.gitlab.com"],
    linkLabel: "Release post",
    // All releases since 2023 with their full text (3.6 MB in October 2026, newest first): only the start is read.
    headers: { Range: HEAD_RANGE },
    head: true,
    shape: gitlabShape,
    read: xmlEntries,
  },
  {
    id: "cs2-europe",
    label: "CS2 releases",
    name: "Counter-Strike 2 updates",
    url: "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=300&feeds=steam_community_announcements",
    pageUrl: "https://store.steampowered.com/news/app/730",
    hosts: ["steampowered.com", "steamcommunity.com"],
    linkLabel: "Steam announcement",
    read: jsonEntries,
  },
];

// ------------------------------------------------------------ reading one ---

/** What reading one release feed came to: the feed, or why not. It never throws. */
export type ReleaseFeedResult = {
  id: ServiceId;
  label: string;
  ok: boolean;
  latencyMs: number;
  bytes: number;
  feed?: ReleaseFeed;
  failure?: SourceFailure;
};

/**
 * Reads one release feed: one request, parsed and bounded. A failure is
 * logged as a structured line, like a failed collector, and returned, never
 * thrown, so it cannot reach the card it belongs to.
 */
export function readReleaseFeed(source: ReleaseSource): Promise<ReleaseFeedResult> {
  return meterBytes(async (meter) => {
    const started = Date.now();
    try {
      const init = {
        timeoutMs: RELEASE_TIMEOUT_MS,
        ...(source.headers ? { headers: source.headers } : {}),
        ...(source.head ? { head: true } : {}),
      };
      const { body } = await fetchText(source.url, init);
      const feed = boundReleaseFeed({
        sourceName: source.name,
        sourceUrl: source.pageUrl,
        entries: source.read(source, body),
      });
      if (!feed) throw new PayloadError(`${source.label} had no readable entries.`);
      const latencyMs = Date.now() - started;
      console.log(
        JSON.stringify({
          event: "release_feed_completed",
          service: source.id,
          feed: source.label,
          entries: feed.entries.length,
          latencyMs,
          bytes: meter.bytes,
        }),
      );
      return { id: source.id, label: source.label, ok: true, latencyMs, bytes: meter.bytes, feed };
    } catch (error) {
      const failure = classifyFailure(error);
      const latencyMs = Date.now() - started;
      console.warn(
        JSON.stringify({
          event: "release_feed_failed",
          service: source.id,
          feed: source.label,
          kind: failure.kind,
          status: failure.status,
          message: clip(failure.message, MAX_TEXT_CHARS),
          latencyMs,
          bytes: meter.bytes,
        }),
      );
      return { id: source.id, label: source.label, ok: false, latencyMs, bytes: meter.bytes, failure };
    }
  });
}

/** Every release feed, read now and not from the cache: what `npm run source-health` probes. */
export function probeReleaseFeeds(): Promise<ReleaseFeedResult[]> {
  return Promise.all(RELEASE_SOURCES.map(readReleaseFeed));
}

// -------------------------------------------------------------- the board ---

// Per isolate, like the board's own cache. Values, never promises: a promise
// that holds a fetch may not be awaited from another request on Workers.
const readings = new Map<ServiceId, { at: number; feed: ReleaseFeed | undefined }>();

/** Forgets what was read, so the next call reads every feed again. For tests. */
export function clearReleaseFeedCache(): void {
  readings.clear();
}

/** The release feeds a board build is waiting on, as they come in. */
export type ReleaseFeedReading = {
  /** The feeds in hand at this moment: fresh in the cache, or already read. A read still running is not in it. */
  ready: () => Map<ServiceId, ReleaseFeed>;
  /** Settles once every read has finished and been cached for the next board. It never rejects. */
  settled: Promise<void>;
};

/**
 * Starts the release feeds of every service that has one and returns at once:
 * a feed fresh in the cache is ready now, any other is read (in parallel, each
 * on its own short deadline) and joins `ready()` when it arrives. The caller
 * decides how long to wait, so a slow vendor can never hold a board back; a
 * feed that misses the board is cached when it arrives and is on the next
 * one. A feed that failed is absent and not asked again for
 * RELEASE_FEED_RETRY_MS.
 */
export function startReleaseFeeds(): ReleaseFeedReading {
  const feeds = new Map<ServiceId, ReleaseFeed>();
  const reads: Promise<void>[] = [];
  for (const source of RELEASE_SOURCES) {
    const seen = readings.get(source.id);
    if (seen && Date.now() - seen.at < (seen.feed ? RELEASE_FEED_TTL_MS : RELEASE_FEED_RETRY_MS)) {
      if (seen.feed) feeds.set(source.id, seen.feed);
      continue;
    }
    reads.push(
      readReleaseFeed(source).then(
        ({ feed }) => {
          readings.set(source.id, { at: Date.now(), feed });
          if (feed) feeds.set(source.id, feed);
        },
        // readReleaseFeed does not throw; if it ever did, the feed is simply absent for a retry period.
        () => {
          readings.set(source.id, { at: Date.now(), feed: undefined });
        },
      ),
    );
  }
  return { ready: () => new Map(feeds), settled: Promise.all(reads).then(() => undefined) };
}

/**
 * Every release feed of the board, waiting for the reads that are running.
 * What a board build does not do (it takes `startReleaseFeeds().ready()` once
 * the health sweep is in); here for tests and for anything that wants them all.
 * It never rejects.
 */
export async function releaseFeedsForBoard(): Promise<Map<ServiceId, ReleaseFeed>> {
  const reading = startReleaseFeeds();
  await reading.settled;
  return reading.ready();
}

/**
 * The services with their release feeds attached. Only `releaseFeed` is added:
 * health, summary, components, incidents and counts are exactly the
 * collector's, so a feed can never change what a card says about the service.
 */
export function withReleaseFeeds(
  services: ServiceSnapshot[],
  feeds: ReadonlyMap<ServiceId, ReleaseFeed>,
): ServiceSnapshot[] {
  return services.map((service) => {
    const releaseFeed = service.category === "updates" ? undefined : feeds.get(service.id);
    return releaseFeed ? { ...service, releaseFeed } : service;
  });
}
