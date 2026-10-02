import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { service } from "../../test/fixtures.ts";
import { stubFetch, text } from "../../test/stub-fetch.ts";
import { MAX_FEED_ENTRIES, MAX_NOTE_CHARS, MAX_NOTE_LINES } from "./bounds.ts";
import { collectBoard } from "./collect-board.ts";
import { MAX_BODY_BYTES, PayloadError } from "./http.ts";
import {
  clearReleaseFeedCache,
  gitlabVersion,
  htmlBlocks,
  jsonEntries,
  parseFeedItems,
  probeReleaseFeeds,
  RELEASE_FEED_RETRY_MS,
  RELEASE_FEED_TTL_MS,
  RELEASE_SOURCES,
  readReleaseFeed,
  releaseFeedsForBoard,
  steamNoteLines,
  withReleaseFeeds,
} from "./release-feeds.server.ts";
import { MAX_RSS_SCANNED } from "./sources.server.ts";
import type { ReleaseFeed, ServiceId } from "./types.ts";

// The vendors' release feeds, read against hand-built fixtures in the formats
// the vendors document (none was recorded: see __fixtures__/README.md). The
// feeds are advisory, so most of what is pinned here is what they must NOT do.

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (path: string) => readFileSync(new URL(path, FIXTURES), "utf8");

const source = (id: ServiceId) => {
  const found = RELEASE_SOURCES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no release source for ${id}`);
  return found;
};
const entriesOf = (id: ServiceId, body: string) => source(id).read(source(id), body);

const URLS = Object.fromEntries(RELEASE_SOURCES.map((candidate) => [candidate.id, candidate.url])) as Record<
  ServiceId,
  string
>;

const FEED_FIXTURES: Partial<Record<ServiceId, string>> = {
  aws: "aws/whats-new.xml",
  gcp: "gcp/release-notes.xml",
  azure: "azure/updates.xml",
  github: "github/changelog.xml",
  gitlab: "gitlab/releases.xml",
  "cs2-europe": "steam/cs2-news.json",
};

/** Every feed answers with its fixture. */
function allFeedsUp(): Record<string, ReturnType<typeof text>> {
  return Object.fromEntries(
    RELEASE_SOURCES.map((candidate) => [candidate.url, text(fixture(FEED_FIXTURES[candidate.id] as string))]),
  );
}

describe("the release sources", () => {
  it("are the official feeds, one per service, all https and each with a page of the vendor's own", () => {
    expect(RELEASE_SOURCES.map((candidate) => candidate.id)).toEqual([
      "aws",
      "gcp",
      "azure",
      "github",
      "gitlab",
      "cs2-europe",
    ]);
    expect(URLS).toMatchObject({
      aws: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
      gcp: "https://cloud.google.com/feeds/gcp-release-notes.xml",
      azure: "https://www.microsoft.com/releasecommunications/api/v2/azure/rss",
      github: "https://github.blog/changelog/feed/",
      gitlab: "https://about.gitlab.com/releases.xml",
      "cs2-europe":
        "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=300&feeds=steam_community_announcements",
    });
    for (const candidate of RELEASE_SOURCES) {
      expect(new URL(candidate.url).protocol).toBe("https:");
      expect(new URL(candidate.pageUrl).protocol).toBe("https:");
      expect(candidate.hosts.some((host) => new URL(candidate.pageUrl).hostname.endsWith(host))).toBe(true);
    }
  });

  it("do not include the releases trackers or a vendor with no official feed", () => {
    const ids = RELEASE_SOURCES.map((candidate) => candidate.id);
    for (const id of [
      "mikrotik",
      "apple-os",
      "windows",
      "android-os",
      "confluence",
      "claude",
      "chatgpt",
      "grok",
      "steam",
    ]) {
      expect(ids).not.toContain(id);
    }
  });
});

describe("each feed's fixture", () => {
  it("AWS: the newest What's New posts, newest first, capped, with plain notes and the post's own link", () => {
    const entries = entriesOf("aws", fixture("aws/whats-new.xml"));
    expect(entries).toHaveLength(MAX_FEED_ENTRIES);
    expect(entries.map((entry) => entry.release.releasedAt)).toEqual([
      "2026-10-01T16:00:00.000Z",
      "2026-09-30T18:30:00.000Z",
      "2026-09-29T15:10:00.000Z",
      "2026-09-28T12:00:00.000Z",
      "2026-09-25T09:45:00.000Z",
    ]);
    expect(entries[0]).toEqual({
      title: "Amazon EC2 R9i instances are now generally available in additional regions",
      release: {
        version: "",
        releasedAt: "2026-10-01T16:00:00.000Z",
        url: "https://aws.amazon.com/about-aws/whats-new/2026/10/amazon-ec2-r9i-additional-regions/",
        linkLabel: "What's New post",
        notes: [
          "Starting today, Amazon EC2 R9i instances are available in the Europe (Stockholm) and Asia Pacific (Seoul) Regions.",
          "R9i instances deliver up to 20% better price performance than R8i.",
        ],
      },
    });
    // An entity in a title is text once, and list items are notes.
    expect(entries[1]?.title).toBe("AWS Lambda adds support for Node.js 26 & Python 3.15");
    expect(entries[2]?.release.notes).toEqual([
      "You can now replicate S3 Tables across AWS Regions and accounts.",
      "Replicas stay in sync within minutes",
      "Works with Apache Iceberg catalogs",
    ]);
  });

  it("Google Cloud: an Atom feed whose entries are days, named by the products they hold", () => {
    const entries = entriesOf("gcp", fixture("gcp/release-notes.xml"));
    expect(entries.map((entry) => entry.title)).toEqual([
      "Cloud Run, BigQuery and 2 more",
      "Compute Engine and Cloud Build",
      "Vertex AI",
      "Cloud Functions",
    ]);
    // 00:00 at UTC-7 is 07:00 UTC; the entry's alternate link is its anchor on the release notes page.
    expect(entries[0]?.release).toMatchObject({
      releasedAt: "2026-10-01T07:00:00.000Z",
      url: "https://cloud.google.com/release-notes#October_01_2026",
      linkLabel: "Release notes",
    });
    expect(entries[0]?.release.notes).toEqual([
      "Cloud Run now supports GPU-backed worker pools in europe-west1.",
      "BigQuery now supports vector search over partitioned tables.",
      "Cloud Storage: Soft delete is now on by default for new buckets.",
      "Cloud SQL for PostgreSQL adds minor version 17.7.",
    ]);
  });

  it("Azure: escaped HTML descriptions read as notes, and azure.microsoft.com links are the vendor's own", () => {
    const entries = entriesOf("azure", fixture("azure/updates.xml"));
    expect(entries.map((entry) => entry.title)).toEqual([
      "[Launched] Generally available: Azure Kubernetes Service Automatic in more regions",
      "[In preview] Public preview: Azure Functions Flex Consumption supports Python 3.14",
      "[Retirement] Retirement notice: Azure Cache for Redis Basic tier on 30 September 2027",
      "[Launched] Generally available: Azure SQL Database hyperscale elastic pools",
    ]);
    expect(entries[0]?.release.notes).toEqual([
      "AKS Automatic is now generally available in 12 additional Azure regions.",
      "It sets up node pools, scaling and networking for you.",
    ]);
    expect(entries[0]?.release.url).toBe("https://azure.microsoft.com/updates?id=551201");
    expect(entries[0]?.release.releasedAt).toBe("2026-10-01T15:00:00.000Z");
  });

  it("GitHub: the changelog's newest posts, without WordPress's 'The post ... appeared first on' line", () => {
    const entries = entriesOf("github", fixture("github/changelog.xml"));
    expect(entries[0]).toMatchObject({
      title: "Copilot code review is now generally available for all plans",
      release: {
        url: "https://github.blog/changelog/2026-10-01-copilot-code-review-is-now-generally-available-for-all-plans/",
        notes: ["Copilot code review is now generally available for every GitHub plan."],
      },
    });
    for (const entry of entries) {
      expect(entry.release.notes?.join(" ") ?? "").not.toMatch(/appeared first on/i);
    }
  });

  it("GitLab: the version of a release or the newest of a patch release, then the post's own title as a note", () => {
    const entries = entriesOf("gitlab", fixture("gitlab/releases.xml"));
    expect(entries.map((entry) => [entry.title, entry.release.version])).toEqual([
      ["GitLab 18.4.1", "18.4.1"],
      ["GitLab 18.4", "18.4"],
      ["GitLab 18.3.2", "18.3.2"],
      ["GitLab 18.3.1", "18.3.1"],
    ]);
    expect(entries[0]?.release).toMatchObject({
      releasedAt: "2026-09-24T00:00:00.000Z",
      url: "https://about.gitlab.com/releases/2026/09/24/patch-release-gitlab-18-4-1-released/",
      linkLabel: "Release post",
    });
    expect(entries[0]?.release.notes?.[0]).toBe("GitLab Patch Release: 18.4.1, 18.3.3, 18.2.7");
    expect(entries[1]?.release.notes?.[0]).toBe(
      "GitLab 18.4 released with Duo Agent Platform improvements and a faster merge train",
    );
  });

  it("CS2: the update posts only, newest first, with BBCode and picture placeholders gone and a link built from the id", () => {
    const entries = entriesOf("cs2-europe", fixture("steam/cs2-news.json"));
    expect(entries.map((entry) => [entry.title, entry.release.releasedAt])).toEqual([
      ["Counter-Strike 2 Update", "2026-10-01T17:00:00.000Z"],
      ["Counter-Strike 2 Update", "2026-09-27T17:20:00.000Z"],
      ["Release Notes for 9/22/2026", "2026-09-22T12:40:00.000Z"],
    ]);
    expect(entries[0]?.release).toMatchObject({
      url: "https://store.steampowered.com/news/app/730/view/5123456789012345678",
      linkLabel: "Steam announcement",
      notes: [
        "Added the new Anubis match map to the Premier map pool.",
        "Fixed a crash when spectating a bot.",
        "Updated the radar for Overpass.",
      ],
    });
    expect(entries[1]?.release.notes).toEqual(["Gameplay", "Adjusted the recoil of the AK-47."]);
  });

  it("CS2: with no update posts at all, the newest posts stand in", () => {
    const body = JSON.stringify({
      appnews: { newsitems: [{ gid: "1", title: "A community event", date: 1790874000, contents: "Join us." }] },
    });
    expect(entriesOf("cs2-europe", body).map((entry) => entry.title)).toEqual(["A community event"]);
  });
});

describe("a feed that is not usable", () => {
  it.each([
    ["an RSS channel with no items", "aws", "releases/empty.xml", "had no readable entries"],
    ["an Atom feed with no entries", "gcp", "releases/atom-empty.xml", "had no readable entries"],
    ["an HTML page", "aws", "releases/not-a-feed.html", "was not an RSS or Atom feed"],
    ["an HTML page where Atom is expected", "gitlab", "releases/not-a-feed.html", "was not an RSS or Atom feed"],
    ["an empty body", "github", "releases/empty.xml", "had no readable entries"],
  ] as const)("%s is a parser failure", (_name, id, path, message) => {
    expect(() => entriesOf(id, fixture(path))).toThrow(PayloadError);
    expect(() => entriesOf(id, fixture(path))).toThrow(message);
  });

  it.each([
    ["a rate-limit notice", "releases/steam-malformed.json"],
    ["a feed with no posts", "releases/steam-empty.json"],
    ["text that is not JSON", "releases/not-a-feed.html"],
    ["an empty body", "releases/steam-empty.json"],
  ])("CS2: %s is a parser failure", (_name, path) => {
    expect(() => jsonEntries(source("cs2-europe"), fixture(path))).toThrow(PayloadError);
  });

  it("CS2: an array of nothing, null and junk reads as no entries, not an error of another kind", () => {
    for (const payload of [[], null, "x", 3, { appnews: null }, { appnews: { newsitems: [null, 1, "x", {}] } }]) {
      expect(() => jsonEntries(source("cs2-europe"), JSON.stringify(payload))).toThrow(PayloadError);
    }
  });

  it("an item without a title is skipped, not a failure of the others", () => {
    const xml = `<rss><channel><item><link>https://aws.amazon.com/a</link><pubDate>Thu, 01 Oct 2026 16:00:00 +0000</pubDate></item>
      <item><title>Kept</title><pubDate>Wed, 30 Sep 2026 16:00:00 +0000</pubDate></item></channel></rss>`;
    expect(entriesOf("aws", xml).map((entry) => entry.title)).toEqual(["Kept"]);
  });
});

describe("text from a vendor feed", () => {
  it("is plain text: markup and escaped markup in titles and notes are gone, entities are decoded once", () => {
    const entries = entriesOf("aws", fixture("releases/html-titles.xml"));
    expect(entries.map((entry) => entry.title)).toEqual([
      "Bold and italic title",
      "Escaped markup &amp; ampersand",
      "Spaces and newlines in a title",
    ]);
    for (const entry of entries) {
      expect(entry.title).not.toMatch(/[<>]/);
      for (const note of entry.release.notes ?? []) expect(note).not.toMatch(/<\/?[a-z]/i);
    }
    expect(entries[0]?.release.notes).toEqual([
      "First paragraph with strong text & an entity.",
      "Second paragraph.",
      "After a break.",
    ]);
    expect(entries[1]?.release.notes).toEqual(["Escaped paragraph one.", "Escaped paragraph two."]);
    expect(entries[2]?.release.notes).toEqual(["Plain text, no markup at all."]);
  });

  it("an item whose title is only markup is dropped", () => {
    const titles = entriesOf("aws", fixture("releases/html-titles.xml")).map((entry) => entry.title);
    expect(titles).toHaveLength(3);
  });

  it("keeps at most five notes of at most 200 characters, from at most the first part of a long entry", () => {
    const entries = entriesOf("aws", fixture("releases/dense.xml"));
    expect(entries).toHaveLength(MAX_FEED_ENTRIES);
    for (const entry of entries) {
      expect(entry.release.notes?.length).toBeLessThanOrEqual(MAX_NOTE_LINES);
      for (const note of entry.release.notes ?? []) expect(note.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    }
  });
});

describe("links from a vendor feed", () => {
  // The fixture holds more links than a card keeps, so each item is read as a feed of its own.
  const urlsOf = (path: string) =>
    Object.fromEntries(
      fixture(path)
        .split("<item>")
        .slice(1)
        .map((item) => {
          const [entry] = entriesOf("aws", `<rss><channel><item>${item.split("</item>")[0]}</item></channel></rss>`);
          return [entry?.title, entry?.release.url];
        }),
    );

  it("only https links on the vendor's hosts survive; every other link is the feed's page", () => {
    const page = source("aws").pageUrl;
    const urls = urlsOf("releases/unsafe-links.xml");
    for (const title of [
      "Plain http link",
      "A script link",
      "Another host",
      "A look-alike host",
      "Credentials in the link",
      "No link at all",
    ]) {
      expect(urls[title]).toBe(page);
    }
    expect(urls["A good link"]).toBe("https://aws.amazon.com/about-aws/whats-new/2026/09/good/");
  });

  it("a relative link resolves against the feed's page and stays on the vendor's host", () => {
    expect(urlsOf("releases/unsafe-links.xml")["A relative link"]).toBe(
      "https://aws.amazon.com/about-aws/whats-new/2026/09/relative/",
    );
    expect(parseFeedItems(fixture("releases/unsafe-links.xml"), "item").length).toBeGreaterThan(MAX_FEED_ENTRIES);
  });

  it("an Atom entry's link is its alternate; self, edit and enclosure links are not the entry's page", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><updated>2026-10-01T00:00:00Z</updated>
      <link rel="self" href="https://about.gitlab.com/self"/><link rel="enclosure" href="https://about.gitlab.com/file.zip"/>
      <link rel='alternate' href='https://about.gitlab.com/releases/a/'/></entry>
      <entry><title>B</title><updated>2026-09-30T00:00:00Z</updated><link href="https://about.gitlab.com/releases/b/"/></entry>
      <entry><title>C</title><updated>2026-09-29T00:00:00Z</updated><link rel="self" href="https://about.gitlab.com/self"/></entry></feed>`;
    expect(entriesOf("gitlab", xml).map((entry) => entry.release.url)).toEqual([
      "https://about.gitlab.com/releases/a/",
      "https://about.gitlab.com/releases/b/",
      "https://about.gitlab.com/releases/",
    ]);
  });

  it("CS2: a link is built only from a numeric post id, whatever the payload's url says", () => {
    const body = JSON.stringify({
      appnews: {
        newsitems: [
          { gid: "123", title: "Update", url: "https://evil.example/x", date: 1790874000 },
          { gid: "12x", title: "Update two", url: "https://store.steampowered.com/a", date: 1790787600 },
          { gid: "../../etc", title: "Update three", date: 1790701200 },
          { title: "Update four", date: 1790614800 },
        ],
      },
    });
    expect(entriesOf("cs2-europe", body).map((entry) => entry.release.url)).toEqual([
      "https://store.steampowered.com/news/app/730/view/123",
      "https://store.steampowered.com/news/app/730",
      "https://store.steampowered.com/news/app/730",
      "https://store.steampowered.com/news/app/730",
    ]);
  });
});

describe("dates from a vendor feed", () => {
  it("an entry with no readable date is kept, has no day, and ranks after the dated ones in feed order", () => {
    const entries = entriesOf("aws", fixture("releases/no-dates.xml"));
    expect(entries.map((entry) => entry.title)).toEqual(["No date element", "A date nobody can read", "An empty date"]);
    for (const entry of entries) expect(entry.release).not.toHaveProperty("releasedAt");
    const mixed = entriesOf(
      "aws",
      `<rss><channel><item><title>Undated</title></item><item><title>Dated</title><pubDate>Thu, 01 Oct 2026 16:00:00 +0000</pubDate></item></channel></rss>`,
    );
    expect(mixed.map((entry) => entry.title)).toEqual(["Dated", "Undated"]);
  });

  it("newest wins wherever it sits in the feed: a feed written oldest first still leads with the newest", () => {
    const entries = entriesOf("aws", fixture("releases/dense.xml"));
    expect(entries[0]?.title).toBe("Dense entry 39: a feature that changes how everything works");
    const times = entries.map((entry) => Date.parse(entry.release.releasedAt ?? ""));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("a huge feed is read in bounded work, and an entry past the scan bound is never looked at", () => {
    const item = (n: number, day: string) =>
      `<item><title>Entry ${n}</title><pubDate>${day}</pubDate><description>x</description></item>`;
    const early = Array.from({ length: MAX_RSS_SCANNED }, (_, n) => item(n, "Mon, 01 Jun 2026 00:00:00 +0000"));
    const xml = `<rss><channel>${early.join("")}${item(MAX_RSS_SCANNED + 1, "Thu, 01 Oct 2026 00:00:00 +0000")}</channel></rss>`;
    const started = performance.now();
    const entries = entriesOf("aws", xml);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(entries).toHaveLength(MAX_FEED_ENTRIES);
    expect(entries.map((entry) => entry.title)).not.toContain(`Entry ${MAX_RSS_SCANNED + 1}`);
  });
});

describe("gitlabVersion", () => {
  it.each([
    ["GitLab 18.4 released with Duo improvements", "18.4"],
    ["GitLab 18.4.1 released", "18.4.1"],
    ["gitlab 19.0 RELEASED", "19.0"],
    ["GitLab Patch Release: 18.4.1, 18.3.3, 18.2.7", "18.4.1"],
    ["GitLab Patch Releases: 18.9.5, 18.10.1, 18.8.9", "18.10.1"],
    ["GitLab Critical Patch Release: 18.3.1, 18.2.5", "18.3.1"],
    ["GitLab Patch Release: 18.3.2", "18.3.2"],
    ["GitLab Patch Release", undefined],
    ["GitLab Patch Release: soon", undefined],
    ["Introducing GitLab 18.4", undefined],
    ["GitLab 18 released", undefined],
    ["GitLab released 18.4", undefined],
    ["", undefined],
  ])("%s -> %s", (title, expected) => {
    expect(gitlabVersion(title)).toBe(expected);
  });
});

describe("htmlBlocks and steamNoteLines", () => {
  it("splits HTML into blocks by heading, paragraph, item and break, and keeps loose text first", () => {
    expect(htmlBlocks("loose<h2>Title</h2><p>One <b>bold</b></p><ul><li>a</li><li>b<br>c</li></ul>")).toEqual([
      { tag: "text", text: "loose" },
      { tag: "h2", text: "Title" },
      { tag: "p", text: "One bold" },
      { tag: "li", text: "a" },
      { tag: "li", text: "b" },
      { tag: "br", text: "c" },
    ]);
    expect(htmlBlocks("")).toEqual([]);
    expect(htmlBlocks("<p></p><p> </p>")).toEqual([]);
  });

  it("reads at most 60 blocks", () => {
    expect(htmlBlocks("<p>x</p>".repeat(500))).toHaveLength(60);
  });

  it("steam notes drop BBCode, picture placeholders and links' markup, and never repeat the title", () => {
    const contents =
      "[h1]Update[/h1]\n[list]\n[*] Fixed [b]a crash[/b]. {STEAM_CLAN_IMAGE}/1/a.png\n[*]See [url=https://steamcommunity.com/x]the post[/url]\n[/list]\n";
    expect(steamNoteLines(contents, "Update")).toEqual(["Fixed a crash.", "See the post"]);
    expect(steamNoteLines("", "Update")).toEqual([]);
  });
});

describe("reading one feed", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const logged = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

  it("returns the bounded feed and logs one completed line", async () => {
    stubFetch(allFeedsUp());
    const result = await readReleaseFeed(source("gitlab"));
    expect(result).toMatchObject({ id: "gitlab", label: "GitLab releases", ok: true });
    expect(result.feed).toMatchObject({
      sourceName: "GitLab releases",
      sourceUrl: "https://about.gitlab.com/releases/",
    });
    expect(result.feed?.entries).toHaveLength(4);
    expect(result.bytes).toBeGreaterThan(0);
    expect(logged(vi.mocked(console.log))).toEqual([
      expect.objectContaining({ event: "release_feed_completed", service: "gitlab", entries: 4 }),
    ]);
  });

  it.each([
    ["a 404", { status: 404 }, { kind: "http", status: 404 }],
    ["a 429", { status: 429 }, { kind: "http", status: 429 }],
    ["a 503", { status: 503 }, { kind: "http", status: 503 }],
  ])("%s is a failure that is logged, never thrown", async (_name, init, expected) => {
    stubFetch({ [URLS.github]: () => new Response("secret body text", init) });
    const result = await readReleaseFeed(source("github"));
    expect(result.ok).toBe(false);
    expect(result.feed).toBeUndefined();
    expect(result.failure).toMatchObject(expected);
    const [line] = logged(vi.mocked(console.warn));
    expect(line).toMatchObject({ event: "release_feed_failed", service: "github", ...expected });
    expect(JSON.stringify(line)).not.toContain("secret body text");
  });

  it("a network error, an HTML page, an oversized body and a feed with no entries are failures of the right kind", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("fetch failed")));
    expect((await readReleaseFeed(source("aws"))).failure?.kind).toBe("network");

    stubFetch({ [URLS.aws]: text(fixture("releases/not-a-feed.html")) });
    expect((await readReleaseFeed(source("aws"))).failure).toMatchObject({ kind: "parser" });

    stubFetch({ [URLS.aws]: text(fixture("releases/empty.xml")) });
    expect((await readReleaseFeed(source("aws"))).failure).toMatchObject({ kind: "parser" });

    stubFetch({ [URLS.aws]: () => new Response(new Uint8Array(MAX_BODY_BYTES + 1)) });
    const huge = await readReleaseFeed(source("aws"));
    expect(huge.failure).toMatchObject({ kind: "parser" });
    expect(huge.failure?.message).toContain("larger than 4 MiB");
  });

  it("asks Google for the start of its feed, and follows its move to docs.cloud.google.com", async () => {
    const seen: Array<{ url: string; range: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, range: new Headers(init?.headers).get("range") });
      return url.startsWith("https://cloud.google.com/")
        ? new Response(null, {
            status: 301,
            headers: { location: "https://docs.cloud.google.com/feeds/gcp-release-notes.xml" },
          })
        : new Response(fixture("gcp/release-notes.xml"), { status: 206 });
    });
    const result = await readReleaseFeed(source("gcp"));
    expect(result.ok).toBe(true);
    expect(seen.map((request) => request.url)).toEqual([
      "https://cloud.google.com/feeds/gcp-release-notes.xml",
      "https://docs.cloud.google.com/feeds/gcp-release-notes.xml",
    ]);
    expect(seen[0]?.range).toBe("bytes=0-524287");
  });

  it("a feed that redirects off the vendor's host is a failure and the other host is never asked", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(null, { status: 302, headers: { location: "https://evil.example/feed.xml" } });
    });
    const result = await readReleaseFeed(source("github"));
    expect(result.failure?.message).toContain("off the vendor's host");
    expect(asked).toEqual([URLS.github]);
  });

  it("a truncated Range response still reads: the entry cut off is skipped, the newest are kept", async () => {
    const cut = fixture("gcp/release-notes.xml").slice(
      0,
      fixture("gcp/release-notes.xml").indexOf("September_28_2026") + 40,
    );
    stubFetch({ [URLS.gcp]: text(cut) });
    const result = await readReleaseFeed(source("gcp"));
    expect(result.ok).toBe(true);
    expect(result.feed?.entries[0]?.title).toBe("Cloud Run, BigQuery and 2 more");
  });

  it("probeReleaseFeeds reads every feed now and reports each one's own result", async () => {
    stubFetch({ ...allFeedsUp(), [URLS.azure]: () => new Response("", { status: 500 }) });
    const results = await probeReleaseFeeds();
    expect(results.map((result) => [result.label, result.ok])).toEqual([
      ["AWS releases", true],
      ["Google Cloud releases", true],
      ["Azure releases", false],
      ["GitHub releases", true],
      ["GitLab releases", true],
      ["CS2 releases", true],
    ]);
  });
});

describe("how often the feeds are read", () => {
  const T0 = Date.parse("2026-10-02T12:00:00.000Z");

  function countingFetch(routes: Record<string, () => Response>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const route = routes[url];
      return route ? route() : new Response("not found", { status: 404 });
    });
    return calls;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clearReleaseFeedCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearReleaseFeedCache();
  });

  const routes = () =>
    Object.fromEntries(Object.entries(allFeedsUp()).map(([url, handler]) => [url, handler])) as Record<
      string,
      () => Response
    >;

  it("reads each feed once, then not again until half an hour has passed", async () => {
    const calls = countingFetch(routes());
    expect((await releaseFeedsForBoard()).size).toBe(RELEASE_SOURCES.length);
    expect(calls).toHaveLength(RELEASE_SOURCES.length);

    vi.setSystemTime(T0 + RELEASE_FEED_TTL_MS - 1);
    expect((await releaseFeedsForBoard()).size).toBe(RELEASE_SOURCES.length);
    expect(calls).toHaveLength(RELEASE_SOURCES.length);

    vi.setSystemTime(T0 + RELEASE_FEED_TTL_MS);
    await releaseFeedsForBoard();
    expect(calls).toHaveLength(RELEASE_SOURCES.length * 2);
  });

  it("leaves a feed that failed out, tries it again only after five minutes, and never disturbs the others", async () => {
    const down = { ...routes(), [URLS.aws]: () => new Response("", { status: 503 }) };
    const calls = countingFetch(down);
    const first = await releaseFeedsForBoard();
    expect(first.has("aws")).toBe(false);
    expect(first.size).toBe(RELEASE_SOURCES.length - 1);

    vi.setSystemTime(T0 + RELEASE_FEED_RETRY_MS - 1);
    await releaseFeedsForBoard();
    expect(calls.filter((url) => url === URLS.aws)).toHaveLength(1);

    countingFetch(routes());
    vi.setSystemTime(T0 + RELEASE_FEED_RETRY_MS);
    const later = await releaseFeedsForBoard();
    expect(later.has("aws")).toBe(true);
    // The others were not read again: they are inside their half hour.
    expect(later.get("gitlab")).toBe(first.get("gitlab"));
  });

  it("never rejects, whatever the network does", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("boom")));
    await expect(releaseFeedsForBoard()).resolves.toEqual(new Map());
  });
});

describe("the advisory rule", () => {
  const feed: ReleaseFeed = {
    sourceName: "GitLab releases",
    sourceUrl: "https://about.gitlab.com/releases/",
    entries: [{ title: "GitLab 18.4", release: { version: "18.4", releasedAt: "2026-09-18T00:00:00.000Z" } }],
  };

  it("withReleaseFeeds adds releaseFeed and changes nothing else; a tracker never gets one", () => {
    const outage = service("gitlab", {
      health: "outage",
      summary: "Down",
      incidents: [{ id: "1", title: "Down", health: "outage" }],
    });
    const tracker = service("mikrotik", { category: "updates" });
    const plain = service("claude");
    const [a, b, c] = withReleaseFeeds(
      [outage, tracker, plain],
      new Map<ServiceId, ReleaseFeed>([
        ["gitlab", feed],
        ["mikrotik", feed],
      ]),
    );
    expect(a).toEqual({ ...outage, releaseFeed: feed });
    expect(b).toBe(tracker);
    expect(c).toBe(plain);
  });

  describe("on the board", () => {
    const T0 = Date.parse("2026-10-02T12:00:00.000Z");
    const CLAUDE = "https://status.claude.com/api/v2/summary.json";
    const degraded = {
      status: { indicator: "minor", description: "Partially Degraded Service" },
      components: [{ id: "a", name: "claude.ai", status: "degraded_performance" }],
      incidents: [
        {
          id: "i1",
          name: "Elevated errors",
          status: "investigating",
          impact: "minor",
          started_at: "2026-10-02T11:00:00Z",
        },
      ],
      scheduled_maintenances: [],
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      clearReleaseFeedCache();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      clearReleaseFeedCache();
    });

    const judged = (board: Awaited<ReturnType<typeof collectBoard>>) => ({
      counts: board.counts,
      services: board.services.map((card) => ({
        id: card.id,
        health: card.health,
        summary: card.summary,
        components: card.components,
        incidents: card.incidents,
        category: card.category,
        failure: card.failure,
      })),
    });

    it("a card keeps its real health whether its release feed reads, fails or is gone", async () => {
      stubFetch({ ...allFeedsUp(), [CLAUDE]: () => new Response(JSON.stringify(degraded)) });
      const withFeeds = await collectBoard();
      expect(withFeeds.services.filter((card) => card.releaseFeed).map((card) => card.id)).toEqual([
        "gcp",
        "aws",
        "azure",
        "cs2-europe",
        "github",
        "gitlab",
      ]);

      clearReleaseFeedCache();
      stubFetch({ [CLAUDE]: () => new Response(JSON.stringify(degraded)) });
      const withoutFeeds = await collectBoard();
      expect(withoutFeeds.services.some((card) => card.releaseFeed)).toBe(false);

      expect(judged(withFeeds)).toEqual(judged(withoutFeeds));
      const claude = withFeeds.services.find((card) => card.id === "claude");
      expect(claude?.health).toBe("degraded");
      // A failing feed is not an Unknown card: every other source here is down, and those alone are Unknown.
      for (const card of withoutFeeds.services.filter((candidate) =>
        RELEASE_SOURCES.some((s) => s.id === candidate.id),
      )) {
        expect(card.failure?.kind).not.toBeUndefined();
        expect(card.summary).not.toMatch(/release/i);
      }
    });

    it("a feed that fails leaves its card with no releaseFeed and no failure of its own", async () => {
      stubFetch({
        ...allFeedsUp(),
        [URLS.gitlab]: () => new Response("", { status: 500 }),
        "https://api.status.io/1.0/status/5b36dc6502d06804c08349f7": () =>
          new Response(
            JSON.stringify({
              result: {
                status_overall: { status: "Operational", status_code: 100, updated: "2026-10-02T11:00:00Z" },
                status: [],
                incidents: [],
                maintenance: { active: [], upcoming: [] },
              },
            }),
          ),
      });
      const board = await collectBoard();
      const gitlab = board.services.find((card) => card.id === "gitlab");
      expect(gitlab?.releaseFeed).toBeUndefined();
      expect(gitlab?.failure).toBeUndefined();
      expect(gitlab?.health).not.toBe("unknown");
    });

    it("costs the board no extra requests inside the half hour", async () => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        calls.push(String(input));
        const handler = allFeedsUp()[String(input)];
        return handler ? handler() : new Response("nope", { status: 404 });
      });
      await collectBoard();
      const feedUrls = new Set(RELEASE_SOURCES.map((candidate) => candidate.url));
      expect(calls.filter((url) => feedUrls.has(url))).toHaveLength(RELEASE_SOURCES.length);
      calls.length = 0;
      await collectBoard();
      expect(calls.filter((url) => feedUrls.has(url))).toHaveLength(0);
      expect(calls.length).toBeGreaterThan(10);
    });
  });
});
