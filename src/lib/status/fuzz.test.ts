import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  boundId,
  boundSnapshot,
  clip,
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
} from "./bounds.ts";
import {
  appleOsReleases,
  describeVersionChanges,
  formatReleaseAge,
  formatVersionMap,
  isFreshRelease,
  isMikrotikVersion,
  latestAppleOsByFamily,
  mikrotikChangelogUrl,
  parseAppleOsTitle,
  parseMikrotikNewest,
  parseVersionMap,
  summarizeMikrotikChangelog,
} from "./changelog.ts";
import { PayloadError, unwrapJsonp } from "./http.ts";
import {
  awsEventActive,
  awsLatestLog,
  azureItemActive,
  azureItemHealth,
  decodeXmlEntities,
  decodeXmlField,
  epochToIso,
  fromStatusIo,
  grokFeedComponents,
  grokItemHealth,
  grokTitleService,
  isoTimestamp,
  MAX_NESTED_ROWS,
  MAX_RSS_ITEMS,
  MAX_SCANNED_ROWS,
  parseGoogleProducts,
  parseInstatusComponents,
  parseRssItems,
  saysResolved,
  steamCmCount,
} from "./sources.server.ts";
import type { Health, ServiceSnapshot } from "./types.ts";
import {
  parseWindowsBuild,
  parseWindowsDate,
  parseWindowsVersion,
  readHtmlTables,
  windowsReleases,
  windowsShippedAt,
} from "./windows-release.ts";

// Property-based fuzzing of the code that reads vendor input. A vendor body is
// untrusted text (up to 4 MiB) that the Worker parses on every sweep, so a
// parser must not throw on garbage, must keep its output inside the bounds it
// promises, and must take time linear in the input. fast-check generates the
// garbage; each property states what must hold for all of it.
//
// The seed is fixed, so a run is the same on every machine and a red run can
// be replayed: a failure prints the shrunk counterexample and its seed, and
// FUZZ_SEED=<seed> FUZZ_RUNS=<n> npx vitest run src/lib/status/fuzz.test.ts
// explores other inputs (a longer search before a release, say). Nothing is
// written to disk: when a search finds a bug, add the counterexample to the
// matching *.test.ts as a plain case.
const SEED = Number(process.env.FUZZ_SEED ?? 20261001);
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
// Number("abc") is NaN, which fast-check would take as a seed and pass quietly.
if (!Number.isInteger(SEED) || !Number.isInteger(RUNS) || RUNS < 1) {
  throw new Error("FUZZ_SEED and FUZZ_RUNS must be integers (FUZZ_RUNS at least 1)");
}
const run = (numRuns = RUNS): fc.Parameters<unknown> => ({ seed: SEED, numRuns });

// Any text, lone surrogates included (what JSON.parse of "\ud800" yields).
const anyText = fc.string({ unit: "binary", maxLength: 400 });
// Well-formed text with astral characters, to land emoji on a cut.
const wellFormed = fc.string({ unit: "grapheme", maxLength: 400 });
const longText = fc.string({ unit: "grapheme", minLength: 600, maxLength: 2600 });
const maybeLong = fc.oneof({ weight: 3, arbitrary: wellFormed }, { weight: 1, arbitrary: longText });

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Years past 9999 print with a sign and six digits, which Date reads back.
const ISO = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEALTHS: Health[] = ["operational", "degraded", "outage", "maintenance", "unknown"];

describe("bounds", () => {
  it("clip: at most max units, unchanged when it fits, never splits a surrogate pair", () => {
    fc.assert(
      fc.property(wellFormed, fc.integer({ min: 1, max: 600 }), (text, max) => {
        const out = clip(text, max);
        expect(out.length).toBeLessThanOrEqual(max);
        if (text.length <= max) expect(out).toBe(text);
        else expect(out.endsWith("…")).toBe(true);
        expect(LONE_SURROGATE.test(out)).toBe(false);
      }),
      run(),
    );
  });

  it("clip: is idempotent and takes any text without throwing", () => {
    fc.assert(
      fc.property(anyText, fc.integer({ min: 1, max: 600 }), (text, max) => {
        const once = clip(text, max);
        expect(once.length).toBeLessThanOrEqual(max);
        expect(clip(once, max)).toBe(once);
      }),
      run(),
    );
  });

  it("boundId: within MAX_ID_CHARS, stable, and a short id is untouched", () => {
    fc.assert(
      fc.property(wellFormed, fc.integer({ min: 0, max: 600 }), (text, extra) => {
        const id = text + "x".repeat(extra);
        const out = boundId(id);
        expect(out.length).toBeLessThanOrEqual(MAX_ID_CHARS);
        expect(boundId(id)).toBe(out);
        if (id.length <= MAX_ID_CHARS) expect(out).toBe(id);
        expect(LONE_SURROGATE.test(out)).toBe(false);
      }),
      run(),
    );
  });

  it("boundId: long ids that share a start stay different", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), fc.string({ minLength: 1, maxLength: 30 }), (a, b) => {
        fc.pre(a !== b);
        const start = "s".repeat(MAX_ID_CHARS);
        expect(boundId(start + a)).not.toBe(boundId(start + b));
      }),
      run(),
    );
  });

  const snapshot = fc.record({
    summary: maybeLong,
    components: fc.array(
      fc.record({
        name: maybeLong,
        health: fc.constantFrom(...HEALTHS),
        detail: fc.option(maybeLong, { nil: undefined }),
      }),
      { maxLength: 6 },
    ),
    incidents: fc.array(
      fc.record({
        id: maybeLong,
        title: maybeLong,
        health: fc.constantFrom(...HEALTHS),
        url: fc.option(fc.oneof(wellFormed, fc.string({ minLength: 2001, maxLength: 2100 })), { nil: undefined }),
      }),
      { maxLength: 6 },
    ),
    meta: fc.option(fc.dictionary(fc.constantFrom("latest", "versions", "other"), fc.oneof(maybeLong, fc.integer())), {
      nil: undefined,
    }),
  });

  it("boundSnapshot: every vendor string is held to its limit, whatever the snapshot holds", () => {
    fc.assert(
      fc.property(snapshot, (fields) => {
        const input = {
          id: "gcp",
          name: "n",
          shortName: "n",
          category: "cloud",
          health: "operational",
          sourceName: "s",
          sourceUrl: "https://example.com",
          checkedAt: "2026-10-01T00:00:00.000Z",
          latencyMs: 1,
          ...fields,
        } as unknown as ServiceSnapshot;
        const out = boundSnapshot(input);
        expect(out.summary.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
        for (const component of out.components) {
          expect(component.name.length).toBeLessThanOrEqual(MAX_NAME_CHARS);
          expect((component.detail ?? "").length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
        }
        for (const incident of out.incidents) {
          expect(incident.id.length).toBeLessThanOrEqual(MAX_ID_CHARS);
          expect(incident.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
          expect((incident.url ?? "").length).toBeLessThanOrEqual(2000);
        }
        for (const [key, value] of Object.entries(out.meta ?? {})) {
          if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(key === "latest" ? 300 : 500);
        }
        // Counts and order are the input's; only text changes.
        expect(out.components.map((c) => c.health)).toEqual(input.components.map((c) => c.health));
        expect(out.incidents).toHaveLength(input.incidents.length);
      }),
      run(100),
    );
  });
});

describe("changelog", () => {
  it("parseMikrotikNewest: null, or a version fit for a URL path and a real timestamp", () => {
    const body = fc.oneof(
      anyText,
      fc
        .tuple(
          fc.stringMatching(/^[0-9][\w.-]{0,40}$/),
          fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 9, maxLength: 24 }).map((digits) => digits.join("")),
        )
        .map(([version, stamp]) => `${version} ${stamp}`),
    );
    fc.assert(
      fc.property(body, (text) => {
        const parsed = parseMikrotikNewest(text);
        if (parsed === null) return;
        expect(isMikrotikVersion(parsed.version)).toBe(true);
        expect(parsed.version).not.toContain("..");
        expect(parsed.version).not.toMatch(/[/\\?#\s]/);
        expect(mikrotikChangelogUrl(parsed.version)).toBe(
          `https://download.mikrotik.com/routeros/${parsed.version}/CHANGELOG`,
        );
        if (parsed.releasedAt !== undefined) expect(parsed.releasedAt).toMatch(ISO);
      }),
      run(),
    );
  });

  it("mikrotikChangelogUrl: only a version that passes isMikrotikVersion gets a URL, and it stays on the host", () => {
    fc.assert(
      fc.property(anyText, (version) => {
        const url = mikrotikChangelogUrl(version);
        expect(url === null).toBe(!isMikrotikVersion(version));
        if (url !== null) expect(new URL(url).origin).toBe("https://download.mikrotik.com");
      }),
      run(),
    );
  });

  it("summarizeMikrotikChangelog: always a non-empty line", () => {
    const changelog = fc
      .array(fc.oneof(anyText, fc.constantFrom("What's new in 7.17:", "*) bridge - fix;", "", "  ")), { maxLength: 12 })
      .map((lines) => lines.join("\n"));
    fc.assert(
      fc.property(changelog, (text) => {
        const summary = summarizeMikrotikChangelog(text);
        expect(summary.trim()).not.toBe("");
      }),
      run(),
    );
  });

  it("parseAppleOsTitle: null, or a known family with a short one-line version", () => {
    const title = fc.oneof(
      anyText,
      fc
        .tuple(
          fc.constantFrom("iOS", "macOS", "ios", "visionOS", "Xcode"),
          fc.constantFrom(" ", "  ", "\n", ""),
          anyText,
        )
        .map(([family, gap, rest]) => `${family}${gap}${rest}`),
    );
    fc.assert(
      fc.property(title, (text) => {
        const parsed = parseAppleOsTitle(text);
        if (parsed === null) return;
        expect(["iOS", "iPadOS", "macOS", "watchOS", "tvOS", "visionOS"]).toContain(parsed.family);
        expect(parsed.version.length).toBeGreaterThan(0);
        expect(parsed.version.length).toBeLessThanOrEqual(64);
        expect(parsed.version).not.toMatch(/[\n\r\u2028\u2029]/);
        expect(typeof parsed.beta).toBe("boolean");
      }),
      run(),
    );
  });

  it("appleOsReleases and latestAppleOsByFamily: an odd date never costs the other releases", () => {
    const item = fc.record({
      title: fc.oneof(
        anyText,
        fc.constantFrom("iOS 27.2 beta 2 (24B5089g)", "macOS 27.2", "tvOS 27.1", "Xcode 27", "iPadOS 27 RC"),
      ),
      pubDate: fc.option(
        fc.oneof(
          anyText,
          fc.date({ noInvalidDate: true }).map((date) => date.toUTCString()),
          fc.constant("9".repeat(20)),
        ),
        { nil: undefined },
      ),
      link: fc.option(anyText, { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(item, { maxLength: 30 }), (items) => {
        const releases = appleOsReleases(items);
        for (const release of releases) {
          if (release.publishedAt !== undefined) expect(release.publishedAt).toMatch(ISO);
        }
        const latest = latestAppleOsByFamily(items);
        expect(latest.length).toBeLessThanOrEqual(6);
        expect(new Set(latest.map((release) => release.family)).size).toBe(latest.length);
      }),
      run(),
    );
  });

  it("version maps: format then parse gives back the entries, the last of a repeated name winning", () => {
    const name = fc.stringMatching(/^[^|=\n]{1,12}$/).filter((text) => text !== "__proto__");
    const version = fc.stringMatching(/^[^|\n]{1,12}$/);
    fc.assert(
      fc.property(fc.array(fc.record({ name, version }), { maxLength: 8 }), (entries) => {
        const parsed = parseVersionMap(formatVersionMap(entries));
        const expected: Record<string, string> = {};
        for (const entry of entries) expected[entry.name] = entry.version;
        expect(parsed).toEqual(expected);
      }),
      run(),
    );
  });

  it("version maps with any raw value parses to a plain object, and a diff names only what changed", () => {
    const raw = fc.oneof(anyText, fc.integer(), fc.constant(undefined));
    fc.assert(
      fc.property(raw, raw, (before, after) => {
        const map = parseVersionMap(before);
        expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
        expect(typeof describeVersionChanges(before, after)).toBe("string");
        expect(describeVersionChanges(before, before)).toBe("");
      }),
      run(),
    );
  });

  it("release ages with any date text, or none, reads as a string or a boolean without throwing", () => {
    fc.assert(
      fc.property(fc.option(anyText, { nil: undefined }), fc.integer({ min: 0, max: 8.64e15 }), (iso, now) => {
        expect(typeof formatReleaseAge(iso)).toBe("string");
        expect(typeof isFreshRelease(iso, now)).toBe("boolean");
      }),
      run(),
    );
  });
});

// Pieces that make HTML and XML parsers work hardest: openers with no
// closer, closers with no opener, entities, comments and nesting.
const MARKUP = [
  "<table>",
  "</table>",
  "<tr>",
  "</tr>",
  "<td>",
  "</td>",
  "<th>",
  "</th>",
  "<br>",
  "<p>",
  "<!--",
  "-->",
  "<script>",
  "</script",
  "<style>",
  "</style",
  "<item>",
  "</item>",
  "<title>",
  "</title>",
  "<description>",
  "<pubDate>",
  "<link>",
  "<![CDATA[",
  "]]>",
  "<",
  ">",
  "/",
  "&",
  "&#",
  "&#x",
  "&amp;",
  "&#x41;",
  "&#1114112;",
  "[",
  "]",
  "(",
  ")",
  " ",
  "\n",
  "\r\n",
  "Version",
  "Availability date",
  "Latest build",
  "26H2",
  "2026-09-29",
  "26300.1234",
  "iOS 27",
];
const markup = fc
  .array(
    fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(...MARKUP) },
      { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
    ),
    {
      maxLength: 300,
    },
  )
  .map((parts) => parts.join(""));

describe("windows release page", () => {
  it("readHtmlTables with any markup yields tables inside the ceilings", () => {
    fc.assert(
      fc.property(markup, (html) => {
        const tables = readHtmlTables(html);
        expect(tables.length).toBeLessThanOrEqual(40);
        for (const table of tables) {
          expect(table.length).toBeLessThanOrEqual(120);
          for (const row of table) {
            expect(row.length).toBeGreaterThan(0);
            expect(row.length).toBeLessThanOrEqual(16);
            for (const cell of row) {
              expect(cell.length).toBeLessThanOrEqual(200);
              expect(cell).not.toMatch(/<(table|tr|td|th)[\s>]/i);
            }
          }
        }
      }),
      run(),
    );
  });

  it("readHtmlTables: a well-formed table comes back cell for cell", () => {
    const cell = fc
      .stringMatching(/^[A-Za-z0-9 .-]{1,20}$/)
      .map((text) => text.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 8 }), (rows) => {
        const html = `<table>${rows.map((row) => `<tr>${row.map((text) => `<td>${text}</td>`).join("")}</tr>`).join("")}</table>`;
        expect(readHtmlTables(html)).toEqual([rows]);
      }),
      run(),
    );
  });

  it("parseWindowsVersion, parseWindowsDate and parseWindowsBuild: null or well-formed, and found in the text", () => {
    const text = fc.oneof(
      anyText,
      markup,
      fc.constantFrom("Windows 11, version 26H2 (OS build 26300.1234)", "2026-02-30"),
    );
    fc.assert(
      fc.property(text, (cell) => {
        const version = parseWindowsVersion(cell);
        if (version !== null) {
          expect(version).toMatch(/^\d{2}H[12]$/);
          expect(cell).toContain(version);
        }
        const date = parseWindowsDate(cell);
        if (date !== undefined) {
          expect(date).toMatch(ISO);
          expect(cell).toContain(date.slice(0, 10));
          expect(date.endsWith("T00:00:00.000Z")).toBe(true);
        }
        const build = parseWindowsBuild(cell);
        if (build !== undefined) {
          expect(build).toMatch(/^\d{5}\.\d{1,6}$/);
          expect(cell).toContain(build);
        }
      }),
      run(),
    );
  });

  it("windowsReleases with any tables give at most four versions, newest first", () => {
    const cell = fc.oneof(
      anyText,
      fc.constantFrom(
        "Version",
        "Availability date",
        "Latest revision date",
        "Latest build",
        "26H2",
        "2026-09-29",
        "26300.1234",
      ),
    );
    const tables = fc.array(fc.array(fc.array(cell, { maxLength: 6 }), { maxLength: 10 }), { maxLength: 4 });
    fc.assert(
      fc.property(tables, (input) => {
        const releases = windowsReleases(input);
        expect(releases.length).toBeLessThanOrEqual(4);
        expect(new Set(releases.map((release) => release.version)).size).toBe(releases.length);
        for (const [index, release] of releases.entries()) {
          expect(release.version).toMatch(/^\d{2}H[12]$/);
          expect(release.availableAt).toMatch(ISO);
          expect(windowsShippedAt(release) >= release.availableAt).toBe(true);
          const next = releases[index + 1];
          if (next) expect(release.availableAt >= next.availableAt).toBe(true);
        }
      }),
      run(),
    );
  });

  it("windowsReleases: a version table gives its four newest versions, as a sort by date would", () => {
    const day = fc
      .integer({ min: Date.UTC(2021, 0, 1), max: Date.UTC(2035, 11, 31) })
      .map((ms) => new Date(ms).toISOString().slice(0, 10));
    const versions = fc.uniqueArray(
      fc.tuple(fc.integer({ min: 21, max: 39 }), fc.constantFrom("H1", "H2")).map(([year, half]) => `${year}${half}`),
      { minLength: 1, maxLength: 9 },
    );
    fc.assert(
      fc.property(
        versions.chain((list) =>
          fc.tuple(fc.constant(list), fc.array(day, { minLength: list.length, maxLength: list.length })),
        ),
        ([list, dates]) => {
          const rows = list.map((version, index) => [version, dates[index], dates[index], "26300.1"]);
          const table = [["Version", "Availability date", "Latest revision date", "Latest build"], ...rows];
          const expected = list
            .map((version, index) => ({ version, availableAt: `${dates[index]}T00:00:00.000Z` }))
            .sort((a, b) =>
              a.availableAt === b.availableAt
                ? a.version < b.version
                  ? 1
                  : -1
                : a.availableAt < b.availableAt
                  ? 1
                  : -1,
            )
            .slice(0, 4);
          expect(windowsReleases([table]).map(({ version, availableAt }) => ({ version, availableAt }))).toEqual(
            expected,
          );
        },
      ),
      run(),
    );
  });
});

describe("feeds and payloads", () => {
  it("parseRssItems with any markup gives at most MAX_RSS_ITEMS items, all text", () => {
    fc.assert(
      fc.property(markup, (xml) => {
        const items = parseRssItems(xml);
        expect(items.length).toBeLessThanOrEqual(MAX_RSS_ITEMS);
        for (const item of items) {
          expect(typeof item.title).toBe("string");
          expect(typeof item.description).toBe("string");
          expect(item.title).toBe(item.title.trim());
        }
      }),
      run(),
    );
  });

  it("parseRssItems: a well-formed feed comes back item for item, in order", () => {
    const text = fc
      .stringMatching(/^[A-Za-z0-9 ]{1,20}$/)
      .map((value) => value.trim())
      .filter(Boolean);
    fc.assert(
      fc.property(fc.array(fc.record({ title: text, description: text }), { maxLength: 20 }), (entries) => {
        const xml = entries
          .map((entry) => `<item><title>${entry.title}</title><description>${entry.description}</description></item>`)
          .join("");
        expect(parseRssItems(xml).map(({ title, description }) => ({ title, description }))).toEqual(entries);
      }),
      run(),
    );
  });

  it("decodeXmlEntities: text without '&' is untouched, and well-formed text stays well-formed", () => {
    fc.assert(
      fc.property(wellFormed, (text) => {
        const decoded = decodeXmlEntities(text);
        if (!text.includes("&")) expect(decoded).toBe(text);
        expect(LONE_SURROGATE.test(decoded)).toBe(false);
      }),
      run(),
    );
    fc.assert(
      fc.property(markup, (text) => {
        expect(LONE_SURROGATE.test(decodeXmlEntities(text))).toBe(false);
      }),
      run(),
    );
  });

  it("decodeXmlField: CDATA content is literal, never decoded", () => {
    fc.assert(
      fc.property(
        wellFormed.filter((text) => !text.includes("]]>")),
        (text) => {
          expect(decodeXmlField(`<![CDATA[${text}]]>`)).toBe(text);
        },
      ),
      run(),
    );
    fc.assert(
      fc.property(markup, (raw) => {
        expect(typeof decodeXmlField(raw)).toBe("string");
      }),
      run(),
    );
  });

  it("unwrapJsonp: returns the input or a slice of it", () => {
    fc.assert(
      fc.property(fc.oneof(anyText, markup), (body) => {
        const out = unwrapJsonp(body);
        expect(out === body || body.includes(out)).toBe(true);
      }),
      run(),
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z_$][\w$]{0,10}$/), wellFormed.filter(Boolean), (callback, json) => {
        expect(unwrapJsonp(`${callback}(${json})`)).toBe(json);
      }),
      run(),
    );
  });

  it("grok feed with any title and description read as a service and a health", () => {
    const item = fc.record({
      title: fc.oneof(anyText, fc.constantFrom("[Grok (iOS)] Models outage", "[API] x"), markup),
      description: fc.oneof(anyText, markup),
      pubDate: fc.option(anyText, { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(item, { maxLength: 12 }), (items) => {
        for (const entry of items) {
          const service = grokTitleService(entry.title);
          if (service) {
            expect(service.name).not.toBe("");
            expect(service.detail).not.toBe("");
          }
          expect(HEALTHS).toContain(grokItemHealth(entry.description));
        }
        const rows = grokFeedComponents(items);
        expect(new Set(rows.map((row) => row.name.toLowerCase())).size).toBe(rows.length);
        for (const row of rows) expect(HEALTHS).toContain(row.health);
      }),
      run(),
    );
  });

  it("azureItemHealth: one of the five healths for any title, over only when it begins with a resolution", () => {
    const title = fc.oneof(
      anyText,
      markup,
      fc.constantFrom("RESOLVED - x", "Post Incident Review (PIR) - y", "Service unavailable", "Planned maintenance"),
    );
    fc.assert(
      fc.property(title, fc.option(anyText, { nil: undefined }), (text, pubDate) => {
        expect(HEALTHS).toContain(azureItemHealth(text));
        if (azureItemHealth(text) === "operational") {
          expect(/^[\s[(]*(?:resolved|mitigated|post[ -]incident review|pir)/i.test(text)).toBe(true);
        }
        expect(typeof azureItemActive({ title: text, pubDate }, Date.now())).toBe("boolean");
      }),
      run(),
    );
  });

  it("fromStatusIo with any JSON is a snapshot inside the board's states, or a thrown parser failure", () => {
    const code = fc.oneof(fc.constantFrom(100, 200, 300, 400, 500, 600), fc.jsonValue());
    const event = fc.oneof(
      fc.jsonValue(),
      fc.record({
        _id: fc.oneof(anyText, fc.jsonValue()),
        name: fc.oneof(anyText, fc.jsonValue()),
        datetime_open: fc.oneof(anyText, fc.jsonValue()),
        messages: fc.array(fc.record({ status: code, datetime: fc.oneof(anyText, fc.jsonValue()) }), { maxLength: 4 }),
      }),
    );
    const component = fc.oneof(
      fc.jsonValue(),
      fc.record({
        name: fc.oneof(anyText, fc.jsonValue()),
        status: fc.oneof(anyText, fc.jsonValue()),
        status_code: code,
        containers: fc.oneof(
          fc.jsonValue(),
          fc.array(fc.record({ name: anyText, status_code: code }), { maxLength: 4 }),
        ),
      }),
    );
    const payload = fc.oneof(
      fc.jsonValue(),
      fc.record({
        result: fc.record({
          status_overall: fc.record({ status: anyText, status_code: code }),
          status: fc.oneof(fc.jsonValue(), fc.array(component, { maxLength: 6 })),
          incidents: fc.oneof(fc.jsonValue(), fc.array(event, { maxLength: 4 })),
          maintenance: fc.oneof(
            fc.jsonValue(),
            fc.record({ active: fc.array(event, { maxLength: 3 }), upcoming: fc.array(event, { maxLength: 3 }) }),
          ),
        }),
      }),
    );
    fc.assert(
      fc.property(payload, (value) => {
        try {
          const snapshot = fromStatusIo("gitlab", value as never, 1, "pg");
          expect(HEALTHS).toContain(snapshot.health);
          expect(snapshot.health).not.toBe("unknown");
          for (const row of snapshot.components) {
            expect(HEALTHS).toContain(row.health);
            expect(typeof row.name).toBe("string");
          }
          for (const incident of snapshot.incidents) {
            expect(typeof incident.id).toBe("string");
            expect(typeof incident.title).toBe("string");
            if (incident.url !== undefined) expect(new URL(incident.url).host).toBe("status.gitlab.com");
          }
        } catch (error) {
          expect(error).toBeInstanceOf(PayloadError);
        }
      }),
      run(),
    );
  });

  it("fromStatusIo with arrays of any length past the bound reads at most MAX_SCANNED_ROWS of each", () => {
    const row = fc.oneof(
      fc.constant({}),
      fc.record({ name: anyText, status_code: fc.constantFrom(100, 300, 500) }),
      fc.constant(null),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_SCANNED_ROWS * 3 }),
        fc.integer({ min: 0, max: MAX_SCANNED_ROWS * 3 }),
        fc.integer({ min: 0, max: MAX_SCANNED_ROWS * 3 }),
        fc.integer({ min: 0, max: MAX_NESTED_ROWS * 3 }),
        row,
        (components, incidents, maintenance, nested, entry) => {
          const many = (n: number, item: unknown = entry) => new Array(n).fill(item);
          const withFirst = (rows: unknown[], first: unknown) => (rows.length > 0 ? [first, ...rows.slice(1)] : rows);
          const snapshot = fromStatusIo(
            "gitlab",
            {
              result: {
                status_overall: { status: "Operational", status_code: 100 },
                // Nested arrays on one row each: the cost stays linear in the row counts.
                status: withFirst(many(components), { name: "c", status_code: 100, containers: many(nested) }),
                incidents: withFirst(many(incidents), { name: "i", messages: many(nested) }),
                maintenance: { active: many(maintenance), upcoming: many(maintenance) },
              },
            } as never,
            1,
            "pg",
          );
          expect(snapshot.components.length).toBeLessThanOrEqual(300);
          expect(snapshot.componentCount ?? 0).toBeLessThanOrEqual(MAX_SCANNED_ROWS);
          expect(snapshot.incidents.length).toBeLessThanOrEqual(50);
          expect(snapshot.incidentCount ?? 0).toBeLessThanOrEqual(MAX_SCANNED_ROWS);
          expect(snapshot.upcomingMaintenance?.length ?? 0).toBeLessThanOrEqual(3);
        },
      ),
      run(50),
    );
  });

  it("saysResolved: a boolean for any text, and never true for text without the word", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        expect(typeof saysResolved(text)).toBe("boolean");
        if (!/resolved/i.test(text)) expect(saysResolved(text)).toBe(false);
      }),
      run(),
    );
  });

  it("parseGoogleProducts with any JSON gives distinct, trimmed, non-empty titles", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.jsonValue(), fc.array(fc.jsonValue()), fc.record({ products: fc.array(fc.jsonValue()) })),
        (payload) => {
          const products = parseGoogleProducts(payload);
          expect(new Set(products.map((product) => product.title.toLowerCase())).size).toBe(products.length);
          for (const product of products) {
            expect(product.title).not.toBe("");
            expect(product.title).toBe(product.title.trim());
          }
        },
      ),
      run(),
    );
  });

  it("parseInstatusComponents with any JSON gives named components with a known health", () => {
    const row = fc.oneof(
      fc.jsonValue(),
      fc.record({
        name: anyText,
        status: fc.constantFrom("OPERATIONAL", "MAJOROUTAGE", "PARTIALOUTAGE", "x"),
        description: anyText,
      }),
    );
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.record({ components: fc.array(row, { maxLength: 8 }) })), (payload) => {
        for (const component of parseInstatusComponents(payload)) {
          expect(component.name).not.toBe("");
          expect(component.name).toBe(component.name.trim());
          expect(HEALTHS).toContain(component.health);
        }
      }),
      run(),
    );
  });

  it("steamCmCount: a count never above the rows listed", () => {
    const rows = fc.array(fc.oneof(fc.jsonValue(), fc.record({ endpoint: anyText })), { maxLength: 10 });
    fc.assert(
      fc.property(
        fc.oneof(fc.jsonValue(), fc.record({ response: fc.record({ success: fc.boolean(), serverlist: rows }) })),
        (payload) => {
          const count = steamCmCount(payload);
          expect(Number.isInteger(count)).toBe(true);
          expect(count).toBeGreaterThanOrEqual(0);
          const listed = (payload as { response?: { serverlist?: unknown[] } } | null)?.response?.serverlist;
          expect(count).toBeLessThanOrEqual(Array.isArray(listed) ? listed.length : 0);
        },
      ),
      run(),
    );
  });

  it("epochToIso and isoTimestamp: undefined, or an ISO string that reads back as the same instant", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.jsonValue(), fc.double(), fc.integer(), anyText),
        fc.constantFrom(1, 1000),
        (value, unitMs) => {
          for (const out of [epochToIso(value, unitMs), isoTimestamp(value)]) {
            if (out === undefined) continue;
            expect(out).toMatch(ISO);
            expect(new Date(out).toISOString()).toBe(out);
          }
        },
      ),
      run(),
    );
  });

  it("isoTimestamp: a loose 'YYYY-MM-DD HH:MM' is read as UTC", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01"), max: new Date("2099-12-31"), noInvalidDate: true }),
        (date) => {
          const iso = date.toISOString();
          expect(isoTimestamp(`${iso.slice(0, 10)} ${iso.slice(11, 16)}`)).toBe(`${iso.slice(0, 16)}:00.000Z`);
        },
      ),
      run(),
    );
  });

  it("AWS events: the newest log entry wins, and any event reads as active or not", () => {
    const entry = fc.record(
      {
        summary: fc.string({ maxLength: 30 }),
        message: fc.string({ maxLength: 30 }),
        status: fc.integer({ min: 0, max: 3 }),
        timestamp: fc.integer({ min: 0, max: 2_000_000_000 }),
      },
      { requiredKeys: [] },
    );
    const event = fc.record(
      {
        date: fc.integer({ min: 0, max: 2_000_000_000 }).map(String),
        status: fc.oneof(fc.integer({ min: 0, max: 3 }).map(String), fc.string({ maxLength: 4 })),
        summary: fc.oneof(
          fc.string({ maxLength: 40 }),
          fc.constantFrom("[RESOLVED] a", "Service impact", "maintenance"),
        ),
        region_name: fc.string({ maxLength: 10 }),
        end_time: fc.option(fc.oneof(fc.integer({ min: 1 }), fc.string({ minLength: 1, maxLength: 4 })), { nil: null }),
        event_log: fc.array(entry, { maxLength: 6 }),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(event, fc.integer({ min: 0, max: 4_000_000_000_000 }), (input, now) => {
        const latest = awsLatestLog(input);
        const log = input.event_log ?? [];
        if (log.length === 0) expect(latest).toBeUndefined();
        else {
          expect(log).toContain(latest);
          const stamps = log
            .map((item) => item.timestamp)
            .filter((stamp): stamp is number => typeof stamp === "number");
          if (stamps.length > 0 && latest?.timestamp !== undefined) expect(latest.timestamp).toBe(Math.max(...stamps));
        }
        expect(typeof awsEventActive(input, now)).toBe("boolean");
      }),
      run(),
    );
  });
});

// A parser that is quadratic on crafted input is a denial of service on the
// Worker, and the case that finds it is rarely one anybody would write by
// hand. Each run repeats a few fuzz-chosen fragments up to a size at which a
// quadratic scan takes tens of seconds and a linear one a few milliseconds,
// so the generous budget cannot fail a correct parser on a slow runner.
describe("parsers stay linear", () => {
  const SIZE = 120_000;
  const BUDGET_MS = 1500;
  const crafted = fc
    .array(fc.oneof(fc.constantFrom(...MARKUP), fc.string({ maxLength: 4 })), { minLength: 1, maxLength: 4 })
    .map((parts) => {
      const unit = parts.join("") || "<";
      return unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
    });
  const parsers: Array<[string, (input: string) => unknown]> = [
    ["readHtmlTables", readHtmlTables],
    ["parseRssItems", parseRssItems],
    ["decodeXmlField", decodeXmlField],
    ["decodeXmlEntities", decodeXmlEntities],
    ["unwrapJsonp", unwrapJsonp],
    ["parseAppleOsTitle", parseAppleOsTitle],
    ["parseMikrotikNewest", parseMikrotikNewest],
    ["summarizeMikrotikChangelog", summarizeMikrotikChangelog],
    ["grokTitleService", grokTitleService],
    ["grokItemHealth", grokItemHealth],
    ["azureItemHealth", azureItemHealth],
    ["saysResolved", saysResolved],
    ["parseWindowsVersion", parseWindowsVersion],
    ["parseWindowsDate", parseWindowsDate],
    ["parseWindowsBuild", parseWindowsBuild],
    ["parseVersionMap", parseVersionMap],
    ["clip", (input: string) => clip(input, 300)],
    ["boundId", boundId],
  ];

  it.each(parsers)("%s: crafted input is read in linear time", (_name, parse) => {
    fc.assert(
      fc.property(crafted, (input) => {
        const started = performance.now();
        parse(input);
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      }),
      run(12),
    );
  });
});
