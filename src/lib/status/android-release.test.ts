import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { androidReleases, MAX_ANDROID_LINKS, readAndroidVersionLinks } from "./android-release.ts";

const page = readFileSync(new URL("./__fixtures__/android-os/versions.html", import.meta.url), "utf8");

const link = (href: string, text: string, attributes = "") => `<a ${attributes}href="${href}">${text}</a>`;

describe("readAndroidVersionLinks", () => {
  it("reads the versions of the recorded page, once each, newest first as the menu gives them", () => {
    // The menu lists 17 to 10 (with the codenames after), the footer repeats 17 to 11.
    expect(readAndroidVersionLinks(page)).toEqual(["17", "16", "15", "14", "13", "12", "11", "10"]);
  });

  it("does not read the page body's cards, which lag behind the menu, as versions", () => {
    // The body's heading links wrap an image, so they have no text of their own.
    expect(readAndroidVersionLinks(link("/about/versions/16", '<img alt="Android 16">'))).toEqual([]);
    expect(readAndroidVersionLinks(link("/about/versions/16", "Home"))).toEqual([]);
  });

  it("reads the link text through nested tags and across lines", () => {
    const html = link("/about/versions/17", '\n  <span class="t" tooltip>Android\n 17</span>\n');
    expect(readAndroidVersionLinks(html)).toEqual(["17"]);
  });

  it("accepts the page's own path and the full vendor URL, with a slash, query or fragment", () => {
    for (const href of [
      "/about/versions/17",
      "/about/versions/17/",
      "/about/versions/17?hl=en",
      "/about/versions/17#top",
      "https://developer.android.com/about/versions/17",
    ]) {
      expect(readAndroidVersionLinks(link(href, "Android 17"))).toEqual(["17"]);
    }
    expect(readAndroidVersionLinks("<a href='/about/versions/17'>Android 17</a>")).toEqual(["17"]);
  });

  it("refuses a link to another host or page, a codename, a version of the wrong shape, or text that disagrees", () => {
    for (const [href, text] of [
      ["https://example.com/about/versions/17", "Android 17"],
      ["https://developer.android.com.example.com/about/versions/17", "Android 17"],
      ["//developer.android.com/about/versions/17", "Android 17"],
      ["/about/versions/17/qpr1", "Android 17"],
      ["/about/versions/17/qpr1", "Android 17 QPR1"],
      ["/about/versions/pie", "Android 9"],
      ["/about/versions/123", "Android 123"],
      ["/about/versions/", "Android 17"],
      ["/about/versions/17x", "Android 17"],
      ["/about/versions/17", "Android 16"],
      ["/about/versions/17", "Android 17 Beta"],
      ["/about/versions/17", "android 17"],
      ["/about/versions/17", "Android Beta"],
    ]) {
      expect(readAndroidVersionLinks(link(href, text))).toEqual([]);
    }
    expect(readAndroidVersionLinks("<a href=/about/versions/17>Android 17</a>")).toEqual([]);
    expect(readAndroidVersionLinks('<abbr href="/about/versions/17">Android 17</abbr>')).toEqual([]);
  });

  it("gives nothing for a page with no links, an unclosed link or a tag that never ends", () => {
    expect(readAndroidVersionLinks("")).toEqual([]);
    expect(readAndroidVersionLinks("<html><body>Android 17</body></html>")).toEqual([]);
    expect(readAndroidVersionLinks('<a href="/about/versions/17">Android 17')).toEqual([]);
    expect(readAndroidVersionLinks('<a href="/about/versions/17"')).toEqual([]);
  });

  it("skips a tag or link text longer than the ceilings", () => {
    expect(readAndroidVersionLinks(`<a href="/about/versions/17" ${'x="y" '.repeat(1000)}>Android 17</a>`)).toEqual([]);
    expect(readAndroidVersionLinks(link("/about/versions/17", `Android 17${" ".repeat(1000)}`))).toEqual([]);
  });

  it("looks at no more than MAX_ANDROID_LINKS links", () => {
    const filler = '<a href="/x">x</a>'.repeat(MAX_ANDROID_LINKS);
    expect(readAndroidVersionLinks(filler + link("/about/versions/17", "Android 17"))).toEqual([]);
    expect(readAndroidVersionLinks(link("/about/versions/17", "Android 17") + filler)).toEqual(["17"]);
  });
});

describe("androidReleases", () => {
  it("sorts by number, not by text, drops repeats and keeps the newest four", () => {
    expect(androidReleases(["9", "17", "16", "17", "10", "15"])).toEqual([
      { version: "17", name: "Android 17" },
      { version: "16", name: "Android 16" },
      { version: "15", name: "Android 15" },
      { version: "10", name: "Android 10" },
    ]);
  });

  it("puts a new major first without knowing it", () => {
    expect(androidReleases(["16", "17", "18"]).map((release) => release.name)).toEqual([
      "Android 18",
      "Android 17",
      "Android 16",
    ]);
  });

  it("is empty for no versions", () => {
    expect(androidReleases([])).toEqual([]);
  });
});
