import { describe, expect, it } from "vitest";
import { boundSnapshot, clip, MAX_NAME_CHARS, MAX_TEXT_CHARS, MAX_TITLE_CHARS } from "./bounds.ts";
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
      summary: long,
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
