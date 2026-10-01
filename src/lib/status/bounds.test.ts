import { describe, expect, it } from "vitest";
import {
  boundId,
  boundSnapshot,
  clip,
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
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
