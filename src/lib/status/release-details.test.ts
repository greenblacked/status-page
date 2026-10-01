import { describe, expect, it } from "vitest";
import { service } from "../../test/fixtures.ts";
import { hasReleaseDetails, releaseDate, releaseEntries } from "./release-details.ts";
import type { ComponentHealth } from "./types.ts";

const SOURCE = "https://example.com/releases";

describe("releaseDate", () => {
  it("reads a moment, and a bare day as a UTC day", () => {
    expect(releaseDate("2026-09-29T12:00:00.000Z")).toEqual({ at: Date.parse("2026-09-29T12:00:00Z"), dayOnly: false });
    expect(releaseDate("2026-09-29")).toEqual({ at: Date.parse("2026-09-29T00:00:00Z"), dayOnly: true });
  });

  it("gives nothing for a missing or unreadable date", () => {
    expect(releaseDate(undefined)).toBeUndefined();
    expect(releaseDate("")).toBeUndefined();
    expect(releaseDate("soon")).toBeUndefined();
    expect(releaseDate(5 as never)).toBeUndefined();
  });
});

describe("hasReleaseDetails", () => {
  it("is true for a release tracker that lists something, and for nothing else", () => {
    const row = { name: "Stable", health: "operational" as const };
    expect(hasReleaseDetails({ category: "updates", components: [row] })).toBe(true);
    expect(hasReleaseDetails({ category: "updates", components: [] })).toBe(false);
    expect(hasReleaseDetails({ category: "cloud", components: [row] })).toBe(false);
  });
});

describe("releaseEntries", () => {
  const tracker = (components: ComponentHealth[]) =>
    service("mikrotik", { category: "updates", sourceUrl: SOURCE, components });

  it("lists every component in the collector's order, with its version, build, dates, flag, link and notes", () => {
    const entries = releaseEntries(
      tracker([
        {
          name: "iOS",
          health: "maintenance",
          detail: "27.2 beta 2 (24B5089g) · Sep 21",
          release: {
            version: "27.2 beta 2",
            build: "24B5089g",
            releasedAt: "2026-09-21T17:00:00.000Z",
            url: "https://developer.apple.com/news/releases/?id=1",
          },
        },
        {
          name: "RouterOS 7 stable",
          health: "operational",
          release: {
            version: "7.20.2",
            releasedAt: "2026-09-15T12:00:00.000Z",
            url: "https://download.mikrotik.com/routeros/7.20.2/CHANGELOG",
            notes: ["bridge - fixed VLAN filtering", "   ", "ipsec - improved rekeying"],
          },
        },
      ]),
    );
    expect(entries).toEqual([
      {
        name: "iOS",
        version: "27.2 beta 2",
        build: "24B5089g",
        releasedAt: { at: Date.parse("2026-09-21T17:00:00Z"), dayOnly: false },
        updatedAt: undefined,
        fresh: true,
        url: "https://developer.apple.com/news/releases/?id=1",
        own: true,
        notes: [],
      },
      {
        name: "RouterOS 7 stable",
        version: "7.20.2",
        build: undefined,
        releasedAt: { at: Date.parse("2026-09-15T12:00:00Z"), dayOnly: false },
        updatedAt: undefined,
        fresh: false,
        url: "https://download.mikrotik.com/routeros/7.20.2/CHANGELOG",
        own: true,
        notes: ["bridge - fixed VLAN filtering", "ipsec - improved rekeying"],
      },
    ]);
  });

  it("drops a version that only repeats the name, and an update on the day of the release", () => {
    const [entry] = releaseEntries(
      tracker([
        {
          name: "26H2",
          health: "operational",
          release: { version: "26H2", releasedAt: "2026-09-29", updatedAt: "2026-09-29T08:00:00.000Z" },
        },
      ]),
    );
    expect(entry.version).toBeUndefined();
    expect(entry.updatedAt).toBeUndefined();
    const [later] = releaseEntries(
      tracker([
        {
          name: "26H1",
          health: "operational",
          release: { version: "26H1", releasedAt: "2026-02-10", updatedAt: "2026-09-22" },
        },
      ]),
    );
    expect(later.updatedAt).toEqual({ at: Date.parse("2026-09-22T00:00:00Z"), dayOnly: true });
  });

  it("links the tracker's own page when a release has none, or has one that is not https", () => {
    const entries = releaseEntries(
      tracker([
        { name: "a", health: "operational", release: { version: "1" } },
        { name: "b", health: "operational", release: { version: "2", url: "javascript:alert(1)" } },
        { name: "c", health: "operational", release: { version: "3", url: "http://example.com/plain" } },
        { name: "d", health: "operational", release: { version: "4", url: SOURCE } },
      ]),
    );
    expect(entries.map((entry) => [entry.url, entry.own])).toEqual([
      [SOURCE, false],
      [SOURCE, false],
      [SOURCE, false],
      [SOURCE, false],
    ]);
  });

  it("keeps notes to a few short lines of text", () => {
    const [entry] = releaseEntries(
      tracker([
        {
          name: "a",
          health: "operational",
          release: { version: "1", notes: ["x".repeat(500), ...Array.from({ length: 9 }, (_, i) => `n${i}`)] },
        },
      ]),
    );
    expect(entry.notes).toHaveLength(5);
    expect(entry.notes[0]).toHaveLength(200);
    expect(entry.notes[0].endsWith("…")).toBe(true);
    const [bad] = releaseEntries(
      tracker([{ name: "a", health: "operational", release: { version: "1", notes: "text" as never } }]),
    );
    expect(bad.notes).toEqual([]);
  });

  it("falls back to the detail line for a component without release data, and lists nothing for another category", () => {
    const [entry] = releaseEntries(tracker([{ name: "Stable", health: "operational", detail: "7.21 · Sep 24" }]));
    expect(entry).toMatchObject({
      name: "Stable",
      version: "7.21 · Sep 24",
      fresh: false,
      url: SOURCE,
      own: false,
      notes: [],
    });
    expect(entry.releasedAt).toBeUndefined();
    expect(releaseEntries(service("gcp", { components: [{ name: "a", health: "operational" }] }))).toEqual([]);
  });
});
