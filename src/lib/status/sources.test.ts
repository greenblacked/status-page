import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  awsEventActive,
  classifyFailure,
  decodeXmlEntities,
  decodeXmlField,
  epochToIso,
  grokItemActive,
  grokItemHealth,
  parseRssItems,
  saysResolved,
} from "./sources.server.ts";
import { PayloadError, SourceError } from "./http.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

describe("grok feed", () => {
  it("reads an explicit resolution as operational", () => {
    assert.equal(grokItemHealth("Status: Resolved - all good"), "operational");
    assert.equal(grokItemHealth("Severity: Available"), "operational");
  });

  it("does not read 'majority' as a major outage", () => {
    assert.equal(grokItemHealth("The majority of requests succeeded"), "degraded");
    assert.equal(grokItemHealth("Major service disruption"), "outage");
    assert.equal(grokItemHealth("Partial outage in one region"), "outage");
    assert.equal(grokItemHealth("Scheduled maintenance window"), "maintenance");
  });

  it("ignores an unresolved item older than the staleness window", () => {
    const stale = { description: "Investigating elevated errors", pubDate: new Date(NOW - 20 * DAY).toUTCString() };
    const fresh = { description: "Investigating elevated errors", pubDate: new Date(NOW - 2 * DAY).toUTCString() };
    assert.equal(grokItemActive(stale, NOW), false);
    assert.equal(grokItemActive(fresh, NOW), true);
  });

  it("ignores an item with no usable date", () => {
    assert.equal(grokItemActive({ description: "Investigating" }, NOW), false);
    assert.equal(grokItemActive({ description: "Investigating", pubDate: "not a date" }, NOW), false);
  });

  it("ignores a resolved item even when it is recent", () => {
    const item = { description: "Status: Resolved", pubDate: new Date(NOW - 60_000).toUTCString() };
    assert.equal(grokItemActive(item, NOW), false);
  });
});

describe("aws health events", () => {
  const recent = Math.floor((NOW - DAY) / 1000);

  it("treats an event with no status as inactive unless the log says otherwise", () => {
    assert.equal(
      awsEventActive({ event_log: [{ timestamp: recent, message: "Elevated error rates" }] } as never, NOW),
      true,
    );
    assert.equal(
      awsEventActive({ event_log: [{ timestamp: recent, message: "The issue is resolved" }] } as never, NOW),
      false,
    );
  });

  it("does not read a negated or prefixed 'resolved' as a resolution", () => {
    assert.equal(saysResolved("The issue is resolved"), true);
    assert.equal(saysResolved("Resolved: services recovered"), true);
    assert.equal(saysResolved("We have not yet resolved the elevated error rates"), false);
    assert.equal(saysResolved("The issue has not been resolved"), false);
    assert.equal(saysResolved("Issue remains unresolved"), false);
    assert.equal(
      awsEventActive({ event_log: [{ timestamp: recent, message: "We have not yet resolved the errors" }] } as never, NOW),
      true,
    );
  });

  it("honours a numeric status when one is present", () => {
    assert.equal(awsEventActive({ status: 1, event_log: [{ timestamp: recent, message: "Investigating" }] } as never, NOW), true);
    assert.equal(awsEventActive({ status: 0, event_log: [{ timestamp: recent, message: "resolved" }] } as never, NOW), false);
  });

  it("does not read a blank or null status as resolved", () => {
    // Number(null) and Number("") are both 0, which would look like a
    // vendor-reported resolution and drop a live event.
    for (const status of [null, "", undefined]) {
      assert.equal(
        awsEventActive({ status, event_log: [{ timestamp: recent, message: "Elevated error rates" }] } as never, NOW),
        true,
        `status ${JSON.stringify(status)} should fall back to the update text`,
      );
    }
  });

  it("ignores closed, stale, and pre-resolved events", () => {
    assert.equal(awsEventActive({ end_time: "2026-09-21", status: 1 } as never, NOW), false);
    assert.equal(awsEventActive({ summary: "[RESOLVED] Elevated errors", status: 1 } as never, NOW), false);
    assert.equal(
      awsEventActive({ status: 1, event_log: [{ timestamp: Math.floor((NOW - 30 * DAY) / 1000), message: "Investigating" }] } as never, NOW),
      false,
    );
  });
});

describe("RSS entity decoding", () => {
  it("decodes the five predefined XML entities and numeric references", () => {
    assert.equal(decodeXmlEntities("Errors &amp; latency"), "Errors & latency");
    assert.equal(decodeXmlEntities("a &lt; b &gt; c"), "a < b > c");
    assert.equal(decodeXmlEntities("say &quot;hi&quot; &amp; &apos;bye&apos;"), "say \"hi\" & 'bye'");
    assert.equal(decodeXmlEntities("&#65;&#66;&#67;"), "ABC");
    assert.equal(decodeXmlEntities("&#x41;&#x42;&#x43;"), "ABC");
  });

  it("decodes in a single pass, so a double-escaped entity is not over-decoded", () => {
    assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
    assert.equal(decodeXmlEntities("&amp;amp;"), "&amp;");
  });

  it("leaves unknown named entities and invalid numeric references unchanged", () => {
    assert.equal(decodeXmlEntities("&copy; 2026"), "&copy; 2026");
    assert.equal(decodeXmlEntities("&#x110000;"), "&#x110000;"); // out of range
    assert.equal(decodeXmlEntities("&#xD800;"), "&#xD800;"); // lone surrogate
  });

  it("leaves XML-forbidden code points unchanged, but decodes tab and newline", () => {
    assert.equal(decodeXmlEntities("&#0;"), "&#0;"); // null: forbidden C0 control
    assert.equal(decodeXmlEntities("&#1;"), "&#1;"); // forbidden C0 control
    assert.equal(decodeXmlEntities("&#xFFFE;"), "&#xFFFE;"); // permanently-unassigned noncharacter
    assert.equal(decodeXmlEntities("a&#9;b"), "a\tb"); // tab is explicitly allowed
    assert.equal(decodeXmlEntities("a&#10;b"), "a\nb"); // line feed is explicitly allowed
    assert.equal(decodeXmlEntities("a&#13;b"), "a\rb"); // carriage return is explicitly allowed
    assert.equal(decodeXmlEntities("&#31;"), "&#31;"); // last forbidden C0 control
    assert.equal(decodeXmlEntities("&#xFFFF;"), "&#xFFFF;"); // noncharacter
  });

  it("only treats a lowercase x as hex, as XML does", () => {
    assert.equal(decodeXmlEntities("&#X41;"), "&#X41;");
  });
});

describe("decodeXmlField", () => {
  it("decodes outside CDATA and leaves CDATA content literal", () => {
    assert.equal(decodeXmlField("Errors &amp; <![CDATA[a &amp; b]]> latency"), "Errors & a &amp; b latency");
  });
});

describe("parseRssItems", () => {
  const feed = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>xAI Status</title>
<link>https://status.x.ai/</link>
${items}
</channel></rss>`;

  it("reads multiple items and does not leak the channel-level title", () => {
    const xml = feed(`
      <item><title>First issue</title><description>desc one</description><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate><link>https://status.x.ai/incidents/1</link></item>
      <item><title>Second issue</title><description>desc two</description><pubDate>Tue, 02 Sep 2026 00:00:00 GMT</pubDate><link>https://status.x.ai/incidents/2</link></item>
    `);
    const items = parseRssItems(xml);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "First issue");
    assert.equal(items[1].title, "Second issue");
    assert.notEqual(items[0].title, "xAI Status");
  });

  it("strips CDATA markers from title and description", () => {
    const xml = feed(`
      <item><title><![CDATA[CDATA title]]></title><description><![CDATA[CDATA description]]></description></item>
    `);
    const [item] = parseRssItems(xml);
    assert.equal(item.title, "CDATA title");
    assert.equal(item.description, "CDATA description");
  });

  it("decodes named, decimal, and hex entities in title and description", () => {
    const xml = feed(`
      <item><title>Errors &amp; latency</title><description>Impact: 50&#37; of &#x52;equests</description></item>
    `);
    const [item] = parseRssItems(xml);
    assert.equal(item.title, "Errors & latency");
    assert.equal(item.description, "Impact: 50% of Requests");
  });

  it("does not over-decode &amp;lt; into a literal angle bracket", () => {
    const xml = feed(`<item><title>&amp;lt;tag&amp;gt;</title><description>d</description></item>`);
    const [item] = parseRssItems(xml);
    assert.equal(item.title, "&lt;tag&gt;");
  });

  it("does not decode entities that appear inside CDATA", () => {
    const xml = feed(`
      <item><title><![CDATA[a &amp; b]]></title><description><![CDATA[c &lt; d]]></description></item>
    `);
    const [item] = parseRssItems(xml);
    assert.equal(item.title, "a &amp; b");
    assert.equal(item.description, "c &lt; d");
  });

  it("leaves pubDate and link undefined when absent", () => {
    const xml = feed(`<item><title>No date or link</title><description>desc</description></item>`);
    const [item] = parseRssItems(xml);
    assert.equal(item.pubDate, undefined);
    assert.equal(item.link, undefined);
  });

  it("returns an empty array for a feed with no items", () => {
    const xml = feed("");
    assert.deepEqual(parseRssItems(xml), []);
  });

  it("treats an unterminated CDATA section as literal text, not something to decode", () => {
    const xml = feed(`<item><title><![CDATA[a &amp; b unterminated</title><description>d</description></item>`);
    const [item] = parseRssItems(xml);
    // The marker is stripped; everything after it is literal, undecoded text.
    assert.equal(item.title, "a &amp; b unterminated");
  });
});

describe("grok feed html stripping end to end", () => {
  // Descriptions are NOT wrapped in CDATA here: the entities below must go
  // through parseRssItems's real decoding step, the same as a live feed
  // that XML-escapes literal '<'/'>' in its plain-text description.
  const feed = (description: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>xAI Status</title>
<item><title>All clear</title><description>${description}</description></item>
</channel></rss>`;

  it("reads a resolved status when decoding produces a literal '<'/'>' in plain text", () => {
    // Decodes to: Latency < 500ms. Status: Resolved. Errors > 1%
    // The old blanket stripHtml regex read "< 500ms. ... Errors >" as one
    // tag and erased "Status: Resolved" along with it.
    const xml = feed("Latency &lt; 500ms. Status: Resolved. Errors &gt; 1%");
    const [item] = parseRssItems(xml);
    assert.equal(item.description, "Latency < 500ms. Status: Resolved. Errors > 1%");
    assert.equal(grokItemHealth(item.description), "operational");
  });

  it("still strips real HTML markup once decoded", () => {
    // Decodes to: <p><b>Status:</b> Resolved</p>
    const xml = feed("&lt;p&gt;&lt;b&gt;Status:&lt;/b&gt; Resolved&lt;/p&gt;");
    const [item] = parseRssItems(xml);
    assert.equal(item.description, "<p><b>Status:</b> Resolved</p>");
    assert.equal(grokItemHealth(item.description), "operational");
  });

  it("ignores HTML comments and reads a non-breaking space as a space", () => {
    assert.equal(grokItemHealth("<!-- major outage --> Status: Resolved"), "operational");
    const xml = feed("<![CDATA[<p>Status:&nbsp;Resolved</p>]]>");
    const [item] = parseRssItems(xml);
    assert.equal(grokItemHealth(item.description), "operational");
  });
});

describe("collector failure classification", () => {
  it("separates transport failures from payload-shape failures", () => {
    assert.deepEqual(classifyFailure(new SourceError("403 Forbidden from https://x", 403)), {
      kind: "http",
      message: "403 Forbidden from https://x",
      status: 403,
    });
    assert.equal(classifyFailure(new SourceError("Timed out fetching https://x")).kind, "timeout");
    assert.equal(classifyFailure(new SourceError("getaddrinfo ENOTFOUND x")).kind, "network");
  });

  it("reports a vendor payload change as a parser failure with the real error", () => {
    let thrown: unknown;
    try {
      JSON.parse("<html>not json</html>");
    } catch (error) {
      thrown = error;
    }
    const failure = classifyFailure(thrown);
    assert.equal(failure.kind, "parser");
    assert.match(failure.message, /^SyntaxError: /);
    assert.equal(classifyFailure(new TypeError("Cannot read properties of undefined")).kind, "parser");
    // A collector's own "answered, but no usable data" check is a format
    // change too, even though it carries no HTTP status.
    assert.deepEqual(classifyFailure(new PayloadError("Grok feed returned no readable items.")), {
      kind: "parser",
      message: "Grok feed returned no readable items.",
    });
  });
});

describe("epochToIso", () => {
  it("converts epoch seconds and milliseconds, as numbers or numeric strings", () => {
    assert.equal(epochToIso(1789558341, 1000), "2026-09-16T11:32:21.000Z");
    assert.equal(epochToIso("1789558341", 1000), "2026-09-16T11:32:21.000Z");
    assert.equal(epochToIso(1789558341000, 1), "2026-09-16T11:32:21.000Z");
  });

  it("returns undefined instead of throwing for anything that is not a usable timestamp", () => {
    for (const value of [undefined, null, "", "n/a", "   ", 0, "0", Number.NaN, Number.POSITIVE_INFINITY, 1e20, {}, true]) {
      assert.equal(epochToIso(value, 1000), undefined, String(value));
    }
  });
});
