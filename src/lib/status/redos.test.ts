import { describe, expect, it } from "vitest";
import { parseAppleOsTitle } from "./changelog.ts";
import { unwrapJsonp } from "./http.ts";
import { incidentLink } from "./layout.ts";
import {
  decodeXmlField,
  grokItemHealth,
  grokTitleService,
  MAX_RSS_ITEMS,
  MAX_RSS_SCANNED,
  parseRssItems,
} from "./sources.server.ts";
import type { ServiceSnapshot } from "./types.ts";

// Vendor bodies are untrusted input that is parsed on the Worker, so no
// parser may take more than linear time on one. Each case below is a crafted
// input that was quadratic (or worse) before the parsers were rewritten as
// linear scans: at this size the old code ran for seconds, the linear code
// for a few milliseconds. The budget is generous so a slow CI runner never
// fails a correct implementation.
const SIZE = 200_000;
const BUDGET_MS = 200;

function elapsed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("parsers stay linear on crafted vendor input", () => {
  it("unwrapJsonp: a call, a long run of spaces, then one more character", () => {
    const body = `f()${" ".repeat(SIZE)}x`;
    let result = "";
    expect(elapsed(() => (result = unwrapJsonp(body)))).toBeLessThan(BUDGET_MS);
    expect(result).toBe(body);
  });

  it("unwrapJsonp: many unclosed parentheses and a long identifier", () => {
    expect(elapsed(() => unwrapJsonp(`f${"(".repeat(SIZE)}`))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => unwrapJsonp(`${"a".repeat(SIZE)}(1)${" ".repeat(10)}x`))).toBeLessThan(BUDGET_MS);
  });

  it.each(["title", "description", "pubDate", "link"])("parseRssItems: a repeated unclosed <%s>", (tag) => {
    const xml = `<item>${`<${tag}>`.repeat(SIZE / 8)}`;
    let items: ReturnType<typeof parseRssItems> = [];
    expect(elapsed(() => (items = parseRssItems(xml)))).toBeLessThan(BUDGET_MS);
    expect(items).toHaveLength(1);
  });

  it("parseRssItems: a feed of unclosed <item> openers and of empty items", () => {
    expect(elapsed(() => parseRssItems("<item>".repeat(SIZE / 6)))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => parseRssItems("<item></item>".repeat(SIZE / 13)))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => parseRssItems(`<item>${" ".repeat(SIZE)}`.repeat(4)))).toBeLessThan(BUDGET_MS);
  });

  it("parseRssItems: keeps MAX_RSS_ITEMS items, the first ones when none is dated", () => {
    const xml = Array.from({ length: MAX_RSS_ITEMS * 5 }, (_, i) => `<item><title>t${i}</title></item>`).join("");
    const items = parseRssItems(xml);
    expect(items).toHaveLength(MAX_RSS_ITEMS);
    expect(items[0].title).toBe("t0");
    expect(items.at(-1)?.title).toBe(`t${MAX_RSS_ITEMS - 1}`);
  });

  it("parseRssItems: keeps the newest items wherever they sit in the feed, in the feed's order", () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toUTCString();
    // Oldest first, so the newest are at the end of the document; two undated items lead.
    const dated = Array.from(
      { length: MAX_RSS_ITEMS + 50 },
      (_, i) => `<item><title>d${i}</title><pubDate>${day(i)}</pubDate></item>`,
    );
    const xml = `<item><title>undated-1</title></item><item><title>undated-2<pubDate>nope</pubDate></title></item>${dated.join("")}`;
    const items = parseRssItems(xml);
    expect(items).toHaveLength(MAX_RSS_ITEMS);
    expect(items.map((item) => item.title)).toEqual(Array.from({ length: MAX_RSS_ITEMS }, (_, i) => `d${i + 50}`));
  });

  it("parseRssItems: a feed past the scan bound is still read in linear time and capped", () => {
    const xml = Array.from({ length: MAX_RSS_SCANNED * 2 }, (_, i) => `<item><title>t${i}</title></item>`).join("");
    let items: ReturnType<typeof parseRssItems> = [];
    expect(elapsed(() => (items = parseRssItems(xml)))).toBeLessThan(BUDGET_MS * 2);
    expect(items).toHaveLength(MAX_RSS_ITEMS);
  });

  it("decodeXmlField: a repeated unclosed CDATA opener", () => {
    expect(elapsed(() => decodeXmlField("<![CDATA[".repeat(SIZE / 9)))).toBeLessThan(BUDGET_MS);
  });

  it("grokItemHealth (HTML stripping): a repeated unclosed comment and tag opener", () => {
    expect(elapsed(() => grokItemHealth("<!--".repeat(SIZE / 4)))).toBeLessThan(BUDGET_MS);
    // Many closed comments and tags, which must all be stripped, not just survive.
    let health = "";
    expect(
      elapsed(() => (health = grokItemHealth(`${"<!-- x -->".repeat(SIZE / 10)}<b>Status: Resolved</b>`))),
    ).toBeLessThan(BUDGET_MS);
    expect(health).toBe("operational");
    expect(elapsed(() => grokItemHealth(`<a${"x".repeat(SIZE)}`))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => grokItemHealth("<".repeat(SIZE)))).toBeLessThan(BUDGET_MS);
  });

  it("grokTitleService: a bracket lead, a long run of spaces, then a line break", () => {
    const title = `[Grok]${" ".repeat(SIZE)}a\nb`;
    let service: ReturnType<typeof grokTitleService> = { name: "", detail: "" };
    expect(elapsed(() => (service = grokTitleService(title)))).toBeLessThan(BUDGET_MS);
    expect(service).toBeNull();
    expect(grokTitleService(`[Grok]${" ".repeat(SIZE)}a b`)).toEqual({ name: "Grok", detail: "a b" });
  });

  it("parseAppleOsTitle: a family, a long run of spaces, then a line break", () => {
    const title = `iOS${" ".repeat(SIZE)}a\nb`;
    let parsed: ReturnType<typeof parseAppleOsTitle> = null;
    expect(elapsed(() => (parsed = parseAppleOsTitle(title)))).toBeLessThan(BUDGET_MS);
    expect(parsed).toBeNull();
  });

  it("incidentLink: an incident URL whose path is a long run of slashes", () => {
    const service = {
      sourceUrl: "https://status.example.com/",
      incidents: [{ id: "1", title: "t", health: "outage", url: `https://status.example.com/${"/".repeat(SIZE)}x` }],
    } as ServiceSnapshot;
    expect(elapsed(() => incidentLink(service))).toBeLessThan(BUDGET_MS);
  });
});
