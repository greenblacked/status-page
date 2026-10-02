import { describe, expect, it } from "vitest";
import { androidReleases, readAndroidVersionLinks } from "./android-release.ts";
import { mikrotikChangelogNotes, parseAppleOsTitle, splitAppleBuild } from "./changelog.ts";
import { unwrapJsonp } from "./http.ts";
import { incidentLink } from "./layout.ts";
import {
  azureItemHealth,
  decodeXmlField,
  grokItemHealth,
  grokTitleService,
  MAX_RSS_ITEMS,
  MAX_RSS_SCANNED,
  parseRssItems,
} from "./sources.server.ts";
import type { ServiceSnapshot } from "./types.ts";
import { readHtmlTables, windowsReleases } from "./windows-release.ts";

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

  it("azureItemHealth: long runs of the words and prefixes it looks for, and of spaces and brackets", () => {
    const cases = [
      `${"resolved ".repeat(SIZE / 9)}x`,
      `${" ".repeat(SIZE)}resolved`,
      `${"[(".repeat(SIZE / 2)}resolved`,
      `${"[ ".repeat(SIZE / 2)}x`,
      `${"post incident ".repeat(SIZE / 14)}`,
      `${"post-".repeat(SIZE / 5)}`,
      `${"service ".repeat(SIZE / 8)}unavailable`,
      `${"d".repeat(SIZE)}own`,
      `${"o".repeat(SIZE)}utage`,
    ];
    for (const body of cases) expect(elapsed(() => azureItemHealth(body))).toBeLessThan(BUDGET_MS);
    expect(azureItemHealth(`${"resolved ".repeat(10)}x`)).toBe("operational");
    expect(azureItemHealth(`${"unresolved ".repeat(10)}x`)).toBe("degraded");
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

  it.each([
    ["unclosed tag openers", "<a".repeat(SIZE / 2)],
    ["tag openers with a space", "<a ".repeat(SIZE / 3)],
    ["bare angle brackets", "<".repeat(SIZE)],
    ["a tag that never ends", `<a href="/about/versions/17"${"x".repeat(SIZE)}`],
    ["a link that never closes", `<a href="/about/versions/17">${"Android 17".repeat(SIZE / 10)}`],
    ["many version links that never close", '<a href="/about/versions/17">Android 17'.repeat(SIZE / 38)],
    ["many version links closed far away", `${'<a href="/about/versions/17">x'.repeat(SIZE / 27)}</a>`],
    ["tags with long runs of attributes", `<a ${'href="/about/versions/17" '.repeat(SIZE / 26)}>Android 17</a>`],
    ["an unclosed quote in the href", `<a href="${"/about/versions/17".repeat(SIZE / 17)}`],
    ["long link text of tag openers", `<a href="/about/versions/17">${"<".repeat(SIZE)}</a>`],
    ["a long link text of spaces", `<a href="/about/versions/17">${" ".repeat(SIZE)}Android 17</a>`],
    ["a long run of digits", `<a href="/about/versions/${"1".repeat(SIZE)}">Android 17</a>`],
    ["many valid links", '<a href="/about/versions/17">Android 17</a>'.repeat(SIZE / 41)],
    ["many empty links", "<a ></a>".repeat(SIZE / 8)],
  ])("readAndroidVersionLinks: %s", (_label, html) => {
    expect(elapsed(() => readAndroidVersionLinks(html))).toBeLessThan(BUDGET_MS);
  });

  it("androidReleases: a long list of versions", () => {
    const versions = Array.from({ length: SIZE }, (_, i) => String(i % 100));
    expect(elapsed(() => androidReleases(versions))).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ["unclosed tag openers", "<td".repeat(SIZE / 3)],
    ["unclosed comment openers", "<!--".repeat(SIZE / 4)],
    ["bare angle brackets", "<".repeat(SIZE)],
    ["a tag that never ends", `<table><tr><td${"x".repeat(SIZE)}`],
    ["a script that never ends", `<script>${"<table>".repeat(SIZE / 7)}`],
    ["empty tables", "<table></table>".repeat(SIZE / 15)],
    ["rows and cells without end", `<table>${"<tr><td>x".repeat(SIZE / 9)}`],
    ["nested tables", `${"<table><tr><td>".repeat(SIZE / 16)}x`],
    ["a long cell of entity-like text", `<table><tr><td>${"&#".repeat(SIZE / 2)}`],
    ["a long cell of spaces and tags", `<table><tr><td>${" <b>".repeat(SIZE / 4)}`],
  ])("readHtmlTables: %s", (_label, html) => {
    let tables: ReturnType<typeof readHtmlTables> = [];
    expect(elapsed(() => (tables = readHtmlTables(html)))).toBeLessThan(BUDGET_MS);
    expect(tables.length).toBeLessThanOrEqual(40);
    expect(elapsed(() => windowsReleases(tables))).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ["one line with no newline", `What's new in 7.2:\n*) ${"a".repeat(SIZE)}`],
    ["a long run of blank lines", `${"\n".repeat(SIZE)}What's new in 7.2:\n*) a;`],
    ["a long run of spaces and carriage returns", `What's new in 7.2:\n${" \r".repeat(SIZE / 2)}*) a;`],
    ["headings and no bullets", "What's new in 7.2:\n".repeat(SIZE / 20)],
    ["bullets with nothing in them", `What's new in 7.2:\n${"*)\n".repeat(SIZE / 3)}`],
    ["text with no heading at all", "*) a;\n".repeat(SIZE / 6)],
    ["a heading marker that never ends", `What's new in ${" ".repeat(SIZE)}`],
  ])("mikrotikChangelogNotes: %s", (_label, text) => {
    expect(elapsed(() => mikrotikChangelogNotes(text))).toBeLessThan(BUDGET_MS);
  });

  it("splitAppleBuild: a version made of parentheses and of spaces", () => {
    expect(elapsed(() => splitAppleBuild(`${"(".repeat(SIZE)})`))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => splitAppleBuild(`${" ".repeat(SIZE)}(24B5089g)`))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => splitAppleBuild(`1 (${" ".repeat(SIZE)})`))).toBeLessThan(BUDGET_MS);
  });

  it("incidentLink: an incident URL whose path is a long run of slashes", () => {
    const service = {
      sourceUrl: "https://status.example.com/",
      incidents: [{ id: "1", title: "t", health: "outage", url: `https://status.example.com/${"/".repeat(SIZE)}x` }],
    } as ServiceSnapshot;
    expect(elapsed(() => incidentLink(service))).toBeLessThan(BUDGET_MS);
  });
});
