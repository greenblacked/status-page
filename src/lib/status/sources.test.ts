import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PayloadError, SourceError } from "./http.ts";
import {
  awsComponents,
  awsEventActive,
  awsEventSubject,
  awsIncidentTitle,
  awsLatestLog,
  azureItemActive,
  azureItemHealth,
  classifyFailure,
  decodeXmlEntities,
  decodeXmlField,
  epochToIso,
  googleComponents,
  grokFeedComponents,
  grokItemActive,
  grokItemHealth,
  grokTitleService,
  isoTimestamp,
  parseGoogleProducts,
  parseInstatusComponents,
  parseRssItems,
  saysResolved,
  steamCmCount,
} from "./sources.server.ts";

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
      awsEventActive(
        { event_log: [{ timestamp: recent, message: "We have not yet resolved the errors" }] } as never,
        NOW,
      ),
      true,
    );
  });

  it("honours a numeric status when one is present", () => {
    assert.equal(
      awsEventActive({ status: 1, event_log: [{ timestamp: recent, message: "Investigating" }] } as never, NOW),
      true,
    );
    assert.equal(
      awsEventActive({ status: 0, event_log: [{ timestamp: recent, message: "resolved" }] } as never, NOW),
      false,
    );
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
      awsEventActive(
        {
          status: 1,
          event_log: [{ timestamp: Math.floor((NOW - 30 * DAY) / 1000), message: "Investigating" }],
        } as never,
        NOW,
      ),
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

  it("keeps an unclosed comment opener and stray angle brackets as text, and strips closed ones around them", () => {
    // The unclosed "<!--" does not swallow the text after it.
    assert.equal(grokItemHealth("<!-- never closed. Status: Resolved"), "operational");
    assert.equal(grokItemHealth("a <!-- unclosed, then <!-- closed --> Status: Resolved"), "operational");
    // "<!-->" is not a closed comment, so a later "-->" is what ends it.
    assert.equal(grokItemHealth("<!--> major outage --> Status: Resolved"), "operational");
    assert.equal(grokItemHealth("x < y <b>Status: Resolved</b> z > w"), "operational");
    assert.equal(grokItemHealth("<> <1> </ > major outage"), "outage");
  });

  it("keeps malformed markup and finds complete tags inside an unclosed comment", () => {
    assert.equal(grokItemHealth("abc<!--> Status: Resolved"), "operational");
    assert.equal(grokItemHealth("<!-- <p>Status:&nbsp;Resolved</p>"), "operational");
    assert.equal(grokItemHealth("<p <b>Status: Resolved</b>"), "operational");
    assert.equal(grokItemHealth("Latency < 500ms. Status: Resolved. Errors > 1%"), "operational");
  });
});

describe("parseRssItems field scanning", () => {
  it("reads tags in any case, the first open tag with its first close, and fields past an unclosed one", () => {
    const [item] = parseRssItems(
      "<ITEM><Title>One</TITLE><DESCRIPTION>Two</Description><pubdate>d</PUBDATE><LINK> l </link></ITEM>",
    );
    assert.deepEqual(item, { title: "One", description: "Two", pubDate: "d", link: "l" });
    const [nested] = parseRssItems("<item><title>a<title>b</title></item>");
    assert.equal(nested.title, "a<title>b");
    const [open] = parseRssItems("<item><title>never closed<link>https://x</link></item>");
    assert.equal(open.title, "");
    assert.equal(open.link, "https://x");
  });

  it("keeps each item's fields to that item, whether or not it is closed", () => {
    const items = parseRssItems(
      "<item><title>A</title><item><description>b</description><item attr='1'><title>C</title></item><title>outside</title>",
    );
    assert.deepEqual(
      items.map((item) => [item.title, item.description]),
      [
        ["A", ""],
        ["", "b"],
        ["C", ""],
      ],
    );
  });

  it("keeps the first complete field pair and the original item delimiters", () => {
    assert.deepEqual(parseRssItems("<ITEM\t><TITLE> first </TITLE><title>second</title><link>&amp;</link></ITEM>"), [
      { title: "first", description: "", pubDate: undefined, link: "&" },
    ]);
    assert.deepEqual(parseRssItems("<items><title>ignored</title></items><item><title>kept</title></item>"), [
      { title: "kept", description: "", pubDate: undefined, link: undefined },
    ]);
    assert.deepEqual(parseRssItems("İ<item><title>İssue</title><description>İ</description></item>"), [
      { title: "İssue", description: "İ", pubDate: undefined, link: undefined },
    ]);
  });

  it("leaves a field empty after repeated unclosed openers while reading the next field", () => {
    assert.deepEqual(parseRssItems(`<item>${"<title>".repeat(100)}<description>Working</description></item>`), [
      { title: "", description: "Working", pubDate: undefined, link: undefined },
    ]);
    assert.deepEqual(parseRssItems("<item><title>unclosed<item><title>second</title></item>"), [
      { title: "", description: "", pubDate: undefined, link: undefined },
      { title: "second", description: "", pubDate: undefined, link: undefined },
    ]);
    assert.deepEqual(parseRssItems(`<item><title>Okay</title>${"<description><pubDate><link>".repeat(20)}</item>`), [
      { title: "Okay", description: "", pubDate: undefined, link: undefined },
    ]);
  });
});

describe("decodeXmlField scanning", () => {
  it("handles several CDATA sections and an unterminated one after them", () => {
    assert.equal(decodeXmlField("&amp;<![CDATA[&amp;]]>&amp;<![CDATA[x]]>&lt;"), "&&amp;&x<");
    assert.equal(decodeXmlField("&amp;<![CDATA[a]]>&amp;<![CDATA[&amp;"), "&a&&amp;");
  });

  it("keeps later openers literal when the first CDATA section has no closer", () => {
    assert.equal(decodeXmlField("&amp; <![CDATA[a <![CDATA[b &lt; c"), "& a <![CDATA[b &lt; c");
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

  it("reports a vendor payload change as a parser failure", () => {
    let thrown: unknown;
    try {
      JSON.parse("<html>not json</html>");
    } catch (error) {
      thrown = error;
    }
    assert.deepEqual(classifyFailure(thrown), {
      kind: "parser",
      message: "SyntaxError: response was not valid JSON",
    });
    assert.equal(classifyFailure(new TypeError("Cannot read properties of undefined")).kind, "parser");
    // A collector's own "answered, but no usable data" check is a format
    // change too, even though it carries no HTTP status.
    assert.deepEqual(classifyFailure(new PayloadError("Grok feed returned no readable items.")), {
      kind: "parser",
      message: "Grok feed returned no readable items.",
    });
  });
});

describe("collector failure messages do not echo the response body", () => {
  it("never carries the start of an unparseable body, whichever way V8 words the error", () => {
    const secret = "TOP-SECRET-BODY-TEXT";
    for (const body of [`<html>${secret}</html>`, `{"a":${secret}}`, `${secret}`, `[1,${secret}`, `{${secret}: 1}`]) {
      let thrown: unknown;
      try {
        JSON.parse(body);
      } catch (error) {
        thrown = error;
      }
      // The raw message does quote the body, which is the leak being closed.
      assert.ok(thrown instanceof SyntaxError);
      const { kind, message } = classifyFailure(thrown);
      assert.equal(kind, "parser");
      assert.equal(message, "SyntaxError: response was not valid JSON");
      assert.ok(!message.includes(secret));
    }
  });

  it("still names a coding error by its own message, which is ours", () => {
    assert.equal(
      classifyFailure(new TypeError("value.filter is not a function")).message,
      "TypeError: value.filter is not a function",
    );
  });
});

describe("epochToIso", () => {
  it("converts epoch seconds and milliseconds, as numbers or numeric strings", () => {
    assert.equal(epochToIso(1789558341, 1000), "2026-09-16T11:32:21.000Z");
    assert.equal(epochToIso("1789558341", 1000), "2026-09-16T11:32:21.000Z");
    assert.equal(epochToIso(1789558341000, 1), "2026-09-16T11:32:21.000Z");
  });

  it("returns undefined instead of throwing for anything that is not a usable timestamp", () => {
    for (const value of [
      undefined,
      null,
      "",
      "n/a",
      "   ",
      0,
      "0",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1e20,
      {},
      true,
    ]) {
      assert.equal(epochToIso(value, 1000), undefined, String(value));
    }
  });
});

describe("isoTimestamp", () => {
  it("passes an ISO string through, normalised", () => {
    assert.equal(isoTimestamp("2026-09-16T11:32:21Z"), "2026-09-16T11:32:21.000Z");
    assert.equal(isoTimestamp("2026-09-16T13:32:21.500+02:00"), "2026-09-16T11:32:21.500Z");
  });

  it("reads a space-separated date and time, which Safari cannot parse, as UTC", () => {
    assert.equal(isoTimestamp("2026-09-16 11:32"), "2026-09-16T11:32:00.000Z");
    assert.equal(isoTimestamp("2026-09-16 11:32:05"), "2026-09-16T11:32:05.000Z");
    assert.equal(isoTimestamp("2026-09-16 11:32 +0200"), "2026-09-16T09:32:00.000Z");
    assert.equal(isoTimestamp(" 2026-09-16 11:32 Z "), "2026-09-16T11:32:00.000Z");
  });

  it("returns undefined for anything that is not a usable timestamp", () => {
    for (const value of [undefined, null, "", "   ", "n/a", "2026-13-45 99:99", 1789558341, {}, true]) {
      assert.equal(isoTimestamp(value), undefined, String(value));
    }
  });
});

describe("parseGoogleProducts", () => {
  it("reads the catalogue from an object or a bare array, in the vendor's order", () => {
    const rows = [{ title: "Cloud Run", id: "a" }, { title: " BigQuery " }];
    const expected = [
      { id: "a", title: "Cloud Run" },
      { id: undefined, title: "BigQuery" },
    ];
    assert.deepEqual(parseGoogleProducts({ products: rows }), expected);
    assert.deepEqual(parseGoogleProducts(rows), expected);
  });

  it("returns nothing for an empty or malformed catalogue", () => {
    for (const value of [null, undefined, "x", 3, {}, { products: null }, { products: "x" }, []]) {
      assert.deepEqual(parseGoogleProducts(value), [], String(value));
    }
  });

  it("drops rows without a usable title and repeated titles", () => {
    const rows = [null, {}, { title: "" }, { title: 4 }, { title: "Cloud Run" }, { title: "cloud run", id: "dup" }];
    assert.deepEqual(parseGoogleProducts(rows), [{ id: undefined, title: "Cloud Run" }]);
  });
});

describe("googleComponents", () => {
  const products = [
    { id: "run", title: "Cloud Run" },
    { id: "sql", title: "Cloud SQL" },
  ];

  it("is every product operational when nothing is open", () => {
    assert.deepEqual(googleComponents(products, []), [
      { name: "Cloud Run", health: "operational" },
      { name: "Cloud SQL", health: "operational" },
    ]);
  });

  it("keeps the worst impact, with the same mapping as the card", () => {
    const rows = googleComponents(products, [
      { id: "1", status_impact: "SERVICE_DISRUPTION", external_desc: "Slow", affected_products: [{ id: "run" }] },
      { id: "2", status_impact: "SERVICE_OUTAGE", external_desc: "Down", affected_products: [{ id: "run" }] },
      { id: "3", status_impact: "SERVICE_DISRUPTION", external_desc: "Later", affected_products: [{ id: "run" }] },
    ]);
    assert.deepEqual(rows[0], { name: "Cloud Run", health: "outage", detail: "Down" });
  });

  it("leaves a product operational, with no detail, for an information-only notice", () => {
    const rows = googleComponents(products, [
      { id: "n", status_impact: "SERVICE_INFORMATION", external_desc: "FYI", affected_products: [{ id: "run" }] },
    ]);
    assert.deepEqual(rows[0], { name: "Cloud Run", health: "operational" });
  });

  it("reads an unrecognised impact as unknown, not as a degradation", () => {
    const rows = googleComponents(products, [
      { id: "n", status_impact: "SOMETHING_NEW", external_desc: "Odd", affected_products: [{ id: "run" }] },
    ]);
    assert.deepEqual(rows[0], { name: "Cloud Run", health: "unknown", detail: "Odd" });
  });

  it("falls back to service_name when an incident lists no products", () => {
    const rows = googleComponents(products, [
      { id: "1", status_impact: "SERVICE_DISRUPTION", external_desc: "Slow", service_name: "cloud sql" },
    ]);
    assert.deepEqual(rows[1], { name: "Cloud SQL", health: "degraded", detail: "Slow" });
  });

  it("ignores an affected-product entry with neither id nor title", () => {
    const rows = googleComponents(products, [{ id: "1", status_impact: "SERVICE_OUTAGE", affected_products: [{}] }]);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.health === "operational"));
  });

  it("matches by id or lower-cased title, the earliest product winning, and finds a product it added", () => {
    const dup = [
      { id: "a", title: "Alpha" },
      { id: "b", title: "Beta" },
    ];
    // Id "b" names the second product, title "alpha" the first: the earlier row is the match.
    const rows = googleComponents(dup, [
      { id: "1", status_impact: "SERVICE_OUTAGE", affected_products: [{ id: "b", title: " ALPHA " }] },
    ]);
    assert.deepEqual(rows, [
      { name: "Alpha", health: "outage" },
      { name: "Beta", health: "operational" },
    ]);
    // A product the catalogue lacks is added once and then matched by later references.
    const added = googleComponents(dup, [
      { id: "1", status_impact: "SERVICE_DISRUPTION", affected_products: [{ id: "z", title: "Zeta" }] },
      { id: "2", status_impact: "SERVICE_OUTAGE", affected_products: [{ title: "zeta" }, { id: "z" }] },
    ]);
    assert.deepEqual(
      added.map((row) => [row.name, row.health]),
      [
        ["Alpha", "operational"],
        ["Beta", "operational"],
        ["Zeta", "outage"],
      ],
    );
  });

  it("chooses the earliest matching row across ID and title, including duplicate and empty IDs", () => {
    const rows = googleComponents(
      [
        { id: "", title: "First" },
        { id: "duplicate", title: "By title" },
        { id: "duplicate", title: "By ID" },
      ],
      [
        { id: "1", status_impact: "SERVICE_OUTAGE", affected_products: [{ id: "duplicate", title: " first " }] },
        { id: "2", status_impact: "SERVICE_DISRUPTION", affected_products: [{ id: "duplicate", title: "unknown" }] },
      ],
    );
    assert.deepEqual(
      rows.map((row) => row.health),
      ["outage", "degraded", "operational"],
    );
  });

  it("does not add an ID alias to a row matched by its title", () => {
    const rows = googleComponents(
      [{ id: "catalogue", title: "Cloud Run" }],
      [
        { id: "1", status_impact: "SERVICE_DISRUPTION", affected_products: [{ id: "alias", title: "cloud run" }] },
        { id: "2", status_impact: "SERVICE_OUTAGE", affected_products: [{ id: "alias", title: "New product" }] },
      ],
    );
    assert.deepEqual(
      rows.map((row) => [row.name, row.health]),
      [
        ["Cloud Run", "degraded"],
        ["New product", "outage"],
      ],
    );
  });

  it("stays fast with thousands of products and references", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}`, title: `Product ${i}` }));
    const incident = {
      id: "1",
      status_impact: "SERVICE_OUTAGE",
      affected_products: many.map((product) => ({ id: product.id, title: product.title })),
    };
    const started = performance.now();
    const rows = googleComponents(many, [incident]);
    const took = performance.now() - started;
    assert.equal(rows.length, 5000);
    assert.ok(rows.every((row) => row.health === "outage"));
    // The scan this replaced took seconds here; a lookup takes a few ms.
    assert.ok(took < 200, `took ${took}ms`);
  });
});

describe("steamCmCount", () => {
  const server = (endpoint: string, type = "websockets") => ({
    endpoint,
    legacy_endpoint: endpoint,
    type,
    dc: "fra2",
    realm: "steamglobal",
    load: 5,
    wtd_load: 3.1,
  });

  it("counts the serverlist objects that have an endpoint", () => {
    const serverlist = [server("cmp1-fra2.steamserver.net:27021"), server("155.133.248.39:27019", "netfilter")];
    assert.equal(steamCmCount({ response: { serverlist, success: true, message: "" } }), 2);
    assert.equal(steamCmCount({ response: { serverlist } }), 2);
  });

  it("skips rows that are not server objects", () => {
    const serverlist = [server("cm1:27017"), "cm2:27017", null, {}, { endpoint: "" }, { endpoint: 4 }];
    assert.equal(steamCmCount({ response: { serverlist } }), 1);
  });

  it("is 0 when success is false, or for an empty list, a wrong shape or garbage", () => {
    assert.equal(steamCmCount({ response: { serverlist: [server("cm1:27017")], success: false } }), 0);
    for (const value of [
      null,
      undefined,
      "x",
      {},
      { response: null },
      { response: { serverlist: [] } },
      { response: { serverlist: "cm1:27017" } },
      { response: { serverlist_websockets: ["cm1:27017"] } },
    ]) {
      assert.equal(steamCmCount(value), 0, String(value));
    }
  });
});

describe("parseInstatusComponents", () => {
  it("flattens parents into their children and maps each status", () => {
    const rows = parseInstatusComponents({
      components: [
        { name: "Chat", status: "PARTIALOUTAGE", children: [{ name: "Web", status: "DEGRADEDPERFORMANCE" }] },
        { name: "API", status: "OPERATIONAL", children: [] },
        { name: "Voice", status: "MAJOROUTAGE", description: "Down for everyone" },
        { name: "Images", status: "UNDERMAINTENANCE" },
        { name: "Odd", status: "SOMETHING" },
      ],
    });
    assert.deepEqual(rows, [
      { name: "Web", health: "degraded" },
      { name: "API", health: "operational" },
      { name: "Voice", health: "outage", detail: "Down for everyone" },
      { name: "Images", health: "maintenance" },
      { name: "Odd", health: "unknown" },
    ]);
  });

  it("replaces a component with its children at any depth", () => {
    const rows = parseInstatusComponents({
      components: [
        {
          name: "Platform",
          status: "PARTIALOUTAGE",
          children: [
            { name: "Web", status: "OPERATIONAL", children: [{ name: "Login", status: "MAJOROUTAGE" }] },
            { name: "Mobile", status: "OPERATIONAL" },
          ],
        },
      ],
    });
    assert.deepEqual(rows, [
      { name: "Login", health: "outage" },
      { name: "Mobile", health: "operational" },
    ]);
  });

  it("returns nothing for an empty or malformed payload", () => {
    for (const value of [null, undefined, "x", [], {}, { components: {} }, { components: [null, {}, { name: 3 }] }]) {
      assert.deepEqual(parseInstatusComponents(value), [], String(value));
    }
  });
});

describe("grok feed components", () => {
  it("reads the [Service] a title leads with, keeping the whole bracket text", () => {
    assert.deepEqual(grokTitleService("[Grok (iOS)] Models outage"), { name: "Grok (iOS)", detail: "Models outage" });
    assert.deepEqual(grokTitleService("[API (us-east-1.api.x.ai)] Models outage"), {
      name: "API (us-east-1.api.x.ai)",
      detail: "Models outage",
    });
    assert.deepEqual(grokTitleService("[API Console]Console not loading"), {
      name: "API Console",
      detail: "Console not loading",
    });
  });

  it("names no service for a title without a bracket lead, and does not read colons", () => {
    for (const title of [
      "Elevated error rates on Grok",
      "API: Elevated error rates",
      "Update: we are investigating",
      "[] Nothing named",
      "[API]",
      "[API]   ",
      `[${"x".repeat(65)}] too long`,
      "Trailing [API] mention",
      "",
    ]) {
      assert.equal(grokTitleService(title), null, title);
    }
  });

  it("merges items per service: worst health, newest detail", () => {
    const rows = grokFeedComponents([
      {
        title: "[API] Older",
        description: "<h3>Status: ONGOING</h3><p>Severity: degraded</p>",
        pubDate: "Sun, 20 Sep 2026 08:00:00 GMT",
      },
      {
        title: "[API] Newer",
        description: "<h3>Status: ONGOING</h3><p>Severity: outage</p>",
        pubDate: "Sun, 20 Sep 2026 10:00:00 GMT",
      },
      {
        title: "No lead here",
        description: "<h3>Status: ONGOING</h3><p>Severity: outage</p>",
        pubDate: "Sun, 20 Sep 2026 10:00:00 GMT",
      },
    ]);
    assert.deepEqual(rows, [{ name: "API", health: "outage", detail: "Newer" }]);
  });

  it("has nothing to list when no title carries a service", () => {
    assert.deepEqual(grokFeedComponents([]), []);
  });
});

describe("awsComponents", () => {
  const event = (over: Record<string, unknown>) => ({ service_name: "AWS Lambda", summary: "Slow", ...over });

  it("returns nothing without events, and skips events that name no service", () => {
    assert.deepEqual(awsComponents([]), []);
    assert.deepEqual(awsComponents([event({ service_name: undefined }), event({ service_name: "  " })] as never), []);
  });

  it("merges by service: worst health, every region, and the newest event's summary", () => {
    const rows = awsComponents([
      event({ region_name: "Ireland", summary: "Newer", event_log: [{ timestamp: 200 }] }),
      event({ region_name: "", summary: "Older outage", event_log: [{ timestamp: 100, message: "outage" }] }),
      event({ region_name: "N. Virginia", summary: "Oldest", event_log: [{ timestamp: 50 }] }),
      event({ service_name: "Amazon S3", summary: "Errors", region_name: "Ohio" }),
    ] as never);
    assert.deepEqual(rows, [
      { name: "AWS Lambda", health: "outage", detail: "Ireland, N. Virginia · Newer" },
      { name: "Amazon S3", health: "degraded", detail: "Ohio · Errors" },
    ]);
  });

  it("emits a row per impacted service of a multi-service event, never the umbrella name", () => {
    const rows = awsComponents([
      {
        service_name: "Multiple services",
        summary: "Global service outage",
        region_name: "",
        impacted_services: {
          a: { service_name: "Amazon S3", current: "3", max: "3" },
          b: { service_name: "AWS Lambda", current: 2 },
          c: { service_name: "Amazon SQS", current: "1" },
          d: { service_name: "Amazon SNS", current: "0" },
          e: { service_name: "  ", current: "3" },
          f: { current: "3" },
        },
      },
    ] as never);
    assert.deepEqual(rows, [
      { name: "Amazon S3", health: "outage", detail: "Global service outage" },
      { name: "AWS Lambda", health: "degraded", detail: "Global service outage" },
      { name: "Amazon SQS", health: "degraded", detail: "Global service outage" },
    ]);
  });

  it("unions the regions of every event for a service, whichever event is newest", () => {
    const older = { service_name: "Amazon S3", summary: "Older", event_log: [{ timestamp: 100 }] };
    const newer = { service_name: "Amazon S3", summary: "Newer", event_log: [{ timestamp: 200 }] };
    // The newest event is global (no region); the older one's region is kept.
    assert.deepEqual(
      awsComponents([
        { ...older, region_name: "Ohio" },
        { ...newer, region_name: "" },
      ] as never),
      [{ name: "Amazon S3", health: "degraded", detail: "Ohio · Newer" }],
    );
    // The newest event is regional: both regions are named, in the order met.
    assert.deepEqual(
      awsComponents([
        { ...newer, region_name: "Ohio" },
        { ...older, region_name: "Ireland" },
      ] as never),
      [{ name: "Amazon S3", health: "degraded", detail: "Ohio, Ireland · Newer" }],
    );
  });

  it("reads the newest log entry by timestamp, not by position, for the summary", () => {
    const rows = awsComponents([
      {
        service_name: "Amazon S3",
        region_name: "Ohio",
        event_log: [
          { summary: "Newest update", timestamp: 300 },
          { summary: "Oldest update", timestamp: 100 },
        ],
      },
    ] as never);
    assert.deepEqual(rows, [{ name: "Amazon S3", health: "degraded", detail: "Ohio · Newest update" }]);
  });

  it("never lists the umbrella name 'Multiple services' as a row", () => {
    assert.deepEqual(awsComponents([{ service_name: "Multiple services", summary: "Errors" }] as never), []);
  });

  it("does not read a blank or missing `current` as recovered", () => {
    const rows = awsComponents([
      {
        service_name: "Multiple services",
        summary: "Elevated errors",
        region_name: "Ohio",
        impacted_services: {
          a: { service_name: "Amazon S3", current: "" },
          b: { service_name: "AWS Lambda", current: "  " },
          c: { service_name: "Amazon SQS" },
          d: { service_name: "Amazon SNS", current: "0" },
          e: { service_name: "Amazon SES", current: 0 },
        },
      },
    ] as never);
    assert.deepEqual(
      rows.map((row) => row.name),
      ["Amazon S3", "AWS Lambda", "Amazon SQS"],
    );
    assert.ok(rows.every((row) => row.health === "degraded"));
  });

  it("reports a regional disruption as an outage, and falls back to the event when impacted_services is empty", () => {
    const rows = awsComponents([
      {
        service_name: "Multiple services",
        summary: "Elevated errors",
        region_name: "Ohio",
        status: "3",
        impacted_services: { a: { service_name: "Amazon S3", current: "3" } },
      },
      { service_name: "Amazon EC2", summary: "Slow", region_name: "Ohio", impacted_services: {} },
    ] as never);
    assert.deepEqual(rows, [
      { name: "Amazon S3", health: "outage", detail: "Ohio · Elevated errors" },
      { name: "Amazon EC2", health: "degraded", detail: "Ohio · Slow" },
    ]);
  });
});

describe("AWS event severity", () => {
  const recent = Math.floor(Date.now() / 1000) - 600;
  const log = [{ summary: "Update", message: "Investigating.", timestamp: recent }];

  it("awsLatestLog takes the maximum timestamp, wherever it sits in the list", () => {
    const newest = { summary: "newest", timestamp: 300 };
    assert.deepEqual(
      awsLatestLog({ event_log: [newest, { summary: "old", timestamp: 100 }, { summary: "mid", timestamp: 200 }] }),
      newest,
    );
    assert.equal(awsLatestLog({ event_log: [{ summary: "a" }, { summary: "b" }] })?.summary, "b");
    assert.equal(awsLatestLog({}), undefined);
  });

  it("awsEventActive uses the newest entry, so a fresh update listed first keeps the event live", () => {
    const now = Date.now();
    const stale = Math.floor((now - 30 * 24 * 60 * 60 * 1000) / 1000);
    assert.equal(
      awsEventActive(
        {
          status: "1",
          event_log: [
            { timestamp: recent, message: "Still investigating" },
            { timestamp: stale, message: "First look" },
          ],
        },
        now,
      ),
      true,
    );
  });

  it("a service disruption (status 3) is an outage even in one region; a performance issue (2) is degraded", () => {
    const rows = (status: string, summary = "Errors") =>
      awsComponents([{ service_name: "Amazon S3", summary, region_name: "Ohio", status, event_log: log }] as never)[0]
        ?.health;
    assert.equal(rows("3"), "outage");
    assert.equal(rows("2"), "degraded");
    // The vendor's status beats the wording: a performance issue that says
    // "unavailable" is still a performance issue.
    assert.equal(rows("2", "Bucket unavailable"), "degraded");
    // Informational or unreported: the wording decides, as before.
    assert.equal(rows("1"), "degraded");
    assert.equal(rows("1", "Scheduled maintenance"), "maintenance");
  });

  it("an impacted service's own level sets its row, and a recovered one has none", () => {
    const rows = awsComponents([
      {
        service_name: "Multiple services",
        summary: "Errors",
        region_name: "Ohio",
        status: "3",
        impacted_services: {
          a: { service_name: "Amazon S3", current: "3" },
          b: { service_name: "AWS Lambda", current: "2" },
          c: { service_name: "Amazon SQS", current: "0" },
        },
      },
    ] as never);
    assert.deepEqual(
      rows.map((row) => [row.name, row.health]),
      [
        ["Amazon S3", "outage"],
        ["AWS Lambda", "degraded"],
      ],
    );
  });

  it("names the region in the incident title, and the services instead of 'Multiple services'", () => {
    assert.equal(
      awsIncidentTitle({ service_name: "Amazon S3", summary: "Errors", region_name: "Ohio" }),
      "Amazon S3 (Ohio) — Errors",
    );
    assert.equal(awsIncidentTitle({ service_name: "Amazon S3", summary: "Errors" }), "Amazon S3 — Errors");
    const multi = (names: string[], region = "Ohio") => ({
      service_name: "Multiple services",
      summary: "Errors",
      region_name: region,
      impacted_services: Object.fromEntries(names.map((name, i) => [`k${i}`, { service_name: name, current: "2" }])),
    });
    assert.equal(awsEventSubject(multi(["Amazon S3"])), "Amazon S3");
    assert.equal(awsEventSubject(multi(["Amazon S3", "AWS Lambda"])), "Amazon S3 and AWS Lambda");
    assert.equal(awsEventSubject(multi(["Amazon S3", "AWS Lambda", "Amazon SQS"])), "3 AWS services");
    assert.equal(awsIncidentTitle(multi(["Amazon S3", "AWS Lambda", "Amazon SQS"])), "3 AWS services (Ohio) — Errors");
    // Nothing named: still not the bare placeholder.
    assert.equal(awsEventSubject({ service_name: "Multiple services" }), "Multiple AWS services");
    assert.equal(awsEventSubject({}), "AWS");
  });
});

describe("azure feed", () => {
  it("reads an item's health from its title", () => {
    assert.equal(azureItemHealth("Storage - East US - Increased latency"), "degraded");
    assert.equal(azureItemHealth("Virtual Machines - Service unavailable"), "outage");
    assert.equal(azureItemHealth("Regional OUTAGE"), "outage");
    assert.equal(azureItemHealth("Preliminary Post Incident Review (PIR) – Azure Front Door – Outage"), "operational");
    assert.equal(azureItemHealth("Final Post Incident Review (PIR) – Networking"), "operational");
    assert.equal(azureItemHealth("Preliminary findings: Storage - East US"), "degraded");
    assert.equal(azureItemHealth("Planned maintenance - Key Vault"), "maintenance");
    // An outage wording beats maintenance: the service is down while it is worked on.
    assert.equal(azureItemHealth("Maintenance overran: service unavailable"), "outage");
  });

  it("does not make an outage of a word that only suggests one", () => {
    assert.equal(azureItemHealth("Requests may be intermittently unavailable in one region"), "degraded");
    assert.equal(azureItemHealth("Drill down in Service Health"), "degraded");
    assert.equal(azureItemHealth("Networking - Services down in West US"), "degraded");
  });

  it("calls an item over only when its title begins with a resolution or a review", () => {
    assert.equal(azureItemHealth("RESOLVED - Storage"), "operational");
    assert.equal(azureItemHealth("  Resolved: SQL"), "operational");
    assert.equal(azureItemHealth("[Resolved] SQL"), "operational");
    assert.equal(azureItemHealth("Mitigated - SQL"), "operational");
    assert.equal(azureItemHealth("Post Incident Review (PIR) - Networking"), "operational");
    assert.equal(azureItemHealth("Post-incident review - Networking"), "operational");
    assert.equal(azureItemHealth("PIR - Networking"), "operational");
    // A word later in the title, or one that only starts with it, does not end it.
    assert.equal(azureItemHealth("SQL issue resolved in East US only"), "degraded");
    assert.equal(azureItemHealth("Unresolved - SQL"), "degraded");
    assert.equal(azureItemHealth("Pirate Cove Storage"), "degraded");
  });

  it("does not read an active item as over from the words of its text", () => {
    // The four wordings a live incident can carry in its body or title.
    const wordings = [
      "We have partially mitigated the issue and are continuing to restore service.",
      "The issue has not been fully mitigated.",
      "Services have been restored in East US; West Europe remains impacted.",
      "We will provide a root cause analysis once mitigated.",
    ];
    for (const wording of wordings) {
      assert.notEqual(azureItemHealth(wording), "operational", wording);
      const item = { title: wording, pubDate: new Date(NOW - DAY).toUTCString() };
      assert.equal(azureItemActive(item, NOW), true, wording);
    }
  });

  it("counts an item as active when it is unresolved and dated within 14 days", () => {
    const item = (pubDate?: string, title = "App Service - Degraded performance") => ({ title, pubDate });
    assert.equal(azureItemActive(item(new Date(NOW - DAY).toUTCString()), NOW), true);
    assert.equal(azureItemActive(item(new Date(NOW - 15 * DAY).toUTCString()), NOW), false);
    assert.equal(azureItemActive(item(undefined), NOW), false);
    assert.equal(azureItemActive(item("not a date"), NOW), false);
    assert.equal(azureItemActive(item(new Date(NOW - DAY).toUTCString(), "RESOLVED - App Service"), NOW), false);
  });
});
