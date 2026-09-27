import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  filtersFromSearch,
  filtersToReveal,
  matchesFilters,
  parseBoardSearch,
  resultsAnnouncement,
  searchFromFilters,
} from "./filters";
import type { Health, ServiceId, ServiceSnapshot } from "./types";

function service(id: ServiceId, health: Health, category: ServiceSnapshot["category"] = "cloud"): ServiceSnapshot {
  return {
    id,
    name: id === "gcp" ? "Google Cloud" : id,
    shortName: id.toUpperCase(),
    category,
    health,
    summary: "All reported systems operational.",
    sourceName: "Source",
    sourceUrl: `https://status.example.com/${id}`,
    checkedAt: "2026-09-25T00:00:00Z",
    latencyMs: 42,
    components: [],
    incidents: [],
  };
}

describe("parseBoardSearch", () => {
  it("keeps valid params", () => {
    expect(parseBoardSearch({ q: "gcp", category: "cloud", issues: true, starred: true })).toEqual({
      q: "gcp",
      category: "cloud",
      issues: true,
      starred: true,
    });
  });

  it("accepts flags as strings and a numeric query as text", () => {
    expect(parseBoardSearch({ q: 730, issues: "true", starred: "true" })).toEqual({ q: "730", issues: true, starred: true });
  });

  it("drops unknown categories, blank queries, false flags and other params", () => {
    expect(parseBoardSearch({ q: "  ", category: "weather", issues: "false", starred: 0, utm_source: "slack" })).toEqual({});
    expect(parseBoardSearch({ q: ["a"], category: 3, issues: 1 })).toEqual({});
  });

  it("caps a long query", () => {
    expect(parseBoardSearch({ q: "x".repeat(500) }).q).toHaveLength(100);
  });
});

describe("filters and search params", () => {
  it("round-trip, leaving defaults out of the URL", () => {
    expect(searchFromFilters(DEFAULT_FILTERS)).toEqual({});
    expect(filtersFromSearch({})).toEqual(DEFAULT_FILTERS);
    const filters = { query: "claude", category: "ai" as const, issuesOnly: true, starredOnly: true };
    expect(filtersFromSearch(searchFromFilters(filters))).toEqual(filters);
  });

  it("does not put a whitespace-only query in the URL", () => {
    expect(searchFromFilters({ ...DEFAULT_FILTERS, query: "   " })).toEqual({});
  });
});

describe("matchesFilters", () => {
  const gcp = service("gcp", "degraded");
  const steam = service("steam", "operational", "gaming");

  it("matches everything by default", () => {
    expect(matchesFilters(gcp, DEFAULT_FILTERS)).toBe(true);
    expect(matchesFilters(steam, DEFAULT_FILTERS)).toBe(true);
  });

  it("filters by category, issues and case-insensitive text", () => {
    expect(matchesFilters(steam, { ...DEFAULT_FILTERS, category: "cloud" })).toBe(false);
    expect(matchesFilters(steam, { ...DEFAULT_FILTERS, issuesOnly: true })).toBe(false);
    expect(matchesFilters(gcp, { ...DEFAULT_FILTERS, issuesOnly: true })).toBe(true);
    expect(matchesFilters(gcp, { ...DEFAULT_FILTERS, query: "  GOOGLE " })).toBe(true);
    expect(matchesFilters(gcp, { ...DEFAULT_FILTERS, query: "steam" })).toBe(false);
  });

  it("keeps only starred services when asked", () => {
    const starredOnly = { ...DEFAULT_FILTERS, starredOnly: true };
    expect(matchesFilters(gcp, starredOnly, new Set(["gcp"]))).toBe(true);
    expect(matchesFilters(steam, starredOnly, new Set(["gcp"]))).toBe(false);
    expect(matchesFilters(gcp, starredOnly)).toBe(false);
  });
});

describe("filtersToReveal", () => {
  const gcp = service("gcp", "outage");
  const starred = new Set<ServiceId>(["steam"]);

  it("keeps the filters when the card is already on the board", () => {
    expect(filtersToReveal(gcp, DEFAULT_FILTERS)).toBeNull();
    expect(filtersToReveal(gcp, { ...DEFAULT_FILTERS, category: "cloud", issuesOnly: true })).toBeNull();
    expect(filtersToReveal(gcp, { ...DEFAULT_FILTERS, starredOnly: true }, new Set(["gcp"]))).toBeNull();
  });

  it("clears the filters when they hide the card", () => {
    expect(filtersToReveal(gcp, { ...DEFAULT_FILTERS, category: "gaming" })).toEqual(DEFAULT_FILTERS);
    expect(filtersToReveal(gcp, { ...DEFAULT_FILTERS, query: "steam" })).toEqual(DEFAULT_FILTERS);
    expect(filtersToReveal(gcp, { ...DEFAULT_FILTERS, starredOnly: true }, starred)).toEqual(DEFAULT_FILTERS);
  });
});

describe("resultsAnnouncement", () => {
  it("says how many services the filters leave", () => {
    expect(resultsAnnouncement(3, 14)).toBe("3 of 14 services shown");
    expect(resultsAnnouncement(0, 14)).toBe("0 of 14 services shown");
    expect(resultsAnnouncement(1, 1)).toBe("1 of 1 service shown");
  });
});
