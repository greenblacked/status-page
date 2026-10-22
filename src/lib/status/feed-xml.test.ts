import { describe, expect, it } from "vitest";
import { MAX_RSS_ITEMS, parseFeedDate, parseRssItems } from "./feed-xml.ts";

describe("parseFeedDate", () => {
  it("reads an RFC 822 date with a zone abbreviation Date.parse does not know", () => {
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 CEST")).toBe(Date.parse("2026-09-21T08:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 cet")).toBe(Date.parse("2026-09-21T09:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 BST")).toBe(Date.parse("2026-09-21T09:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 IST")).toBe(Date.parse("2026-09-21T04:30:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 JST")).toBe(Date.parse("2026-09-21T01:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 AEDT")).toBe(Date.parse("2026-09-20T23:00:00Z"));
  });

  it("reads the forms Date.parse already knows: GMT, a US zone and a numeric offset", () => {
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 GMT")).toBe(Date.parse("2026-09-21T10:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 PDT")).toBe(Date.parse("2026-09-21T17:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 +0200")).toBe(Date.parse("2026-09-21T08:00:00Z"));
    expect(parseFeedDate("2026-09-21T10:00:00-04:00")).toBe(Date.parse("2026-09-21T14:00:00Z"));
  });

  it("reads a date and time with no zone as UTC, whatever the host's zone", () => {
    expect(parseFeedDate("2026-09-21 10:00")).toBe(Date.parse("2026-09-21T10:00:00Z"));
    expect(parseFeedDate(" 2026-09-21 10:00:30 ")).toBe(Date.parse("2026-09-21T10:00:30Z"));
    expect(parseFeedDate("2026-09-21T10:00:30")).toBe(Date.parse("2026-09-21T10:00:30Z"));
  });

  it("is undefined for nothing, garbage and an unknown zone", () => {
    expect(parseFeedDate(undefined)).toBeUndefined();
    expect(parseFeedDate("")).toBeUndefined();
    expect(parseFeedDate("   ")).toBeUndefined();
    expect(parseFeedDate("yesterday")).toBeUndefined();
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 XYZ")).toBeUndefined();
    expect(parseFeedDate(`Mon, 21 Sep 2026 10:00:00 ${"CEST ".repeat(100)}`)).toBeUndefined();
  });
});

describe("parseRssItems", () => {
  it("reads a field whose tag carries attributes, or whose closing tag has a space", () => {
    const [item] = parseRssItems(
      '<rss><channel><item><title type="html">Hello</title><description\n  type="text">Body</description >' +
        "<pubDate>Mon, 21 Sep 2026 10:00:00 GMT</pubDate ></item></channel></rss>",
    );
    expect(item).toMatchObject({ title: "Hello", description: "Body", pubDate: "Mon, 21 Sep 2026 10:00:00 GMT" });
  });

  it("does not read a longer tag name as the field, nor a self-closing one as its text", () => {
    const [item] = parseRssItems(
      "<item><titles>Wrong</titles><title>Right</title><link/><link>https://example.com/a</link></item>",
    );
    expect(item.title).toBe("Right");
    expect(item.link).toBe("https://example.com/a");
  });

  it("returns the item's guid", () => {
    const [item] = parseRssItems(
      '<rss><channel><item><title>A</title><guid isPermaLink="false">INC123</guid></item><item><title>B</title></item></channel></rss>',
    );
    expect(item.guid).toBe("INC123");
    expect(parseRssItems("<item><title>B</title></item>")[0].guid).toBeUndefined();
  });

  it("reads an Atom feed's entries: title, summary or content, updated or published, the alternate link and id", () => {
    const items = parseRssItems(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Status</title><link href="https://status.example.com/" rel="alternate"/>
      <entry>
        <id>tag:status.example.com,2026:1</id>
        <title type="html">API &amp;amp; web errors</title>
        <link rel="self" href="https://status.example.com/feed/1"/>
        <link rel="alternate" type="text/html" href="https://status.example.com/incidents/1?a=1&amp;b=2"/>
        <updated>2026-09-21T10:00:00Z</updated>
        <summary type="html">&lt;p&gt;Investigating&lt;/p&gt;</summary>
      </entry>
      <entry>
        <id>tag:status.example.com,2026:2</id>
        <title>Second</title>
        <link href="https://status.example.com/incidents/2"/>
        <published>2026-09-20T10:00:00+02:00</published>
        <content type="html"><![CDATA[<p>Resolved</p>]]></content>
      </entry>
    </feed>`);
    expect(items).toEqual([
      {
        title: "API &amp; web errors",
        description: "<p>Investigating</p>",
        pubDate: "2026-09-21T10:00:00Z",
        link: "https://status.example.com/incidents/1?a=1&b=2",
        guid: "tag:status.example.com,2026:1",
      },
      {
        title: "Second",
        description: "<p>Resolved</p>",
        pubDate: "2026-09-20T10:00:00+02:00",
        link: "https://status.example.com/incidents/2",
        guid: "tag:status.example.com,2026:2",
      },
    ]);
  });

  it("reads RSS items, not Atom entries, when a feed has both", () => {
    const items = parseRssItems(
      "<rss><channel><item><title>Item</title></item><entry><title>Entry</title></entry></channel></rss>",
    );
    expect(items.map((item) => item.title)).toEqual(["Item"]);
  });

  it("keeps the newest Atom entries by their dates, in the feed's order", () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
    const entries = Array.from(
      { length: MAX_RSS_ITEMS + 10 },
      (_, i) => `<entry><title>e${i}</title><updated>${day(i)}</updated></entry>`,
    );
    const items = parseRssItems(`<feed>${entries.join("")}</feed>`);
    expect(items).toHaveLength(MAX_RSS_ITEMS);
    expect(items[0].title).toBe("e10");
  });
});
