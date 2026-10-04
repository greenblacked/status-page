import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import {
  appleOsReleases,
  describeVersionChanges,
  formatReleaseAge,
  formatVersionMap,
  isFreshRelease,
  latestAppleOsByFamily,
  mikrotikChangelogIsFor,
  mikrotikChangelogNote,
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

describe("mikrotikChangelogNote", () => {
  const section = (...lines: string[]) => `What's new in 7.2 (2026-Sep-19 12:00):\n\n${lines.join("\n")}\n`;

  it("counts the change lines, names the areas in order of first appearance and flags the important ones", () => {
    const note = mikrotikChangelogNote(
      section(
        "!) lte - fixed a crash when a modem is removed;",
        "*) bgp - fixed a leak;",
        "*) wifi - fixed roaming;",
        "*) bgp - fixed route refresh;",
        "*) container - added a limit;",
        "*) ipsec - improved rekeying;",
        "!) system - changed the default policy;",
      ),
      "7.2",
    );
    assert.deepEqual(note, {
      text: "7 changes: lte, bgp, wifi +3 more · 2 important",
      detail: "7 changes in 6 areas: lte, bgp, wifi, container, ipsec, system.",
      important: ["lte - fixed a crash when a modem is removed", "system - changed the default policy"],
    });
  });

  it("is short for a few areas, singular for one change and has no important part when none is flagged", () => {
    assert.equal(mikrotikChangelogNote(section("*) bgp - a;", "*) wifi - b;"), "7.2")?.text, "2 changes: bgp, wifi");
    assert.equal(mikrotikChangelogNote(section("*) bgp - a;"), "7.2")?.text, "1 change: bgp");
    assert.equal(
      mikrotikChangelogNote(section("*) a - 1;", "*) b - 2;", "*) c - 3;", "*) d - 4;"), "7.2")?.text,
      "4 changes: a, b, c +1 more",
    );
    assert.equal(mikrotikChangelogNote(section("*) bgp - a;"), "7.2")?.important, undefined);
  });

  it("counts a line with no area and names no area for it", () => {
    const note = mikrotikChangelogNote(
      section("*) fixed something with no area at all;", "*) this sentence is far too long to be an area - at all;"),
      "7.2",
    );
    assert.equal(note?.text, "2 changes");
    assert.equal(note?.detail, "2 changes.");
  });

  it("treats areas as the same ignoring case, and keeps the first spelling", () => {
    assert.equal(
      mikrotikChangelogNote(section("*) BGP - a;", "*) bgp - b;", "*) Wifi - c;"), "7.2")?.text,
      "3 changes: BGP, Wifi",
    );
  });

  it("lists at most thirty areas in the Details and five important lines, and says how many it left out", () => {
    const lines = Array.from({ length: 40 }, (_, at) => `!) area${at} - important change ${at};`);
    const note = mikrotikChangelogNote(section(...lines), "7.2");
    // Every area is counted, not only the ones named: 40 areas, 3 on the row, 30 in the Details.
    assert.equal(note?.text, "40 changes: area0, area1, area2 +37 more · 40 important");
    assert.equal(note?.important?.length, 5);
    assert.equal(note?.detail?.startsWith("40 changes in 40 areas: area0, area1"), true);
    assert.equal(note?.detail?.includes("area29, and"), false);
    assert.equal(note?.detail?.includes("area29 and 10 more."), true);
    assert.equal(note?.detail?.includes("area30"), false);
    assert.equal(note?.detail?.endsWith("40 are marked important; the first 5 are listed."), true);
  });

  it("counts the areas past thirty exactly, not as the thirty it names", () => {
    const lines = Array.from({ length: 45 }, (_, at) => `*) area${at} - change ${at};`);
    const note = mikrotikChangelogNote(`${section(...lines)}\nWhat's new in 7.1:\n*) x - y;\n`, "7.2");
    assert.equal(note?.text, "45 changes: area0, area1, area2 +42 more");
    assert.equal(note?.detail?.startsWith("45 changes in 45 areas: area0"), true);
    assert.equal(note?.detail?.endsWith("area29 and 15 more."), true);
    // A repeated area still counts once, whichever side of the thirtieth it falls on.
    const repeated = [...lines, "*) AREA44 - again;", "*) area0 - again;"];
    assert.equal(mikrotikChangelogNote(section(...repeated), "7.2")?.text, "47 changes: area0, area1, area2 +42 more");
  });

  it("says how many important lines the Details leave out, and says nothing when it lists them all", () => {
    const flagged = (count: number) => Array.from({ length: count }, (_, at) => `!) bgp - important ${at};`);
    const seven = mikrotikChangelogNote(section(...flagged(7), "*) wifi - fixed;"), "7.2");
    assert.equal(seven?.text, "8 changes: bgp, wifi · 7 important");
    assert.equal(seven?.important?.length, 5);
    assert.equal(seven?.detail, "8 changes in 2 areas: bgp, wifi. 7 are marked important; the first 5 are listed.");
    const five = mikrotikChangelogNote(section(...flagged(5)), "7.2");
    assert.equal(five?.important?.length, 5);
    assert.equal(five?.detail, "5 changes in 1 area: bgp.");
  });

  it("reads only the version's own section, never an older one below it", () => {
    const text = [
      "What's new in 7.2 (2026-Sep-19 12:00):",
      "*) bgp - a;",
      "",
      "What's new in 7.1 (2026-Sep-01 12:00):",
      "!) wifi - older;",
      "*) lte - older;",
    ].join("\n");
    assert.equal(mikrotikChangelogNote(text, "7.2")?.text, "1 change: bgp");
    // The older section is not this file's first one.
    assert.equal(mikrotikChangelogNote(text, "7.1"), undefined);
  });

  it("reads a CRLF file and a section that ends the file", () => {
    assert.equal(
      mikrotikChangelogNote("What's new in 7.2:\r\n*) bgp - a;\r\n!) wifi - b;\r\n", "7.2")?.text,
      "2 changes: bgp, wifi · 1 important",
    );
  });

  it("gives nothing for empty, garbage, another version's file or a section with no change lines", () => {
    for (const text of [
      "",
      "\n\n",
      "<html>Not found</html>",
      "\u0000\u0001 garbage \ufffd",
      "*) bgp - a bullet before any heading;",
      "What's new in 7.2:\n\n",
      "What's new in 7.2:\n*)\n!)\ncontinuation text\n",
      "What's new in 7.21:\n*) bgp - a;",
    ]) {
      assert.equal(mikrotikChangelogNote(text, "7.2"), undefined, JSON.stringify(text));
    }
  });

  it("gives nothing when the read stopped inside the section, rather than a count that may be short", () => {
    // 70 KB of one version with no next heading: the scan window ends before the section does.
    const long = `What's new in 7.2:\n${"*) bgp - a change;\n".repeat(4000)}`;
    assert.ok(long.length > 64_000);
    assert.equal(mikrotikChangelogNote(long, "7.2"), undefined);
    // The same section followed by the next heading inside the window is complete.
    assert.equal(
      mikrotikChangelogNote(
        `What's new in 7.2:\n${"*) bgp - a change;\n".repeat(100)}\nWhat's new in 7.1:\n*) x - y;`,
        "7.2",
      )?.text,
      "100 changes: bgp",
    );
  });

  it("keeps markup as text and cuts a long important line", () => {
    const note = mikrotikChangelogNote(section("!) <img src=x onerror=alert(1)>;", `!) ${"x".repeat(1000)};`), "7.2");
    assert.equal(note?.important?.[0], "<img src=x onerror=alert(1)>");
    assert.equal(note?.important?.[1].length, 200);
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

describe("formatReleaseAge", () => {
  // The day is the one in UTC, whatever zone the host runs in: a calendar day the vendor gave as midnight UTC
  // (a Windows release) must not slip to the day before west of Greenwich, nor an evening one to the next day east.
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });

  it.each(["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Pacific/Pago_Pago"])(
    "names the UTC day in %s",
    (tz) => {
      process.env.TZ = tz;
      assert.equal(formatReleaseAge("2026-09-29T00:00:00.000Z"), "Sep 29");
      assert.equal(formatReleaseAge("2026-09-29T23:59:00.000Z"), "Sep 29");
      assert.equal(formatReleaseAge("2026-09-29"), "Sep 29");
    },
  );

  it("is empty for a missing or unreadable date", () => {
    assert.equal(formatReleaseAge(undefined), "");
    assert.equal(formatReleaseAge("not a date"), "");
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
