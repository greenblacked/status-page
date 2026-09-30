import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  describeVersionChanges,
  formatVersionMap,
  isFreshRelease,
  latestAppleOsByFamily,
  mikrotikChangelogUrl,
  parseAppleOsTitle,
  parseMikrotikNewest,
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
    for (const body of ["../../evil 1789558341", "7.1/../../x", "7.1?x=1", "<b>7</b>", "v7.1", "7..1", "%2e%2e"]) {
      assert.equal(parseMikrotikNewest(body), null, body);
    }
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

describe("apple os releases", () => {
  it("ignores Xcode and TestFlight", () => {
    assert.equal(parseAppleOsTitle("Xcode 27.1 beta (27A9269)"), null);
    assert.equal(parseAppleOsTitle("TestFlight Update"), null);
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
