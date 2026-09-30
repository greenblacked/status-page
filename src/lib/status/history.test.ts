import { describe, expect, it } from "vitest";
import type { HistoryDay, HistoryDocument } from "./history";
import {
  emptyHistory,
  oldestRetainedDate,
  parseHistory,
  publicHistory,
  utcDateString,
  worseHistoryHealth,
} from "./history";

describe("worseHistoryHealth", () => {
  it("ranks outage > degraded > maintenance > unknown > operational", () => {
    expect(worseHistoryHealth("operational", "unknown")).toBe("unknown");
    expect(worseHistoryHealth("unknown", "maintenance")).toBe("maintenance");
    expect(worseHistoryHealth("maintenance", "degraded")).toBe("degraded");
    expect(worseHistoryHealth("degraded", "outage")).toBe("outage");
    expect(worseHistoryHealth("outage", "operational")).toBe("outage");
    // unknown must not beat degraded: that is the board attention order, not history.
    expect(worseHistoryHealth("unknown", "degraded")).toBe("degraded");
  });
});

describe("utcDateString", () => {
  it("uses the UTC calendar day, including edges around midnight", () => {
    expect(utcDateString("2026-09-27T23:59:59.999Z")).toBe("2026-09-27");
    expect(utcDateString("2026-09-28T00:00:00.000Z")).toBe("2026-09-28");
    expect(utcDateString("2026-09-28T00:00:00.001Z")).toBe("2026-09-28");
  });

  it("returns null for an unusable stamp", () => {
    expect(utcDateString("yesterday")).toBeNull();
    expect(utcDateString("")).toBeNull();
  });
});

describe("oldestRetainedDate", () => {
  it("keeps a 30-day window ending on today", () => {
    expect(oldestRetainedDate("2026-09-30", 30)).toBe("2026-09-01");
    expect(oldestRetainedDate("2026-03-01", 30)).toBe("2026-01-31");
  });
});

describe("parseHistory", () => {
  it("returns null for empty, wrong-schema or non-object values", () => {
    expect(parseHistory(null)).toBeNull();
    expect(parseHistory("{not json")).toBeNull();
    expect(
      parseHistory({
        schema: 2,
        updatedAt: "2026-09-27T00:00:00.000Z",
        timezone: "UTC",
        retentionDays: 30,
        services: {},
      }),
    ).toBeNull();
    expect(parseHistory({ schema: 1, updatedAt: "nope", timezone: "UTC", retentionDays: 30, services: {} })).toBeNull();
  });

  it("keeps well-formed days and drops corrupt service entries", () => {
    const parsed = parseHistory({
      schema: 1,
      updatedAt: "2026-09-27T12:00:00.000Z",
      timezone: "UTC",
      retentionDays: 30,
      services: {
        gcp: {
          days: [
            { date: "2026-09-27", worst: "degraded", samples: 2, up: 0.5 },
            { date: "bad", worst: "operational", samples: 1, up: 1 },
            { date: "2026-09-26", worst: "outage", samples: 0, up: 0 },
          ],
        },
        aws: { days: "nope" },
        "": { days: [{ date: "2026-09-27", worst: "operational", samples: 1, up: 1 }] },
      },
    });
    expect(parsed).toEqual({
      schema: 1,
      updatedAt: "2026-09-27T12:00:00.000Z",
      timezone: "UTC",
      retentionDays: 30,
      services: {
        gcp: { days: [{ date: "2026-09-27", worst: "degraded", samples: 2, up: 0.5 }] },
      },
    });
  });
});

describe("publicHistory", () => {
  it("exposes only date, worst, samples and up per day", () => {
    const document: HistoryDocument = {
      ...emptyHistory("2026-09-27T12:00:00.000Z"),
      services: { gcp: { days: [{ date: "2026-09-27", worst: "degraded", samples: 1, up: 0 }] } },
    };
    const published = publicHistory(document);
    expect(published.services.gcp.days[0]).toEqual({
      date: "2026-09-27",
      worst: "degraded",
      samples: 1,
      up: 0,
    });
    expect(JSON.stringify(published)).not.toMatch(/failure|latencyMs|message|token|secret/i);
  });
});

describe("security: public serializer", () => {
  it("strips anything beyond date, worst, samples, up from days", () => {
    const dirty = {
      ...emptyHistory("2026-09-27T12:00:00.000Z"),
      services: {
        gcp: {
          days: [
            {
              date: "2026-09-27",
              worst: "degraded" as const,
              samples: 1,
              up: 0,
              failure: { message: "collector boom" },
              probe: { body: "vendor raw" },
              token: "secret",
            } as HistoryDay & Record<string, unknown>,
          ],
        },
      },
    };
    const published = publicHistory(dirty as HistoryDocument);
    expect(published.services.gcp.days[0]).toEqual({
      date: "2026-09-27",
      worst: "degraded",
      samples: 1,
      up: 0,
    });
    expect(Object.keys(published.services.gcp.days[0]).sort()).toEqual(["date", "samples", "up", "worst"]);
    expect(JSON.stringify(published)).not.toMatch(/failure|probe|token|secret|collector|vendor/i);
  });
});
