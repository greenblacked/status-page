import { describe, expect, it } from "vitest";
import { androidReleases, parseAndroidReleaseTitle } from "./android-release.ts";
import { parseAtomEntries } from "./sources.server.ts";

describe("parseAndroidReleaseTitle", () => {
  it.each([
    ["Android 17 is here", "17"],
    ["The Android 17 is here", "17"],
    ["Android 17 is released to AOSP", "17"],
    ["Android 17 QPR1 is rolling out", "17 QPR1"],
    ["android 17 qpr2 is now available", "17 QPR2"],
    ["Android 16.1 is live", "16.1"],
    ["Android 16 QPR3 is available for Pixel", "16 QPR3"],
    ["Android 17 is Here", "17"],
    ["Android 16 QPR2 is Released", "16 QPR2"],
    ["Android 16 QPR 2 is released", "16 QPR2"],
    ["Android 17 are now available", "17"],
    ["  Android 17 is out  ", "17"],
  ])("reads %j as version %j", (title, version) => {
    expect(parseAndroidReleaseTitle(title)).toBe(version);
  });

  it.each([
    // Not out yet.
    "Android 17 Beta 3 is here",
    "Android 17 QPR1 Beta 2 is rolling out",
    "Android 17 Developer Preview 1 is here",
    "Android 17 RC1 is available",
    "Android 17 is coming soon",
    // Not about a version, or no word that says it is out.
    "Android Bench 2.0: Pushing the frontier with challenging long-horizon tasks",
    "Android 17: what's new for developers",
    "Android 17: check out what's new",
    "Android 17 privacy changes now available",
    "Android 17 security patch is live",
    "Android 14 for TV is here",
    "Android 16 QPR is released",
    "Android 16 QPRx is released",
    "Android 16 QPR 2x is released",
    "Android 17 QPR1",
    "Android 17",
    "Android",
    "",
    // Starts somewhere else, or the number is not a version.
    "Bring your Android game to the car screen today",
    "Introducing Android 17 for cars, available now",
    "Android 1234 is here",
    "Android 17x is here",
    "Android 17.5.3 is here",
    "Android Studio Quail 4 is available",
  ])("does not read %j as a release", (title) => {
    expect(parseAndroidReleaseTitle(title)).toBeNull();
  });

  it("reads only the start of a very long title", () => {
    expect(parseAndroidReleaseTitle(`Android 17 is here ${"x ".repeat(50_000)}`)).toBe("17");
    // Only the first 300 characters are read, so a word after them says nothing.
    expect(parseAndroidReleaseTitle(`Android 17 ${"x ".repeat(50_000)}is here`)).toBeNull();
  });
});

describe("androidReleases", () => {
  const post = (title: string, publishedAt?: string) => ({ title, publishedAt });

  it("keeps the earliest post per version, newest version first, and drops everything else", () => {
    const releases = androidReleases([
      post("Android 17 QPR1 is rolling out", "2026-09-24T00:00:00.000Z"),
      post("Android 17 QPR2 Beta 1 is here", "2026-09-30T00:00:00.000Z"),
      post("Jetpack Compose September release", "2026-09-29T00:00:00.000Z"),
      post("Android 17 is released to AOSP", "2026-08-20T00:00:00.000Z"),
      post("Android 17 is here", "2026-08-25T00:00:00.000Z"),
    ]);
    expect(releases).toEqual([
      { version: "17 QPR1", name: "Android 17 QPR1", publishedAt: "2026-09-24T00:00:00.000Z" },
      { version: "17", name: "Android 17", publishedAt: "2026-08-20T00:00:00.000Z" },
    ]);
  });

  it("does not let a later post about a version move its date, whatever order the feed lists them in", () => {
    const early = post("Android 17 is here", "2026-06-16T00:00:00.000Z");
    const late = post("Android 17 is now available on more devices", "2026-08-20T00:00:00.000Z");
    for (const posts of [
      [late, early],
      [early, late],
    ]) {
      expect(androidReleases(posts)).toEqual([
        { version: "17", name: "Android 17", publishedAt: "2026-06-16T00:00:00.000Z" },
      ]);
    }
    // A post with a date is the better record than one without.
    expect(androidReleases([post("Android 17 is here"), early])[0].publishedAt).toBe("2026-06-16T00:00:00.000Z");
  });

  it("breaks a tie on the date by comparing version numbers, not text", () => {
    const releases = androidReleases([
      post("Android 9 is here", "2026-06-10T00:00:00.000Z"),
      post("Android 17 is here", "2026-06-10T00:00:00.000Z"),
    ]);
    expect(releases.map((release) => release.name)).toEqual(["Android 17", "Android 9"]);
  });

  it("orders by date whatever order the feed lists them in", () => {
    const releases = androidReleases([
      post("Android 16 is here", "2025-06-10T00:00:00.000Z"),
      post("Android 17 is here", "2026-06-10T00:00:00.000Z"),
    ]);
    expect(releases.map((release) => release.name)).toEqual(["Android 17", "Android 16"]);
  });

  it("ranks a post with no readable date last, and keeps it", () => {
    const releases = androidReleases([
      post("Android 16 is here", "not a date"),
      post("Android 17 is here", "2026-06-10"),
    ]);
    expect(releases.map((release) => [release.name, release.publishedAt])).toEqual([
      ["Android 17", "2026-06-10T00:00:00.000Z"],
      ["Android 16", undefined],
    ]);
  });

  it("keeps at most four releases", () => {
    const posts = [13, 14, 15, 16, 17, 18].map((n) => post(`Android ${n} is here`, `20${n + 9}-06-10T00:00:00.000Z`));
    expect(androidReleases(posts).map((release) => release.name)).toEqual([
      "Android 18",
      "Android 17",
      "Android 16",
      "Android 15",
    ]);
  });

  it("is empty for a feed with no release post", () => {
    expect(androidReleases([post("Media3 1.11 - What's new?")])).toEqual([]);
    expect(androidReleases([])).toEqual([]);
  });
});

describe("parseAtomEntries", () => {
  it("reads the title and the publication time of each entry", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
      <entry><title type="html"><![CDATA[Android 17 is here & more]]></title><updated>2026-09-25T10:00:00Z</updated><published>2026-09-24T00:00:00Z</published></entry>
      <entry><title>A &amp; B &lt;3</title><updated>2026-09-20T10:00:00Z</updated></entry>
      <entry><link href="https://example.com/"/><published>2026-09-19T00:00:00Z</published></entry>
    </feed>`;
    expect(parseAtomEntries(xml)).toEqual([
      { title: "Android 17 is here & more", publishedAt: "2026-09-24T00:00:00Z" },
      { title: "A & B <3", publishedAt: "2026-09-20T10:00:00Z" },
    ]);
  });

  it("skips the feed's own title and anything outside an entry", () => {
    expect(parseAtomEntries("<feed><title>Only the feed</title></feed>")).toEqual([]);
    expect(parseAtomEntries("<rss><channel><item><title>RSS</title></item></channel></rss>")).toEqual([]);
    expect(parseAtomEntries("")).toEqual([]);
  });

  it("does not read a self-closing or empty title", () => {
    expect(
      parseAtomEntries("<entry><title/></entry><entry><title></title><published>2026-01-01</published></entry>"),
    ).toEqual([]);
  });

  it("cuts a very long title before it is decoded", () => {
    const [post] = parseAtomEntries(`<entry><title>${"a".repeat(100_000)}</title></entry>`);
    expect(post.title.length).toBeLessThanOrEqual(300);
  });

  it("reads an entry that never closes up to the next one", () => {
    const posts = parseAtomEntries("<entry><title>One</title><entry><title>Two</title></entry>");
    expect(posts.map((entry) => entry.title)).toEqual(["One", "Two"]);
  });
});
