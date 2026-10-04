import { describe, expect, it } from "vitest";
import { androidReleases, readAndroidVersionLinks } from "./android-release.ts";
import { mikrotikChangelogNote, mikrotikChangelogNotes, parseAppleOsTitle, splitAppleBuild } from "./changelog.ts";
import { PayloadError, unwrapJsonp } from "./http.ts";
import { incidentLink } from "./layout.ts";
import {
  decodeHtmlNames,
  dropScripts,
  gitlabVersion,
  htmlBlocks,
  jsonEntries,
  parseFeedItems,
  RELEASE_SOURCES,
  steamNoteLines,
  xmlEntries,
} from "./release-feeds.server.ts";
import {
  azureItemHealth,
  decodeXmlField,
  grokItemHealth,
  grokTitleService,
  MAX_RSS_ITEMS,
  MAX_RSS_SCANNED,
  MAX_SCANNED_ROWS,
  parseRssItems,
} from "./sources.server.ts";
import type { ServiceSnapshot } from "./types.ts";
import { readHtmlCells, readHtmlTables, windowsReleases, windowsUpdateNote } from "./windows-release.ts";

// Vendor bodies are untrusted input that is parsed on the Worker, so no
// parser may take more than linear time on one. Each case below is a crafted
// input that was quadratic (or worse) before the parsers were rewritten as
// linear scans: at this size the old code ran for seconds, the linear code
// for a few milliseconds. The budget is generous so a slow CI runner never
// fails a correct implementation.
const SIZE = 200_000;
const BUDGET_MS = 200;

// A parser may refuse crafted input (a PayloadError, as for a feed past the scan bound): the time it took to
// decide is what is measured, so that refusal is not a failure here.
function elapsed(run: () => unknown): number {
  const started = performance.now();
  try {
    run();
  } catch (error) {
    if (!(error instanceof PayloadError)) throw error;
  }
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
      `${"preliminary ".repeat(SIZE / 12)}x`,
      `${"final-".repeat(SIZE / 6)}pir`,
      `preliminary${" ".repeat(SIZE)}x`,
      `${"service ".repeat(SIZE / 8)}unavailable`,
      `${"d".repeat(SIZE)}own`,
      `${"o".repeat(SIZE)}utage`,
    ];
    for (const body of cases) expect(elapsed(() => azureItemHealth(body))).toBeLessThan(BUDGET_MS);
    expect(azureItemHealth(`${"resolved ".repeat(10)}x`)).toBe("operational");
    expect(azureItemHealth(`${"unresolved ".repeat(10)}x`)).toBe("degraded");
    expect(azureItemHealth("Preliminary Post Incident Review (PIR) – Networking – Outage")).toBe("operational");
    expect(azureItemHealth("Final PIR – Networking")).toBe("operational");
    expect(azureItemHealth(`${"preliminary ".repeat(10)}x`)).toBe("degraded");
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

  it("parseRssItems: a feed past the scan bound is refused in linear time", () => {
    const xml = Array.from({ length: MAX_RSS_SCANNED * 2 }, (_, i) => `<item><title>t${i}</title></item>`).join("");
    expect(elapsed(() => expect(() => parseRssItems(xml)).toThrow(PayloadError))).toBeLessThan(BUDGET_MS * 2);
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

  it.each([
    ["one line with no newline", `What's new in 7.2:\n*) ${"a".repeat(SIZE)}`],
    ["a very long area before any dash", `What's new in 7.2:\n*) ${"a ".repeat(SIZE / 2)}- x`],
    ["an area made of spaces", `What's new in 7.2:\n*) ${" ".repeat(SIZE)} - x`],
    ["dashes and spaces", `What's new in 7.2:\n*) ${" - ".repeat(SIZE / 3)}`],
    ["a very long run of change lines", `What's new in 7.2:\n${"*) a - b;\n".repeat(SIZE / 10)}`],
    ["a very long run of important lines", `What's new in 7.2:\n${"!) a - b;\n".repeat(SIZE / 10)}`],
    [
      "many distinct areas",
      `What's new in 7.2:\n${Array.from({ length: SIZE / 12 }, (_, at) => `*) a${at} - b;`).join("\n")}`,
    ],
    ["bullets with nothing in them", `What's new in 7.2:\n${"*)\n!)\n".repeat(SIZE / 6)}`],
    ["headings and no bullets", "What's new in 7.2:\n".repeat(SIZE / 20)],
    ["a long run of blank lines", `What's new in 7.2:\n${"\n".repeat(SIZE)}*) a - b;`],
    ["carriage returns only", `What's new in 7.2:${"\r".repeat(SIZE)}*) a - b;`],
  ])("mikrotikChangelogNote: %s", (_label, text) => {
    expect(elapsed(() => mikrotikChangelogNote(text, "7.2", { whole: true }))).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ["links that never close", `<table><tr><td>${'<a href="'.repeat(SIZE / 9)}`],
    ["an href with no end quote", `<table><tr><td><a href="${"x".repeat(SIZE)}`],
    ["a tag of attributes", `<table><tr><td><a ${'a="b" '.repeat(SIZE / 6)}href="https://support.microsoft.com/">x`],
    ["a tag of spaces before an equals sign", `<table><tr><td><a href${" ".repeat(SIZE)}="x">x`],
    ["many links in one cell", `<table><tr><td>${'<a href="https://a.example/">x</a>'.repeat(SIZE / 33)}`],
    [
      "a cell of KB-like text",
      `<table><tr><th>Update type</th><th>Build</th><th>KB</th></tr><tr><td>2026-09 B</td><td>26100.6725</td><td>${"KB".repeat(SIZE / 2)}</td></tr>`,
    ],
    [
      "a cell of digits after KB",
      `<table><tr><th>Update type</th><th>Build</th><th>KB</th></tr><tr><td>2026-09 B</td><td>26100.6725</td><td>KB${"1".repeat(SIZE)}</td></tr>`,
    ],
    [
      "an update type of spaces",
      `<table><tr><th>Update type</th><th>Build</th></tr><tr><td>${" ".repeat(SIZE)}B</td><td>26100.6725</td></tr>`,
    ],
    [
      "a build of dots and digits",
      `<table><tr><th>Update type</th><th>Build</th></tr><tr><td>2026-09 B</td><td>${"1.".repeat(SIZE / 2)}</td></tr>`,
    ],
    [
      "the most tables, each with many rows",
      "<table><tr><th>Update type</th><th>Build</th></tr>"
        .concat("<tr><td>2026-09 B</td><td>1.1</td></tr>".repeat(100), "</table>")
        .repeat(60),
    ],
  ])("windowsUpdateNote: %s", (_label, html) => {
    let cells: ReturnType<typeof readHtmlCells> = [];
    expect(elapsed(() => (cells = readHtmlCells(html)))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => windowsUpdateNote(cells, "26100.6725"))).toBeLessThan(BUDGET_MS);
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

  // The release feeds (release-feeds.server.ts): every regex there runs on vendor text.
  describe("release feeds", () => {
    const steam = RELEASE_SOURCES.find((candidate) => candidate.id === "cs2-europe");
    const aws = RELEASE_SOURCES.find((candidate) => candidate.id === "aws");
    const gitlab = RELEASE_SOURCES.find((candidate) => candidate.id === "gitlab");
    if (!steam || !aws || !gitlab) throw new Error("a release source is missing");

    it.each(["title", "description", "content", "summary", "pubDate", "published", "updated", "link", "dc:date"])(
      "parseFeedItems: a repeated unclosed <%s> in an item and in an entry",
      (tag) => {
        for (const kind of ["item", "entry"] as const) {
          const xml = `<${kind}>${`<${tag}>`.repeat(SIZE / 8)}`;
          let items: ReturnType<typeof parseFeedItems> = [];
          expect(elapsed(() => (items = parseFeedItems(xml, kind)))).toBeLessThan(BUDGET_MS);
          expect(items).toHaveLength(1);
        }
      },
    );

    it("parseFeedItems: unclosed openers, empty items and a long run of spaces", () => {
      for (const kind of ["item", "entry"] as const) {
        expect(elapsed(() => parseFeedItems(`<${kind}>`.repeat(SIZE / 6), kind))).toBeLessThan(BUDGET_MS * 2);
        expect(elapsed(() => parseFeedItems(`<${kind}></${kind}>`.repeat(SIZE / 13), kind))).toBeLessThan(
          BUDGET_MS * 2,
        );
        expect(elapsed(() => parseFeedItems(`<${kind}>${" ".repeat(SIZE)}`.repeat(4), kind))).toBeLessThan(BUDGET_MS);
      }
    });

    it("parseFeedItems: link tags with long attributes, many links and a href that never ends", () => {
      const cases = [
        `<entry>${'<link rel="x" href="a"/>'.repeat(SIZE / 24)}</entry>`,
        `<entry><link ${"href ".repeat(SIZE / 5)}</entry>`,
        `<entry><link href=${" ".repeat(SIZE)}"x"</entry>`,
        `<entry><link href="${"a".repeat(SIZE)}</entry>`,
        `<entry>${"<link ".repeat(SIZE / 6)}</entry>`,
        `<entry><link${" rel='".repeat(SIZE / 6)}</entry>`,
      ];
      for (const xml of cases) expect(elapsed(() => parseFeedItems(xml, "entry"))).toBeLessThan(BUDGET_MS);
    });

    it("parseFeedItems: a feed past the scan bound is refused in linear time", () => {
      const xml = Array.from({ length: MAX_RSS_SCANNED * 2 }, (_, i) => `<item><title>t${i}</title></item>`).join("");
      expect(elapsed(() => expect(() => parseFeedItems(xml, "item")).toThrow(PayloadError))).toBeLessThan(
        BUDGET_MS * 4,
      );
    });

    it("htmlBlocks: repeated block tags, unclosed tags, comments and a tag that never ends", () => {
      const cases = [
        "<p>".repeat(SIZE / 3),
        "<p ".repeat(SIZE / 3),
        `<p${" ".repeat(SIZE)}`,
        `<li ${"a=b ".repeat(SIZE / 4)}`,
        "<br/>".repeat(SIZE / 5),
        "<!--".repeat(SIZE / 4),
        `<h2>${"<".repeat(SIZE)}`,
        `${"<div>x</div>".repeat(SIZE / 12)}`,
        `<p>${"a ".repeat(SIZE / 2)}</p>`,
      ];
      for (const html of cases) expect(elapsed(() => htmlBlocks(html))).toBeLessThan(BUDGET_MS);
    });

    it("dropScripts: many openers, unclosed ones and a closer that never comes", () => {
      const cases = [
        "<script>".repeat(SIZE / 8),
        "<script></script>".repeat(SIZE / 17),
        `<script>${"</scrip ".repeat(SIZE / 8)}`,
        `<style${" ".repeat(SIZE)}`,
        `<script>${"a".repeat(SIZE)}`,
        `${"<styl".repeat(SIZE / 5)}`,
      ];
      for (const html of cases) expect(elapsed(() => dropScripts(html))).toBeLessThan(BUDGET_MS);
      expect(dropScripts("a<script>x</script>b<style>y</style>c")).toBe("abc");
      expect(dropScripts("a<script>never closed")).toBe("a");
    });

    it("gitlabVersion: a lead of spaces, a long list of versions and lookalikes", () => {
      const cases = [
        `GitLab${" ".repeat(SIZE)}18.4 released`,
        `GitLab 18.4${" ".repeat(SIZE)}released`,
        `GitLab 19.4${" ".repeat(SIZE)}release notes`,
        `GitLab 19.4 release${" ".repeat(SIZE)}notes`,
        `GitLab 19.4 release${" ".repeat(SIZE)}`,
        `GitLab AI Gateway Critical Patch Release: ${"19.4.1, ".repeat(SIZE / 8)}`,
        `GitLab Patch Release: ${"18.4.1, ".repeat(SIZE / 8)}`,
        `GitLab Patch Release: ${"1.".repeat(SIZE / 2)}`,
        `GitLab critical${" ".repeat(SIZE)}patch release`,
        `${"GitLab ".repeat(SIZE / 7)}`,
        `GitLab Patch Release: ${"9999.9999.9999 ".repeat(SIZE / 15)}`,
      ];
      for (const title of cases) expect(elapsed(() => gitlabVersion(title))).toBeLessThan(BUDGET_MS);
      expect(gitlabVersion("GitLab Patch Release: 18.4.1, 18.3.3, 18.2.7")).toBe("18.4.1");
      expect(gitlabVersion("GitLab 19.4 release notes")).toBe("19.4");
    });

    it("decodeHtmlNames: ampersands, long names and references that never end", () => {
      const cases = [
        "&".repeat(SIZE),
        "&a".repeat(SIZE / 2),
        `&${"a".repeat(SIZE)}`,
        "&hellip".repeat(SIZE / 7),
        "&hellip;".repeat(SIZE / 8),
        `${"&abcdefgh".repeat(SIZE / 9)};`,
        "&;".repeat(SIZE / 2),
        "&amp;rsquo;".repeat(SIZE / 11),
      ];
      for (const text of cases) expect(elapsed(() => decodeHtmlNames(text))).toBeLessThan(BUDGET_MS);
      expect(decodeHtmlNames("a&hellip;&rsquo;b")).toBe("a\u2026\u2019b");
    });

    it("steamNoteLines: brackets, placeholders and equals signs without end", () => {
      const cases = [
        "[".repeat(SIZE),
        "[b=".repeat(SIZE / 3),
        `[url=${"a".repeat(SIZE)}`,
        `[b${"c".repeat(SIZE)}]`,
        "{STEAM_CLAN_IMAGE}/".repeat(SIZE / 19),
        `{STEAM_CLAN_IMAGE}/${"a".repeat(SIZE)}`,
        "[*]\n".repeat(SIZE / 4),
        "\r\n".repeat(SIZE / 2),
      ];
      for (const contents of cases) expect(elapsed(() => steamNoteLines(contents, "t"))).toBeLessThan(BUDGET_MS);
    });

    it("the readers as a whole: one huge description, one huge title and a payload of thousands of posts", () => {
      const description = `<rss><channel><item><title>t</title><description>${"<p>word </p>".repeat(SIZE / 12)}</description></item></channel></rss>`;
      expect(elapsed(() => xmlEntries(aws, description))).toBeLessThan(BUDGET_MS * 2);
      const title = `<rss><channel><item><title>${"a ".repeat(SIZE / 2)}</title></item></channel></rss>`;
      expect(elapsed(() => xmlEntries(aws, title))).toBeLessThan(BUDGET_MS * 2);
      const posts = JSON.stringify({
        appnews: {
          newsitems: Array.from({ length: MAX_SCANNED_ROWS * 2 }, (_, i) => ({
            gid: String(i),
            title: `Update ${i}`,
            date: i,
          })),
        },
      });
      let count = 0;
      expect(elapsed(() => (count = jsonEntries(steam, posts).length))).toBeLessThan(BUDGET_MS * 4);
      expect(count).toBe(5);
      const gitlabBody = `<feed><entry><title>${"GitLab Patch Release: 18.4.1, ".repeat(SIZE / 30)}</title></entry></feed>`;
      expect(elapsed(() => xmlEntries(gitlab, gitlabBody))).toBeLessThan(BUDGET_MS * 2);
    });
  });
});
