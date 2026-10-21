import { PayloadError } from "./http.ts";

// The XML and markup readers for vendor feeds, shared by the incident
// collectors (sources.server.ts, which re-exports them) and the release
// feeds. Like sources.server.ts it runs under Node's own type stripping
// (sources.performance.test.ts), so it uses relative .ts imports and
// erasable syntax only.

// Only strip comments and things that look like tags (`<` or `</` followed by
// a letter). A blanket `<[^>]+>` also ate a decoded "Latency < 500ms", which
// erased "Status: Resolved" from an otherwise operational item. Plain text
// such as "a<b ... c>d" still reads as a tag; regex stripping cannot tell.
//
// A single pass over the `<` positions rather than a regex: `<!--[\s\S]*?-->`
// rescans to the end of the text from every unclosed `<!--`, which is
// quadratic on a body of repeated openers. Here a missing "-->" is looked
// for once, and a tag body stops at the next `<` or `>`, so nothing is
// scanned twice.
function stripMarkup(value: string): string {
  let out = "";
  let from = 0;
  let commentsClose = true;
  for (;;) {
    const lt = value.indexOf("<", from);
    if (lt === -1) return out + value.slice(from);
    out += value.slice(from, lt);
    from = lt + 1;
    if (value.startsWith("<!--", lt)) {
      const end = commentsClose ? value.indexOf("-->", lt + 4) : -1;
      if (end !== -1) {
        out += " ";
        from = end + 3;
        continue;
      }
      commentsClose = false;
      out += "<";
      continue;
    }
    let at = lt + 1;
    if (value[at] === "/") at += 1;
    if (isAsciiLetter(value.charCodeAt(at))) {
      at += 1;
      while (at < value.length && value[at] !== "<" && value[at] !== ">") at += 1;
      if (value[at] === ">") {
        out += " ";
        from = at + 1;
        continue;
      }
    }
    out += "<";
  }
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function stripHtml(value: string): string {
  return stripMarkup(value)
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// Matches the five predefined XML entities plus decimal and hex numeric
// character references. A single pass with a replacer keeps `&amp;lt;` as
// `&lt;` rather than double-decoding it into `<`: once `&amp;` becomes `&`,
// the regex has already moved past it and never re-scans the result.
const XML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeXmlEntities(text: string): string {
  return text.replace(XML_ENTITY_RE, (match, body: string) => {
    if (body[0] === "#") {
      // The regex's numeric branch only ever produces a lowercase "x", so
      // there is no uppercase case to handle here.
      const isHex = body[1] === "x";
      const digits = isHex ? body.slice(2) : body.slice(1);
      const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
      // Reject out-of-range values, lone surrogate halves, and the
      // characters XML forbids outright (C0 controls other than tab/LF/CR,
      // and the two permanently-unassigned noncharacters) rather than let
      // String.fromCodePoint throw or silently emit U+FFFD. `digits` is
      // always non-negative, so there is no `codePoint < 0` case either.
      if (
        !Number.isFinite(codePoint) ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        (codePoint < 0x20 && codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd) ||
        codePoint === 0xfffe ||
        codePoint === 0xffff
      ) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    }
    return XML_NAMED_ENTITIES[body] ?? match;
  });
}

// CDATA content is already literal text, so it must never be re-decoded
// (`<![CDATA[a &amp; b]]>` should stay `a &amp; b`). Split on CDATA sections
// and decode only the parts outside them. Found with indexOf rather than a
// lazy regex, which rescans to the end from every unclosed opener.
const CDATA_START = "<![CDATA[";
const CDATA_END = "]]>";

export function decodeXmlField(raw: string): string {
  let result = "";
  let from = 0;
  for (;;) {
    const start = raw.indexOf(CDATA_START, from);
    if (start === -1) return result + decodeXmlEntities(raw.slice(from));
    result += decodeXmlEntities(raw.slice(from, start));
    const end = raw.indexOf(CDATA_END, start + CDATA_START.length);
    // An opener with no closing `]]>` anywhere later: treat everything from
    // that marker onward as literal CDATA content (strip the marker, leave
    // the rest undecoded), rather than decoding text the feed meant to be
    // taken as-is.
    if (end === -1) return result + raw.slice(start + CDATA_START.length);
    result += raw.slice(start + CDATA_START.length, end);
    from = end + CDATA_END.length;
  }
}

// RFC 822 zone abbreviations a vendor feed has been seen to write, or plausibly
// could, that Date.parse does not know (it knows GMT, UT, Z and the US zones,
// listed here too so the table is the whole answer), as numeric offsets.
const ZONE_OFFSETS: Readonly<Record<string, string>> = {
  WET: "+0000",
  WEST: "+0100",
  BST: "+0100",
  CET: "+0100",
  CEST: "+0200",
  EET: "+0200",
  EEST: "+0300",
  IST: "+0530",
  JST: "+0900",
  AEST: "+1000",
  AEDT: "+1100",
  EST: "-0500",
  EDT: "-0400",
  CST: "-0600",
  CDT: "-0500",
  MST: "-0700",
  MDT: "-0600",
  PST: "-0800",
  PDT: "-0700",
};

// A real date is some 30 characters; anything far longer is not one, and is
// never handed to Date.parse or the patterns below.
const MAX_DATE_CHARS = 64;
// A date and a time with no zone: "2026-09-21 10:00", "2026-09-21T10:00:30".
const ZONELESS_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;
// A date that ends in a zone abbreviation: "Mon, 21 Sep 2026 10:00:00 CEST".
const TRAILING_ZONE = /^(.{1,48}\d) ([A-Za-z]{2,5})$/;

/**
 * A feed's date as epoch milliseconds, or undefined when there is none to
 * read. Date.parse comes first, except for a date and time with no zone,
 * which is UTC here (Date.parse would read it in the host's own zone).
 * Failing that, a trailing RFC 822 zone abbreviation Date.parse does not know
 * (CEST, BST, IST, ...) is read as its offset. The value is cut to a sane
 * length first, so every step is bounded.
 */
export function parseFeedDate(value?: string): number | undefined {
  const text = value?.trim() ?? "";
  if (!text || text.length > MAX_DATE_CHARS) return undefined;
  const zoneless = ZONELESS_TIMESTAMP.exec(text);
  const direct = Date.parse(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : text);
  if (Number.isFinite(direct)) return direct;
  const zoned = TRAILING_ZONE.exec(text.replace(/\s+/g, " "));
  const offset = zoned ? ZONE_OFFSETS[zoned[2].toUpperCase()] : undefined;
  if (!zoned || !offset) return undefined;
  const at = Date.parse(`${zoned[1]} ${offset}`);
  return Number.isFinite(at) ? at : undefined;
}

/** Most `<item>`s kept from a feed: the newest by pubDate. Real feeds carry tens. */
export const MAX_RSS_ITEMS = 200;
/**
 * Most `<item>`s read in one feed. status.x.ai serves its whole history and
 * nothing says which end is newest, so every item up to this bound is dated
 * before the newest MAX_RSS_ITEMS are chosen. The bound is for memory, and a
 * feed with more items than this is refused (a PayloadError, so its card is
 * unknown): the items past it could be the current incident, and reading only
 * the others would be an all-clear built on a guess.
 */
export const MAX_RSS_SCANNED = 5000;

const ITEM_CLOSE = /<\/item>/i;

const FIELD_TAGS = new Map<string, [RegExp, RegExp]>();

// The text between the first `<tag>` and the first `</tag>` after it, or
// undefined. Two literal searches, so a field is read in one pass over its
// item whatever the item holds; `<tag>([\s\S]*?)</tag>` rescanned the whole
// item from every repeated, unclosed `<tag>`.
function xmlField(chunk: string, tag: string): string | undefined {
  let tags = FIELD_TAGS.get(tag);
  if (!tags) {
    tags = [new RegExp(`<${tag}>`, "i"), new RegExp(`</${tag}>`, "i")];
    FIELD_TAGS.set(tag, tags);
  }
  const open = chunk.search(tags[0]);
  if (open === -1) return undefined;
  const from = open + tag.length + 2;
  const close = chunk.slice(from).search(tags[1]);
  return close === -1 ? undefined : chunk.slice(from, from + close);
}

export function parseRssItems(
  xml: string,
): Array<{ title: string; description: string; pubDate?: string; link?: string }> {
  // Each item runs from its `<item>` to the next one, cut at its own
  // `</item>`; every search below stays inside that slice, so the whole feed
  // is read once. Only the date is read from all of the items scanned; the
  // newest MAX_RSS_ITEMS are then read in full, before anything downstream
  // maps or sorts them. An item with no readable date ranks last, and ties
  // keep the feed's order. The items kept stay in the feed's order.
  const scanned: Array<{ chunk: string; at: number; index: number }> = [];
  const itemOpen = /<item[\s>]/gi;
  let open = itemOpen.exec(xml);
  while (open && scanned.length < MAX_RSS_SCANNED) {
    const bodyStart = open.index + open[0].length;
    const next = itemOpen.exec(xml);
    const block = xml.slice(bodyStart, next ? next.index : xml.length);
    const closed = block.search(ITEM_CLOSE);
    const chunk = closed === -1 ? block : block.slice(0, closed);
    const date = parseFeedDate(xmlField(chunk, "pubDate"));
    scanned.push({ chunk, at: date ?? Number.NEGATIVE_INFINITY, index: scanned.length });
    open = next;
  }
  if (open) throw new PayloadError(`RSS feed has more than ${MAX_RSS_SCANNED} items.`);
  const kept =
    scanned.length > MAX_RSS_ITEMS
      ? scanned
          .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at > b.at ? -1 : 1))
          .slice(0, MAX_RSS_ITEMS)
          .sort((a, b) => a.index - b.index)
      : scanned;
  return kept.map(({ chunk }) => {
    const title = decodeXmlField(xmlField(chunk, "title") ?? "").trim();
    const description = decodeXmlField(xmlField(chunk, "description") ?? "").trim();
    const pubDate = xmlField(chunk, "pubDate")?.trim();
    const rawLink = xmlField(chunk, "link");
    const link = rawLink !== undefined ? decodeXmlField(rawLink).trim() : undefined;
    return { title, description, pubDate, link };
  });
}
