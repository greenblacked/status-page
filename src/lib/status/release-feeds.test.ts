import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { service } from "../../test/fixtures.ts";
import { stubFetch, text } from "../../test/stub-fetch.ts";
import { MAX_FEED_ENTRIES, MAX_NOTE_CHARS, MAX_NOTE_LINES } from "./bounds.ts";
import { runWithCloudflareContext } from "./cloudflare-context.ts";
import { collectBoard } from "./collect-board.ts";
import { HEAD_BYTES, MAX_BODY_BYTES, PayloadError } from "./http.ts";
import {
  clearReleaseFeedCache,
  decodeHtmlNames,
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
  startReleaseFeeds,
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
      gitlab: "https://docs.gitlab.com/releases/all-releases.xml",
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
      ["GitLab 19.4.1", "19.4.1"],
      ["GitLab 19.0.9", "19.0.9"],
      ["GitLab 19.4", "19.4"],
      ["GitLab 19.3.2", "19.3.2"],
    ]);
    expect(entries[0]?.release).toMatchObject({
      releasedAt: "2026-09-23T00:00:00.000Z",
      url: "https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-4-1-released/",
      linkLabel: "Release post",
    });
    expect(entries[0]?.release.notes?.[0]).toBe("GitLab Critical Patch Release: 19.4.1, 19.3.3, 19.2.7");
    expect(entries[2]?.release).toMatchObject({
      releasedAt: "2026-09-17T00:00:00.000Z",
      url: "https://docs.gitlab.com/releases/19/gitlab-19-4-released/",
    });
    expect(entries[2]?.release.notes?.[0]).toBe("GitLab 19.4 release notes");
  });

  it("GitLab: a GitLab AI Gateway patch post is not a GitLab release, even as the newest entry of the feed", () => {
    const xml = fixture("gitlab/releases.xml");
    // The recording's first entry is the AI Gateway post, a day newer than any other.
    expect(xml.indexOf("<title>GitLab AI Gateway Critical Patch Release")).toBeGreaterThan(0);
    expect(xml.indexOf("<title>GitLab AI Gateway")).toBeLessThan(xml.indexOf("<title>GitLab 19.4 release notes"));
    const entries = entriesOf("gitlab", xml);
    expect(entries.map((entry) => entry.title)).not.toContain(
      "GitLab AI Gateway Critical Patch Release: 19.2.4, 19.3.2, and 19.4.1",
    );
    expect(entries.every((entry) => entry.release.version !== "")).toBe(true);
    expect(entries.some((entry) => entry.release.url?.includes("/other-patches/"))).toBe(false);
    expect(entries[0]?.title).toBe("GitLab 19.4.1");
  });

  it("GitLab: patch posts of one day put the highest version first, whichever order the feed lists them", () => {
    const post = (title: string, day: string) =>
      `<entry><title>${title}</title><published>${day}T00:00:00Z</published></entry>`;
    const feed = (...entries: string[]) => `<feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;
    const older = post("GitLab Critical Patch Release: 19.0.9, 18.11.12", "2026-09-23");
    const newer = post("GitLab Critical Patch Release: 19.4.1, 19.3.3, 19.2.7", "2026-09-23");
    const month = post("GitLab 19.4 release notes", "2026-09-17");
    for (const xml of [feed(older, newer, month), feed(newer, older, month)]) {
      expect(entriesOf("gitlab", xml).map((entry) => entry.title)).toEqual([
        "GitLab 19.4.1",
        "GitLab 19.0.9",
        "GitLab 19.4",
      ]);
    }
    // A later day still wins over a higher version of an earlier day.
    const later = post("GitLab Patch Release: 19.0.10, 18.11.13", "2026-09-24");
    expect(entriesOf("gitlab", feed(newer, later))[0]?.title).toBe("GitLab 19.0.10");
  });

  it("GitLab: a feed of nothing but AI Gateway posts has no readable entries", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>GitLab AI Gateway Patch Release: 19.4.1</title><published>2026-10-02T00:00:00Z</published></entry></feed>`;
    expect(() => entriesOf("gitlab", xml)).toThrow("had no readable entries");
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
      // A title is read as HTML like a note: the feed's "&amp;amp;" is the HTML "&amp;", which reads as "&".
      "Escaped markup & ampersand",
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

  it("reads the common HTML named references (&hellip; &rsquo; &mdash; ...) in titles and notes, once or double escaped", () => {
    const entries = entriesOf("github", fixture("releases/named-entities.xml"));
    expect(entries.map((entry) => entry.title)).toEqual([
      "Copilot\u2026 now generally available \u2014 for everyone",
      "Rock \u2019n\u2019 roll \u2013 double escaped",
    ]);
    // The numeric reference and the named ones read alike; a name that is not in the list stays as written.
    expect(entries[0]?.release.notes).toEqual([
      "Copilot now does X \u2014 and Y\u2026 It\u2019s \u201cready\u201d \u00a9 2026 \u2122 \u2022 &unknown;",
    ]);
    expect(entries[1]?.release.notes).toEqual(["It\u2019s ready \u2014 really\u2026", "Price \u00a35 & up"]);
    for (const entry of entries) {
      expect(entry.title).not.toMatch(/&[a-z]+;/);
    }
  });

  it("decodeHtmlNames knows only its list, only whole references, and never a name from the prototype", () => {
    expect(decodeHtmlNames("a&hellip;b &HELLIP; &hellip &nosuch; &toString; &__proto__; &;")).toBe(
      "a\u2026b &HELLIP; &hellip &nosuch; &toString; &__proto__; &;",
    );
    // XML's own five are left to decodeXmlEntities, which plainText runs after this, so nothing is decoded twice.
    expect(decodeHtmlNames("&amp;rsquo; &lt;b&gt; &quot;")).toBe("&amp;rsquo; &lt;b&gt; &quot;");
  });

  it("reads a reference once: a name behind an escaped ampersand stays as typed, in notes and in titles", () => {
    const feedWith = (title: string, description: string) =>
      `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>${title}</title>` +
      `<link>https://github.blog/changelog/x/</link><description>${description}</description>` +
      "<pubDate>Thu, 01 Oct 2026 16:00:00 +0000</pubDate></item></channel></rss>";
    // HTML text "&hellip; and &copy; as typed" in a paragraph, escaped once for HTML and once for XML.
    const [entry] = entriesOf(
      "github",
      feedWith(
        "Render &amp;amp;nbsp; and Q&amp;amp;A &amp;rsquo;s",
        "&lt;p&gt;Markdown now keeps &amp;amp;hellip; and &amp;amp;copy; as typed, &amp;hellip; here&lt;/p&gt;",
      ),
    );
    // "&amp;hellip;" in the HTML is the text "&hellip;"; "&hellip;" itself is the ellipsis.
    expect(entry?.release.notes).toEqual(["Markdown now keeps &hellip; and &copy; as typed, \u2026 here"]);
    // The title is read the same way: names and the XML five, each once.
    expect(entry?.title).toBe("Render &nbsp; and Q&A \u2019s");
  });

  it("CS2: an HTML named reference in a post's title is read too", () => {
    const body = JSON.stringify({
      appnews: { newsitems: [{ gid: "1", title: "Counter-Strike 2 Update &mdash; Oct&hellip;", date: 1790000000 }] },
    });
    expect(entriesOf("cs2-europe", body)[0]?.title).toBe("Counter-Strike 2 Update \u2014 Oct\u2026");
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

  it("GitLab: a link reaches the page on docs.gitlab.com or about.gitlab.com, and nowhere else", () => {
    const item = (link: string) =>
      `<item><title>GitLab 19.4 release notes</title><pubDate>Fri, 18 Sep 2026 00:00:00 +0000</pubDate><link>${link}</link></item>`;
    const xml = `<rss version="2.0"><channel>${[
      "https://docs.gitlab.com/releases/18/gitlab-18-4-released/",
      "https://about.gitlab.com/releases/2026/09/18/gitlab-18-4-released/",
      "https://evil.example/gitlab.com/",
      "https://docs.gitlab.com.evil.example/releases/",
      "http://docs.gitlab.com/releases/18/gitlab-18-4-released/",
    ]
      .map(item)
      .join("")}</channel></rss>`;
    expect(entriesOf("gitlab", xml).map((entry) => entry.release.url)).toEqual([
      "https://docs.gitlab.com/releases/18/gitlab-18-4-released/",
      "https://about.gitlab.com/releases/2026/09/18/gitlab-18-4-released/",
      "https://docs.gitlab.com/releases/",
      "https://docs.gitlab.com/releases/",
      "https://docs.gitlab.com/releases/",
    ]);
  });

  it("an Atom entry's link is its alternate; self, edit and enclosure links are not the entry's page", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>GitLab 19.4 release notes</title><updated>2026-10-01T00:00:00Z</updated>
      <link rel="self" href="https://about.gitlab.com/self"/><link rel="enclosure" href="https://about.gitlab.com/file.zip"/>
      <link rel='alternate' href='https://about.gitlab.com/releases/a/'/></entry>
      <entry><title>GitLab 19.3 release notes</title><updated>2026-09-30T00:00:00Z</updated><link href="https://about.gitlab.com/releases/b/"/></entry>
      <entry><title>GitLab 19.2 release notes</title><updated>2026-09-29T00:00:00Z</updated><link rel="self" href="https://about.gitlab.com/self"/></entry></feed>`;
    expect(entriesOf("gitlab", xml).map((entry) => entry.release.url)).toEqual([
      "https://about.gitlab.com/releases/a/",
      "https://about.gitlab.com/releases/b/",
      "https://docs.gitlab.com/releases/",
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

  it("a feed with more entries than the scan bound is a parser failure, not a quietly shortened feed", () => {
    const item = (n: number, day: string) =>
      `<item><title>Entry ${n}</title><pubDate>${day}</pubDate><description>x</description></item>`;
    const early = Array.from({ length: MAX_RSS_SCANNED }, (_, n) => item(n, "Mon, 01 Jun 2026 00:00:00 +0000"));
    const within = `<rss><channel>${early.join("")}</channel></rss>`;
    const started = performance.now();
    expect(entriesOf("aws", within)).toHaveLength(MAX_FEED_ENTRIES);
    expect(performance.now() - started).toBeLessThan(2000);
    // An oldest-first feed puts its newest entry last: reading only the first MAX_RSS_SCANNED would show a stale
    // "latest" release, so the feed fails instead.
    const over = `<rss><channel>${early.join("")}${item(MAX_RSS_SCANNED + 1, "Thu, 01 Oct 2026 00:00:00 +0000")}</channel></rss>`;
    expect(() => entriesOf("aws", over)).toThrow(PayloadError);
  });
});

describe("gitlabVersion", () => {
  it.each([
    ["GitLab 18.4 released with Duo improvements", "18.4"],
    ["GitLab 18.4.1 released", "18.4.1"],
    ["gitlab 19.0 RELEASED", "19.0"],
    ["GitLab 19.4 release notes", "19.4"],
    ["GitLab 19.4  Release  Notes", "19.4"],
    ["GitLab 19.4 release notes and more", "19.4"],
    ["GitLab Critical Patch Release: 19.4.1, 19.3.3, 19.2.7", "19.4.1"],
    ["GitLab AI Gateway Critical Patch Release: 19.2.4, 19.3.2, and 19.4.1", undefined],
    ["GitLab AI Gateway Patch Release: 19.4.1", undefined],
    ["GitLab 19.4 release", undefined],
    ["GitLab 19 release notes", undefined],
    ["GitLab release notes 19.4", undefined],
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
      sourceUrl: "https://docs.gitlab.com/releases/",
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

  it("asks GitLab for the start of its feed, where the newest entries are", async () => {
    const seen: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("range"));
      return new Response(fixture("gitlab/releases.xml"), { status: 206 });
    });
    const result = await readReleaseFeed(source("gitlab"));
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["bytes=0-524287"]);
    expect(result.feed?.entries[0]?.title).toBe("GitLab 19.4.1");
  });

  it("a truncated GitLab Atom body still gives its complete leading entries", async () => {
    const xml = fixture("gitlab/releases.xml");
    const titles = async (cut: string) => {
      stubFetch({ [URLS.gitlab]: text(cut) });
      const result = await readReleaseFeed(source("gitlab"));
      expect(result.ok).toBe(true);
      return result.feed?.entries.map((entry) => entry.title);
    };
    // Cut inside an entry's text: the entries before it are whole, and it keeps the title and day it had.
    expect(await titles(xml.slice(0, xml.indexOf("GitLab 19.4 was released") + 20))).toEqual([
      "GitLab 19.4.1",
      "GitLab 19.0.9",
      "GitLab 19.4",
    ]);
    // Cut inside an entry's title: that entry has none and is skipped.
    expect(await titles(xml.slice(0, xml.indexOf("GitLab Critical Patch Release: 19.3.2") + 20))).toEqual([
      "GitLab 19.4.1",
      "GitLab 19.0.9",
      "GitLab 19.4",
    ]);
  });

  describe("a server that ignores Range and sends everything", () => {
    // The response as a stream in uneven chunks, with how much of it was pulled and whether the reader gave up.
    function streamed(data: Uint8Array, chunk = 10_007) {
      const state = { pulled: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (state.pulled >= data.byteLength) return controller.close();
          const next = data.subarray(state.pulled, state.pulled + chunk);
          state.pulled += next.byteLength;
          controller.enqueue(next);
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { body, state };
    }
    const encoder = new TextEncoder();
    const gitlabFixture = fixture("gitlab/releases.xml");
    // The fixture's first three entries, whole.
    const leading = gitlabFixture.slice(
      0,
      gitlabFixture.indexOf("<entry>", gitlabFixture.indexOf("GitLab 19.4 release notes")),
    );
    const LEADING_TITLES = ["GitLab 19.4.1", "GitLab 19.0.9"];
    const serve = (data: Uint8Array, headers: Record<string, string> = {}) => {
      const { body, state } = streamed(data);
      stubFetch({ [URLS.gitlab]: () => new Response(body, { status: 200, headers }) });
      return state;
    };
    // `leading`, `opening`, filler and `tail`, then more filler: the 512 KiB limit falls right after `tail`, or
    // `overhang` bytes into it.
    function bodyCutAfter(opening: string, tail: string, filler: string, overhang = 0): Uint8Array {
      const start = encoder.encode(leading + opening);
      const fill = HEAD_BYTES - start.byteLength - (encoder.encode(tail).byteLength - overhang);
      if (fill < 0) throw new Error("fixture is bigger than the head");
      return encoder.encode(`${leading}${opening}${filler.repeat(fill)}${tail}${filler.repeat(200_000)}`);
    }

    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("stops reading at 512 KiB and parses the entries before the cut, with the bytes actually read reported", async () => {
      const state = serve(bodyCutAfter("<entry><title>Cut entry</title><content><![CDATA[", "", "x"));
      const result = await readReleaseFeed(source("gitlab"));
      expect(result.ok).toBe(true);
      expect(result.bytes).toBe(HEAD_BYTES);
      expect(state.cancelled).toBe(true);
      // Chunk-sized overshoot at most, not the 700 KiB on offer.
      expect(state.pulled).toBeLessThanOrEqual(HEAD_BYTES + 3 * 10_007);
      // The entry cut off has no date yet and is left out; the three before it are whole.
      expect(result.feed?.entries.map((entry) => entry.title)).toEqual([...LEADING_TITLES, "GitLab 19.4"]);
    });

    it("a body past the 4 MiB cap is read, not refused, when it is cut at 512 KiB", async () => {
      const data = encoder.encode(`${leading}${"x".repeat(MAX_BODY_BYTES + 1)}`);
      const state = serve(data, { "content-length": String(data.byteLength) });
      const result = await readReleaseFeed(source("gitlab"));
      expect(result.ok).toBe(true);
      expect(result.bytes).toBe(HEAD_BYTES);
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeLessThanOrEqual(HEAD_BYTES + 3 * 10_007);
    });

    it("a cut inside a multi-byte character costs only that character", async () => {
      // "é" is two bytes and the limit falls between them; the entry before it is whole.
      const body = bodyCutAfter("<entry><title>Cut caf", "\u00e9", "x", 1);
      const cutAt = body.subarray(0, HEAD_BYTES);
      expect(cutAt.at(-1)).toBe(0xc3);
      serve(body);
      const result = await readReleaseFeed(source("gitlab"));
      expect(result.ok).toBe(true);
      const titles = result.feed?.entries.map((entry) => entry.title) ?? [];
      expect(titles.slice(0, 3)).toEqual([...LEADING_TITLES, "GitLab 19.4"]);
      expect(titles.join("")).not.toContain("\ufffd");
    });

    it("a cut inside CDATA keeps the entries before it and the title of the one cut", async () => {
      serve(
        bodyCutAfter(
          '<entry><title>Cut entry</title><link href="https://docs.gitlab.com/releases/x/"/><content type="html"><![CDATA[<p>',
          "",
          "y",
        ),
      );
      const result = await readReleaseFeed(source("gitlab"));
      expect(result.ok).toBe(true);
      const titles = result.feed?.entries.map((entry) => entry.title) ?? [];
      expect(titles.slice(0, 3)).toEqual([...LEADING_TITLES, "GitLab 19.4"]);
      expect(titles.every((title) => title.length < 200)).toBe(true);
    });

    it("Google's feed is cut the same way, and a feed that is not a head source is still refused over the cap", async () => {
      const gcp = fixture("gcp/release-notes.xml");
      const data = encoder.encode(`${gcp.slice(0, gcp.lastIndexOf("</feed>"))}${"z".repeat(MAX_BODY_BYTES)}`);
      const { body, state } = streamed(data);
      stubFetch({ [URLS.gcp]: () => new Response(body) });
      const result = await readReleaseFeed(source("gcp"));
      expect(result.ok).toBe(true);
      expect(result.bytes).toBe(HEAD_BYTES);
      expect(state.cancelled).toBe(true);
      expect(source("aws").head).toBeUndefined();

      const oversized = streamed(new Uint8Array(MAX_BODY_BYTES * 2));
      stubFetch({ [URLS.aws]: () => new Response(oversized.body) });
      const refused = await readReleaseFeed(source("aws"));
      expect(refused.ok).toBe(false);
      expect(refused.failure?.message).toContain("larger than 4 MiB");
      expect(oversized.state.cancelled).toBe(true);
    });
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
    sourceUrl: "https://docs.gitlab.com/releases/",
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

    /** One board build as a Worker runs it: what it returns, and what it asked `waitUntil` to keep alive. */
    async function collectInWorker() {
      const waiting: Promise<unknown>[] = [];
      const board = await runWithCloudflareContext({ env: {}, waitUntil: (promise) => waiting.push(promise) }, () =>
        collectBoard(),
      );
      return { board, waiting, background: () => Promise.all(waiting) };
    }

    it("a card keeps its real health whether its release feed reads, fails or is gone", async () => {
      stubFetch({ ...allFeedsUp(), [CLAUDE]: () => new Response(JSON.stringify(degraded)) });
      // A cold board has no release lines: the feeds are read after its sweep, and the next board has them.
      const cold = await collectInWorker();
      expect(cold.board.services.some((card) => card.releaseFeed)).toBe(false);
      await cold.background();
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

    // A release feed that has not answered when the health sweep ends, and a way to answer it later.
    function heldFeed(id: ServiceId) {
      let answer: () => void = () => {};
      const held = new Promise<Response>((resolve) => {
        answer = () => resolve(allFeedsUp()[source(id).url]?.() ?? new Response("", { status: 500 }));
      });
      return { handler: () => held, answer };
    }
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it("never waits for a slow feed: the board ends with the health sweep, and the feeds are read after it", async () => {
      const gitlab = heldFeed("gitlab");
      stubFetch({ ...allFeedsUp(), [URLS.gitlab]: gitlab.handler });
      // This resolves while the GitLab feed is still unanswered: awaiting it would hang the test.
      const cold = await collectInWorker();
      expect(cold.board.durationMs).toBe(0);
      expect(cold.board.services.find((card) => card.id === "gitlab")?.releaseFeed).toBeUndefined();
      expect(cold.board.services.find((card) => card.id === "gitlab")?.failure?.message).not.toMatch(/release/i);
      gitlab.answer();
      await cold.background();
      // The quick feeds and the slow one are all cached by now, for the next board.
      const warm = await collectBoard();
      expect(warm.services.filter((card) => card.releaseFeed)).toHaveLength(RELEASE_SOURCES.length);
    });

    it("finishes a slow feed in the background, keeps the request alive for it, and puts it on the next board", async () => {
      const gitlab = heldFeed("gitlab");
      const calls: string[] = [];
      const routes = { ...allFeedsUp(), [URLS.gitlab]: gitlab.handler };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        calls.push(String(input));
        const handler = routes[String(input)];
        return handler ? handler() : new Response("nope", { status: 404 });
      });
      const waiting: Promise<unknown>[] = [];
      const first = await runWithCloudflareContext({ env: {}, waitUntil: (promise) => waiting.push(promise) }, () =>
        collectBoard(),
      );
      expect(first.services.find((card) => card.id === "gitlab")?.releaseFeed).toBeUndefined();
      // The Worker was asked to keep the request alive until the feeds in flight are done...
      expect(waiting).toHaveLength(1);
      let done = false;
      void Promise.resolve(waiting[0]).then(() => {
        done = true;
      });
      await settle();
      expect(done).toBe(false);
      gitlab.answer();
      await waiting[0];
      expect(done).toBe(true);
      // ...and the next board has the feed from the cache, without asking GitLab again.
      calls.length = 0;
      const second = await collectBoard();
      expect(second.services.find((card) => card.id === "gitlab")?.releaseFeed?.entries[0]?.release.version).toBe(
        "19.4.1",
      );
      expect(calls.filter((url) => url === URLS.gitlab)).toHaveLength(0);
    });

    it("startReleaseFeeds: what is in hand is fresh in the cache or already read, never a read in flight", async () => {
      const aws = heldFeed("aws");
      stubFetch({ ...allFeedsUp(), [URLS.aws]: aws.handler });
      const reading = startReleaseFeeds();
      await settle();
      expect(reading.ready().has("gitlab")).toBe(true);
      expect(reading.ready().has("aws")).toBe(false);
      aws.answer();
      await reading.settled;
      expect(reading.ready().has("aws")).toBe(true);
      // Nothing to read the second time: all of it is in hand at once.
      const again = startReleaseFeeds();
      expect(again.ready().size).toBe(RELEASE_SOURCES.length);
    });

    // The Worker allows six simultaneous outgoing connections and queues the rest, while every health request's
    // own timeout is already running. So a feed may never be in flight, or queued, while a health request is.
    describe("order: the feeds start only after the health sweep has settled", () => {
      const feedUrls = new Set(RELEASE_SOURCES.map((candidate) => candidate.url));
      const urlOf = (input: RequestInfo | URL) =>
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      it("starts no feed request before every health request has settled, with more health requests than slots", async () => {
        const SLOTS = 6;
        const feedRoutes = allFeedsUp();
        let seq = 0;
        let lastHealthStart = -1;
        let firstFeedStart = -1;
        let healthStarted = 0;
        let feedStarted = 0;
        let healthUnsettled = 0;
        let mostHealthAtOnce = 0;
        const feedWhileHealthPending: string[] = [];
        const held: Array<() => void> = [];
        vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
          const url = urlOf(input);
          seq += 1;
          const feedHandler = feedUrls.has(url) ? feedRoutes[url] : undefined;
          if (feedHandler) {
            if (healthUnsettled > 0) feedWhileHealthPending.push(url);
            if (firstFeedStart < 0) firstFeedStart = seq;
            feedStarted += 1;
            return Promise.resolve(feedHandler());
          }
          lastHealthStart = seq;
          healthStarted += 1;
          healthUnsettled += 1;
          mostHealthAtOnce = Math.max(mostHealthAtOnce, healthUnsettled);
          return new Promise<Response>((resolve) => {
            held.push(() => {
              healthUnsettled -= 1;
              resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
            });
          });
        });

        let finished = false;
        const run = collectInWorker().then((result) => {
          finished = true;
          return result;
        });
        // Answer the health requests a slot-load at a time, so the sweep takes many rounds, and some
        // collectors ask again after an answer; check on every round that no feed has started.
        for (let round = 0; round < 500 && !finished; round += 1) {
          await settle();
          if (held.length > 0) expect(feedStarted).toBe(0);
          for (const answer of held.splice(0, SLOTS)) answer();
        }
        const { board, background } = await run;
        await background();

        expect(healthStarted).toBeGreaterThan(SLOTS);
        expect(mostHealthAtOnce).toBeGreaterThan(SLOTS);
        expect(feedWhileHealthPending).toEqual([]);
        expect(feedStarted).toBe(RELEASE_SOURCES.length);
        expect(firstFeedStart).toBeGreaterThan(lastHealthStart);
        // The cold board went out without the feeds; they were read afterwards, in the same invocation.
        expect(board.services.some((card) => card.releaseFeed)).toBe(false);
        // ...and are in the cache for the next one.
        expect(startReleaseFeeds().ready().size).toBe(RELEASE_SOURCES.length);
      });

      it("starts no feed request until the slowest health request has finished", async () => {
        let slowest: (() => void) | undefined;
        const feedStartsBeforeSlowest: string[] = [];
        let slowestDone = false;
        const feedRoutes = allFeedsUp();
        vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
          const url = urlOf(input);
          const feedHandler = feedUrls.has(url) ? feedRoutes[url] : undefined;
          if (feedHandler) {
            if (!slowestDone) feedStartsBeforeSlowest.push(url);
            return Promise.resolve(feedHandler());
          }
          if (url === CLAUDE) {
            return new Promise<Response>((resolve) => {
              slowest = () => {
                slowestDone = true;
                resolve(new Response(JSON.stringify(degraded)));
              };
            });
          }
          return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
        });
        let finished = false;
        const run = collectInWorker().then((result) => {
          finished = true;
          return result;
        });
        // Every other source has answered, one is still out: nothing may have started.
        await settle();
        await settle();
        expect(finished).toBe(false);
        expect(feedStartsBeforeSlowest).toEqual([]);
        slowest?.();
        const { board, background } = await run;
        await background();
        expect(feedStartsBeforeSlowest).toEqual([]);
        expect(board.services.find((card) => card.id === "claude")?.health).toBe("degraded");
      });

      it("feeds that are failing, hanging or slow change no health result and not the board's duration", async () => {
        // Each health answer moves the clock on, so the board has a duration to compare.
        const stubWith = (feed: (url: string, init?: RequestInit) => Promise<Response>) => {
          vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = urlOf(input);
            if (feedUrls.has(url)) return feed(url, init);
            vi.setSystemTime(Date.now() + 250);
            if (url === CLAUDE) return new Response(JSON.stringify(degraded));
            return new Response("not found", { status: 404, statusText: "Not Found" });
          });
        };
        const feedRoutes = allFeedsUp();
        const hung: Array<() => void> = [];
        const scenarios: Record<string, (url: string, init?: RequestInit) => Promise<Response>> = {
          up: async (url) => (feedRoutes[url] as () => Response)(),
          "failing (500)": async () => new Response("", { status: 500 }),
          "network error": async () => Promise.reject(new TypeError("fetch failed")),
          hanging: (_url) =>
            new Promise<Response>((resolve) => {
              hung.push(() => resolve(new Response("", { status: 500 })));
            }),
        };

        const results: Array<{ name: string; durationMs: number; judged: ReturnType<typeof judged> }> = [];
        for (const [name, feed] of Object.entries(scenarios)) {
          clearReleaseFeedCache();
          vi.setSystemTime(T0);
          stubWith(feed);
          // Let the feeds of the last scenario end first: a late read must not land in this one's cache.
          const { board, background } = await collectInWorker();
          for (const release of hung.splice(0)) release();
          await background();
          results.push({ name, durationMs: board.durationMs, judged: judged(board) });
          expect(board.services.some((card) => card.releaseFeed)).toBe(false);
        }

        const [baseline, ...others] = results;
        expect(baseline.durationMs).toBeGreaterThan(0);
        expect(baseline.judged.services.find((card) => card.id === "claude")?.health).toBe("degraded");
        for (const other of others) {
          expect(other.durationMs, other.name).toBe(baseline.durationMs);
          expect(other.judged, other.name).toEqual(baseline.judged);
        }
      });

      it("a Worker isolate without waitUntil still reads the due feeds after the sweep", async () => {
        const calls: string[] = [];
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = urlOf(input);
          calls.push(url);
          const handler = allFeedsUp()[url];
          return handler ? handler() : new Response("nope", { status: 404 });
        });
        const cold = await collectBoard();
        expect(cold.services.some((card) => card.releaseFeed)).toBe(false);
        // Nothing keeps the request alive for them, but they were started and finish on their own.
        await vi.waitFor(() => expect(calls.filter((url) => feedUrls.has(url))).toHaveLength(RELEASE_SOURCES.length));
        await settle();
        const warm = await collectBoard();
        expect(warm.services.filter((card) => card.releaseFeed)).toHaveLength(RELEASE_SOURCES.length);
      });
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
