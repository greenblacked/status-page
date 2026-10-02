import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  appleOsReleases,
  describeVersionChanges,
  formatVersionMap,
  isFreshRelease,
  latestAppleOsByFamily,
  mikrotikChangelogIsFor,
  mikrotikChangelogNotes,
  mikrotikChangelogUrl,
  parseAppleOsTitle,
  parseMikrotikNewest,
  splitAppleBuild,
  summarizeMikrotikChangelog,
} from "./changelog.ts";

describe("parseMikrotikNewest", () => {
  it("reads version and unix timestamp", () => {
    const parsed = parseMikrotikNewest("7.24.4 1789558341\n");
    assert.equal(parsed?.version, "7.24.4");
    assert.equal(parsed?.releasedAt, "2026-09-16T11:32:21.000Z");
  });

  it("accepts beta and rc versions", () => {
    assert.equal(parseMikrotikNewest("7.17beta4 1789558341")?.version, "7.17beta4");
    assert.equal(parseMikrotikNewest("7.17rc1")?.version, "7.17rc1");
  });

  it("refuses a version that could reshape the changelog URL or the card", () => {
    assert.equal(parseMikrotikNewest(`7.${"1".repeat(40)} 1789558341`), null);
    assert.equal(parseMikrotikNewest(`7.${"1".repeat(30)} 1789558341`)?.version, `7.${"1".repeat(30)}`);
    for (const body of ["../../evil 1789558341", "7.1/../../x", "7.1?x=1", "<b>7</b>", "v7.1", "7..1", "%2e%2e"]) {
      assert.equal(parseMikrotikNewest(body), null, body);
    }
  });
});

describe("a date no Date can hold", () => {
  it("leaves a MikroTik release without a time instead of throwing", () => {
    // A 17-digit stamp is finite, but x1000 is far past the Date range.
    assert.deepEqual(parseMikrotikNewest("7.24.4 99999999999999999"), { version: "7.24.4", releasedAt: undefined });
  });

  it("leaves an Apple release without a time and keeps the others", () => {
    const releases = appleOsReleases([
      { title: "iOS 27.2 (24B5089g)", pubDate: "not a date" },
      { title: "macOS 27.2 (26B5091g)", pubDate: "Mon, 21 Sep 2026 10:00:00 PDT" },
    ]);
    assert.deepEqual(
      releases.map((release) => [release.family, release.publishedAt]),
      [
        ["iOS", undefined],
        ["macOS", "2026-09-21T17:00:00.000Z"],
      ],
    );
  });
});

describe("mikrotikChangelogUrl", () => {
  it("builds the official changelog URL for a valid version", () => {
    assert.equal(mikrotikChangelogUrl("7.24.4"), "https://download.mikrotik.com/routeros/7.24.4/CHANGELOG");
  });

  it("returns null for anything that is not a version", () => {
    assert.equal(mikrotikChangelogUrl("../7.1"), null);
    assert.equal(mikrotikChangelogUrl("7.1/x"), null);
    assert.equal(mikrotikChangelogUrl(""), null);
  });
});

describe("summarizeMikrotikChangelog", () => {
  it("joins the heading and first bullet", () => {
    const summary = summarizeMikrotikChangelog(
      "What's new in 7.24.4 (2026-09-16):\n\n*) lte - prevent the modem firmware from being deleted;\n",
    );
    assert.match(summary, /7\.24\.4/);
    assert.match(summary, /lte/);
  });
});

describe("mikrotikChangelogNotes", () => {
  const changelog = [
    "What's new in 7.21beta4 (2026-Sep-19 12:00):",
    "",
    "!) lte - fixed a crash;",
    "*) bgp - fixed route refresh handling when the peer restarts;",
    "*) bridge - improved MAC learning;",
    "continuation text that is not a bullet",
    "*) console - added export verbose;",
    "*) wifi - fixed roaming;",
    "*) one bullet too many;",
    "",
    "What's new in 7.21beta3 (2026-Sep-17 12:00):",
    "*) dhcpv6-server - an older release's note;",
  ].join("\n");

  it("keeps the first four bullets of the newest section, without markers or the trailing semicolon", () => {
    assert.deepEqual(mikrotikChangelogNotes(changelog), [
      "lte - fixed a crash",
      "bgp - fixed route refresh handling when the peer restarts",
      "bridge - improved MAC learning",
      "console - added export verbose",
    ]);
    assert.deepEqual(mikrotikChangelogNotes(changelog, 2), [
      "lte - fixed a crash",
      "bgp - fixed route refresh handling when the peer restarts",
    ]);
  });

  it("stops at the next heading, so an older release's notes are never shown for this one", () => {
    const short = "What's new in 7.2:\n*) one;\n\nWhat's new in 7.1:\n*) two;\n";
    assert.deepEqual(mikrotikChangelogNotes(short), ["one"]);
  });

  it("reads CRLF files and cuts a long note", () => {
    assert.deepEqual(mikrotikChangelogNotes("What's new in 7.2:\r\n*) a - b;\r\n"), ["a - b"]);
    const [note] = mikrotikChangelogNotes(`What's new in 7.2:\n*) ${"x".repeat(1000)};\n`);
    assert.equal(note.length, 200);
    assert.ok(note.endsWith("…"));
  });

  it("gives nothing for text that is not a changelog, or a section with no bullets", () => {
    assert.deepEqual(mikrotikChangelogNotes(""), []);
    assert.deepEqual(mikrotikChangelogNotes("<html>Not found</html>"), []);
    assert.deepEqual(mikrotikChangelogNotes("*) a bullet before any heading;\n"), []);
    assert.deepEqual(mikrotikChangelogNotes("What's new in 7.2:\n\n"), []);
    assert.deepEqual(mikrotikChangelogNotes("What's new in 7.2:\n*)\n*) ;\n"), []);
  });

  it("returns plain text: markup in a note stays text for the card to print as text", () => {
    assert.deepEqual(mikrotikChangelogNotes("What's new in 7.2:\n*) <img src=x onerror=alert(1)>;\n"), [
      "<img src=x onerror=alert(1)>",
    ]);
  });
});

describe("splitAppleBuild", () => {
  it("splits a trailing build number from the version", () => {
    assert.deepEqual(splitAppleBuild("27.2 beta 2 (24B5089g)"), { version: "27.2 beta 2", build: "24B5089g" });
    assert.deepEqual(splitAppleBuild("27.0 (24M362)"), { version: "27.0", build: "24M362" });
  });

  it("leaves a version without a build whole", () => {
    assert.deepEqual(splitAppleBuild("27.1"), { version: "27.1" });
    assert.deepEqual(splitAppleBuild("27.1 beta (see notes)"), { version: "27.1 beta (see notes)" });
    assert.deepEqual(splitAppleBuild("(24B5089g)"), { version: "(24B5089g)" });
    assert.deepEqual(splitAppleBuild("27.1 (1)"), { version: "27.1 (1)" });
    assert.deepEqual(splitAppleBuild("27.1 )"), { version: "27.1 )" });
  });
});

describe("apple os releases", () => {
  it("ignores Xcode and TestFlight", () => {
    assert.equal(parseAppleOsTitle("Xcode 27.1 beta (27A9269)"), null);
    assert.equal(parseAppleOsTitle("TestFlight Update"), null);
  });

  it("reads a family and a version in any case, and keeps the beta flag", () => {
    assert.deepEqual(parseAppleOsTitle("  iOS 27 beta 3 (24A5309)  "), {
      family: "iOS",
      version: "27 beta 3 (24A5309)",
      beta: true,
    });
    assert.deepEqual(parseAppleOsTitle("MACOS\t26.1"), { family: "macOS", version: "26.1", beta: false });
    assert.deepEqual(parseAppleOsTitle("iPadOS\n26"), { family: "iPadOS", version: "26", beta: false });
  });

  it("caps a version at 64 characters", () => {
    const parsed = parseAppleOsTitle(`iOS ${"9".repeat(500)}`);
    assert.equal(parsed?.version.length, 64);
    assert.ok(parsed?.version.endsWith("…"));
    assert.equal(parseAppleOsTitle("iOS 26.1 beta 3 (23B5045g)")?.version, "26.1 beta 3 (23B5045g)");
  });

  it("needs a separator and a single-line version after the family", () => {
    assert.equal(parseAppleOsTitle("iOS"), null);
    assert.equal(parseAppleOsTitle("iOS26"), null);
    assert.equal(parseAppleOsTitle("iOSX 26"), null);
    assert.equal(parseAppleOsTitle("iOS 26\nbeta"), null);
    assert.equal(parseAppleOsTitle("watchOSE 11"), null);
  });

  it("keeps the newest item per OS family", () => {
    const latest = latestAppleOsByFamily([
      { title: "iOS 27.2 beta 2 (24B5089g)", pubDate: "Mon, 21 Sep 2026 10:00:00 PDT" },
      { title: "macOS 27.2 beta 2 (26B5091g)", pubDate: "Mon, 21 Sep 2026 10:00:00 PDT" },
      { title: "iOS 27.0 (24A437)", pubDate: "Mon, 14 Sep 2026 10:00:00 PDT" },
      { title: "Xcode 27 (27A266a)", pubDate: "Mon, 14 Sep 2026 10:00:00 PDT" },
    ]);
    assert.deepEqual(
      latest.map((item) => item.title),
      ["iOS 27.2 beta 2 (24B5089g)", "macOS 27.2 beta 2 (26B5091g)"],
    );
    assert.equal(latest[0]?.beta, true);
  });
});

describe("isFreshRelease", () => {
  it("flags releases inside the window", () => {
    const now = Date.parse("2026-09-22T12:00:00.000Z");
    assert.equal(isFreshRelease("2026-09-16T15:32:21.000Z", now), true);
    assert.equal(isFreshRelease("2026-08-01T00:00:00.000Z", now), false);
  });
});

describe("version maps", () => {
  it("names each channel or OS that changed", () => {
    const previous = formatVersionMap([
      { name: "iOS", version: "27.2 beta 2 (24B5089g)" },
      { name: "macOS", version: "27.2 beta 2 (26B5091g)" },
    ]);
    const next = formatVersionMap([
      { name: "iOS", version: "27.2 beta 3 (24B5090a)" },
      { name: "macOS", version: "27.2 beta 2 (26B5091g)" },
    ]);
    assert.equal(describeVersionChanges(previous, next), "iOS 27.2 beta 3 (24B5090a)");
  });
});

describe("mikrotikChangelogIsFor", () => {
  it("accepts the heading of exactly this version, case-insensitively", () => {
    assert.equal(mikrotikChangelogIsFor("What's new in 7.2 (2026-Sep-19 12:00):\n*) a;", "7.2"), true);
    assert.equal(mikrotikChangelogIsFor("\n  WHAT'S NEW IN 7.21BETA4:\r\n*) a;", "7.21beta4"), true);
    assert.equal(mikrotikChangelogIsFor("What's new in 7.2", "7.2"), true);
    assert.equal(mikrotikChangelogIsFor("What's new in 7.2 ", "7.2"), true);
  });

  it("refuses another version, a longer one, or no heading first", () => {
    assert.equal(mikrotikChangelogIsFor("What's new in 7.21 (2026-Sep-19):\n*) a;", "7.2"), false);
    assert.equal(mikrotikChangelogIsFor("What's new in 7.2.1:\n*) a;", "7.2"), false);
    assert.equal(mikrotikChangelogIsFor("What's new in 7.21beta4:\n*) a;", "7.20.2"), false);
    assert.equal(mikrotikChangelogIsFor("Changelog\nWhat's new in 7.2:\n*) a;", "7.2"), false);
    assert.equal(mikrotikChangelogIsFor("", "7.2"), false);
    assert.equal(mikrotikChangelogIsFor("<html>Not found</html>", "7.2"), false);
  });
});
