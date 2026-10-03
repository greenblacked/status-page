import { describe, expect, it } from "vitest";
import {
  boundId,
  boundReleaseFeed,
  boundSnapshot,
  clip,
  MAX_FEED_ENTRIES,
  MAX_FEED_TITLE_CHARS,
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
  MAX_NOTE_CHARS,
  MAX_NOTE_LINES,
  MAX_RELEASE_FIELD_CHARS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from "./bounds.ts";
import type { ServiceSnapshot } from "./types.ts";

describe("clip", () => {
  it("returns text within the limit unchanged", () => {
    expect(clip("", 5)).toBe("");
    expect(clip("hello", 5)).toBe("hello");
    expect(clip("hi", 5)).toBe("hi");
  });

  it("cuts to the limit including the ellipsis", () => {
    expect(clip("abcdefghij", 5)).toBe("abcd…");
    expect(clip("abcdefghij", 5)).toHaveLength(5);
    expect(clip("a".repeat(1_000_000), 300)).toHaveLength(300);
  });

  it("drops whitespace left dangling before the ellipsis", () => {
    expect(clip("abc     defgh", 7)).toBe("abc…");
  });

  it("never splits a surrogate pair", () => {
    // Each emoji is two UTF-16 units: a cut after the first unit of the third
    // would leave half of it behind.
    const text = "😀😀😀😀😀";
    expect(clip(text, 6)).toBe("😀😀…");
    expect(clip(text, 7)).toBe("😀😀😀…");
    for (let max = 1; max <= 10; max += 1) {
      const out = clip(text, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(() => encodeURIComponent(out)).not.toThrow();
    }
  });

  it("copes with a limit too small for any text", () => {
    expect(clip("abc", 1)).toBe("…");
    expect(clip("abc", 0)).toBe("…");
  });
});

const base: ServiceSnapshot = {
  id: "claude",
  name: "Claude",
  shortName: "Claude",
  category: "ai",
  health: "degraded",
  summary: "ok",
  sourceName: "x",
  sourceUrl: "https://status.example.com/",
  checkedAt: "2026-09-20T00:00:00.000Z",
  latencyMs: 1,
  components: [],
  incidents: [],
};

describe("boundSnapshot", () => {
  const long = "x".repeat(10_000);

  it("holds every vendor string to its limit", () => {
    const bounded = boundSnapshot({
      ...base,
      summary: "y".repeat(10_000),
      components: [
        { name: long, health: "outage", detail: long },
        { name: "short", health: "operational" },
      ],
      incidents: [{ id: "i", title: long, health: "outage" }],
      upcomingMaintenance: [{ id: "m", title: long }],
      failure: { kind: "parser", message: long },
    });
    expect(bounded.summary).toHaveLength(MAX_TEXT_CHARS);
    expect(bounded.components[0].name).toHaveLength(MAX_NAME_CHARS);
    expect(bounded.components[0].detail).toHaveLength(MAX_TEXT_CHARS);
    expect(bounded.components[1]).toEqual({ name: "short", health: "operational" });
    expect(bounded.incidents[0].title).toHaveLength(MAX_TITLE_CHARS);
    expect(bounded.upcomingMaintenance?.[0].title).toHaveLength(MAX_TITLE_CHARS);
    expect(bounded.failure?.message).toHaveLength(MAX_TEXT_CHARS);
  });

  it("clips the name and detail of every component, up to the 300 a card keeps", () => {
    const components = Array.from({ length: 300 }, () => ({
      name: long,
      health: "operational" as const,
      detail: long,
    }));
    const bounded = boundSnapshot({ ...base, components });
    expect(bounded.components).toHaveLength(300);
    expect(bounded.components.every((c) => c.name.length === MAX_NAME_CHARS)).toBe(true);
    expect(bounded.components.every((c) => c.detail?.length === MAX_TEXT_CHARS)).toBe(true);
  });

  it("clips a summary that is an incident's title the same way as the title", () => {
    // Between the title and summary limits: clipped as a summary alone it would
    // stay whole while the title is cut, and the board would list the incident
    // again under a summary that no longer equals it.
    const title = "a".repeat(399);
    const bounded = boundSnapshot({
      ...base,
      summary: title,
      incidents: [{ id: "i", title, health: "outage" }],
    });
    expect(bounded.incidents[0].title).toHaveLength(MAX_TITLE_CHARS);
    expect(bounded.summary).toBe(bounded.incidents[0].title);
  });

  it("matches the summary to a title the way the board does, trimmed and case-folded", () => {
    const title = "B".repeat(399);
    const bounded = boundSnapshot({
      ...base,
      summary: ` ${title.toLowerCase()} `,
      incidents: [{ id: "i", title, health: "outage" }],
    });
    expect(bounded.summary.trim().toLowerCase()).toBe(bounded.incidents[0].title.trim().toLowerCase());
  });

  it("keeps the summary limit for a summary that is not an incident's title", () => {
    const bounded = boundSnapshot({
      ...base,
      summary: "s".repeat(399),
      incidents: [{ id: "i", title: "t".repeat(399), health: "outage" }],
    });
    expect(bounded.summary).toHaveLength(399);
  });

  it("leaves a snapshot within the limits equal to itself, without adding fields", () => {
    const snapshot: ServiceSnapshot = {
      ...base,
      components: [{ name: "A", health: "operational", detail: undefined }],
      incidents: [{ id: "i", title: "T", health: "outage", url: "https://status.example.com/i" }],
    };
    const bounded = boundSnapshot(snapshot);
    expect(bounded).toEqual(snapshot);
    expect("upcomingMaintenance" in bounded).toBe(false);
    expect("failure" in bounded).toBe(false);
  });

  it("passes a field that is not text through instead of throwing", () => {
    const snapshot = {
      ...base,
      components: [{ name: "A", health: "outage", detail: 42 }],
    } as unknown as ServiceSnapshot;
    expect(boundSnapshot(snapshot).components[0].detail).toBe(42);
  });
});

describe("boundId", () => {
  it("leaves an id within the limit alone", () => {
    expect(boundId("statuspage-1a2b3c4d")).toBe("statuspage-1a2b3c4d");
    expect(boundId("x".repeat(MAX_ID_CHARS))).toBe("x".repeat(MAX_ID_CHARS));
  });

  it("shortens a longer one deterministically, keeping two long ids with one start apart", () => {
    const start = "iCloud-".repeat(100);
    const first = boundId(`${start}one`);
    const second = boundId(`${start}two`);
    expect(first).toHaveLength(MAX_ID_CHARS);
    expect(second).toHaveLength(MAX_ID_CHARS);
    expect(first).not.toBe(second);
    expect(boundId(`${start}one`)).toBe(first);
    expect(first.startsWith("iCloud-")).toBe(true);
  });

  it("does not end its kept start inside a surrogate pair", () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const out = boundId(`${"a".repeat(pad)}${"😀".repeat(200)}`);
      expect(out.length).toBeLessThanOrEqual(MAX_ID_CHARS);
      expect(() => encodeURIComponent(out)).not.toThrow();
    }
  });
});

describe("boundSnapshot ids, links and meta", () => {
  const long = "z".repeat(5000);

  it("bounds incident and maintenance ids and drops links too long to keep", () => {
    const bounded = boundSnapshot({
      ...base,
      incidents: [
        { id: long, title: "T", health: "outage", url: `https://status.example.com/${long}` },
        { id: "ok", title: "T", health: "outage", url: "https://status.example.com/ok" },
      ],
      upcomingMaintenance: [{ id: long, title: "M", url: `https://status.example.com/${long}` }],
    });
    expect(bounded.incidents[0].id).toHaveLength(MAX_ID_CHARS);
    expect(bounded.incidents[0].url).toBeUndefined();
    expect(bounded.incidents[1]).toEqual({
      id: "ok",
      title: "T",
      health: "outage",
      url: "https://status.example.com/ok",
    });
    expect(bounded.upcomingMaintenance?.[0].id).toHaveLength(MAX_ID_CHARS);
    expect(bounded.upcomingMaintenance?.[0].url).toBeUndefined();
    const edge = `https://status.example.com/${"p".repeat(MAX_URL_CHARS - 27)}`;
    expect(edge).toHaveLength(MAX_URL_CHARS);
    expect(
      boundSnapshot({ ...base, incidents: [{ id: "a", title: "T", health: "outage", url: edge }] }).incidents[0].url,
    ).toBe(edge);
  });

  it("clips meta text, a title-like value shorter than the rest, and leaves numbers alone", () => {
    const bounded = boundSnapshot({ ...base, meta: { latest: long, versions: long, players: 12, euPops: 0 } });
    expect(bounded.meta?.latest).toHaveLength(MAX_TITLE_CHARS);
    expect(bounded.meta?.versions).toHaveLength(MAX_TEXT_CHARS);
    expect(bounded.meta?.players).toBe(12);
    expect(bounded.meta?.euPops).toBe(0);
    expect("meta" in boundSnapshot(base)).toBe(false);
  });
});

describe("boundSnapshot: a release's Details", () => {
  const long = "x".repeat(10_000);

  it("holds a release's version, build and dates to a few words, its link to the URL limit and its notes to a few short lines", () => {
    const bounded = boundSnapshot({
      ...base,
      category: "updates",
      components: [
        {
          name: "n",
          health: "operational",
          release: {
            version: long,
            build: long,
            releasedAt: long,
            updatedAt: long,
            url: `https://example.com/${long}`,
            linkLabel: long,
            notes: [long, "", "  ", ...Array.from({ length: 20 }, (_, i) => `note ${i}`)],
          },
        },
      ],
    });
    const release = bounded.components[0].release;
    expect(release?.version).toHaveLength(MAX_RELEASE_FIELD_CHARS);
    expect(release?.build).toHaveLength(MAX_RELEASE_FIELD_CHARS);
    expect(release?.releasedAt).toHaveLength(MAX_RELEASE_FIELD_CHARS);
    expect(release?.updatedAt).toHaveLength(MAX_RELEASE_FIELD_CHARS);
    expect(release?.url).toBeUndefined();
    expect(release?.linkLabel).toHaveLength(MAX_RELEASE_FIELD_CHARS);
    expect(release?.notes).toHaveLength(MAX_NOTE_LINES);
    expect(release?.notes?.[0]).toHaveLength(MAX_NOTE_CHARS);
    expect(release?.notes?.slice(1)).toEqual(["note 0", "note 1", "note 2", "note 3"]);
  });

  it("leaves a short release as it is, drops a notes list with no text and a notes value that is not a list", () => {
    const release = { version: "7.20.2", releasedAt: "2026-09-15T12:00:00.000Z", url: "https://example.com/n" };
    const only = (notes: unknown) =>
      boundSnapshot({
        ...base,
        components: [{ name: "n", health: "operational", release: { ...release, notes } as never }],
      }).components[0].release;
    expect(only(["a - b"])).toEqual({ ...release, notes: ["a - b"] });
    expect(only([])).toEqual(release);
    expect(only(["", 3, null])).toEqual(release);
    expect(only("not a list")).toEqual(release);
    expect(boundSnapshot({ ...base, components: [{ name: "n", health: "operational" }] }).components[0]).toEqual({
      name: "n",
      health: "operational",
    });
  });
});

describe("boundReleaseFeed", () => {
  const long = "x".repeat(10_000);
  const entry = (title: string, release = {}) => ({ title, release: { version: "", ...release } });

  it("keeps at most five entries, cuts each title to one line's worth and holds each release as a tracker's is", () => {
    const feed = boundReleaseFeed({
      sourceName: long,
      sourceUrl: "https://example.com/feed",
      entries: Array.from({ length: 9 }, (_, at) =>
        entry(`${at}${long}`, { url: `https://example.com/${long}`, notes: [long, long, long, long, long, long] }),
      ),
    });
    expect(feed?.entries).toHaveLength(MAX_FEED_ENTRIES);
    expect(feed?.sourceName).toHaveLength(120);
    for (const item of feed?.entries ?? []) {
      expect(item.title).toHaveLength(MAX_FEED_TITLE_CHARS);
      expect(item.release.url).toBeUndefined();
      expect(item.release.notes).toHaveLength(MAX_NOTE_LINES);
    }
  });

  it("drops an entry with no title, and a whole feed with no entry or no usable page", () => {
    const ok = { sourceName: "Feed", sourceUrl: "https://example.com/feed" };
    expect(boundReleaseFeed({ ...ok, entries: [entry(""), entry("   "), entry("Kept")] })?.entries).toHaveLength(1);
    expect(boundReleaseFeed({ ...ok, entries: [] })).toBeUndefined();
    expect(boundReleaseFeed({ ...ok, entries: [entry("")] })).toBeUndefined();
    expect(
      boundReleaseFeed({ ...ok, sourceUrl: `https://example.com/${long}`, entries: [entry("Kept")] }),
    ).toBeUndefined();
    expect(boundReleaseFeed({ ...ok, entries: "nope" as never })).toBeUndefined();
    expect(boundReleaseFeed({ ...ok, entries: [null, 3, { title: 4 }] as never })).toBeUndefined();
  });

  it("boundSnapshot bounds a snapshot's feed and leaves a snapshot without one without the field", () => {
    const bounded = boundSnapshot({
      ...base,
      releaseFeed: { sourceName: "Feed", sourceUrl: "https://example.com/feed", entries: [entry(long)] },
    });
    expect(bounded.releaseFeed?.entries[0]?.title).toHaveLength(MAX_FEED_TITLE_CHARS);
    expect("releaseFeed" in boundSnapshot(base)).toBe(false);
    expect(
      "releaseFeed" in
        boundSnapshot({ ...base, releaseFeed: { sourceName: "F", sourceUrl: "https://a.b", entries: [] } }),
    ).toBe(false);
  });
});
