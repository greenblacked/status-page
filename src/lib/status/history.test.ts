import { describe, expect, it } from "vitest";
import { service as fullService } from "../../test/fixtures";
import type { HistoryDay, HistoryDocument } from "./history";
import {
  emptyHistory,
  mergeBoardIntoHistory,
  oldestRetainedDate,
  parseHistory,
  publicHistory,
  utcDateString,
  worseHistoryHealth,
} from "./history";
import type { Health, ServiceSnapshot } from "./types";

function service(id: string, health: Health): Pick<ServiceSnapshot, "id" | "health"> {
  return { id: id as ServiceSnapshot["id"], health };
}

function board(generatedAt: string, services: Array<Pick<ServiceSnapshot, "id" | "health">>) {
  return { generatedAt, services: services as ServiceSnapshot[] };
}

describe("worseHistoryHealth", () => {
  it("ranks outage > degraded > unknown > maintenance > operational, the board's one order", () => {
    expect(worseHistoryHealth("operational", "maintenance")).toBe("maintenance");
    expect(worseHistoryHealth("maintenance", "unknown")).toBe("unknown");
    expect(worseHistoryHealth("unknown", "degraded")).toBe("degraded");
    expect(worseHistoryHealth("degraded", "outage")).toBe("outage");
    expect(worseHistoryHealth("outage", "operational")).toBe("outage");
    // A real degradation is never masked by an unreadable source.
    expect(worseHistoryHealth("degraded", "unknown")).toBe("degraded");
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

describe("mergeBoardIntoHistory", () => {
  it("creates history from an empty store", () => {
    const next = mergeBoardIntoHistory(
      null,
      board("2026-09-27T12:00:00.000Z", [service("gcp", "operational"), service("aws", "degraded")]),
    );
    expect(next.schema).toBe(1);
    expect(next.timezone).toBe("UTC");
    expect(next.retentionDays).toBe(30);
    expect(next.updatedAt).toBe("2026-09-27T12:00:00.000Z");
    expect(next.services.gcp.days).toEqual([{ date: "2026-09-27", worst: "operational", samples: 1, up: 1 }]);
    expect(next.services.aws.days).toEqual([{ date: "2026-09-27", worst: "degraded", samples: 1, up: 0 }]);
  });

  it("recovers from corrupt history by starting fresh", () => {
    const next = mergeBoardIntoHistory(
      parseHistory({ schema: 99 }),
      board("2026-09-27T12:00:00.000Z", [service("gcp", "operational")]),
    );
    expect(next.services.gcp.days).toHaveLength(1);
  });

  it("keeps partial history and ignores its bad entries", () => {
    const partial = parseHistory({
      schema: 1,
      updatedAt: "2026-09-26T00:00:00.000Z",
      timezone: "UTC",
      retentionDays: 30,
      services: {
        gcp: {
          days: [
            { date: "2026-09-26", worst: "operational", samples: 3, up: 1 },
            { date: "nope", worst: "outage", samples: 1, up: 0 },
          ],
        },
      },
    });
    const next = mergeBoardIntoHistory(partial, board("2026-09-27T01:00:00.000Z", [service("gcp", "degraded")]));
    expect(next.services.gcp.days).toEqual([
      { date: "2026-09-26", worst: "operational", samples: 3, up: 1 },
      { date: "2026-09-27", worst: "degraded", samples: 1, up: 0 },
    ]);
  });

  it("drops days older than the retention window", () => {
    const existing: HistoryDocument = {
      ...emptyHistory("2026-09-30T00:00:00.000Z"),
      services: {
        gcp: {
          days: [
            { date: "2026-08-31", worst: "outage", samples: 10, up: 0 },
            { date: "2026-09-01", worst: "operational", samples: 5, up: 1 },
          ],
        },
      },
    };
    const next = mergeBoardIntoHistory(existing, board("2026-09-30T12:00:00.000Z", [service("gcp", "operational")]));
    expect(next.services.gcp.days.map((d) => d.date)).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("splits samples across UTC midnight, not local time", () => {
    let history = mergeBoardIntoHistory(null, board("2026-09-27T23:59:59.000Z", [service("gcp", "degraded")]));
    history = mergeBoardIntoHistory(history, board("2026-09-28T00:00:00.000Z", [service("gcp", "operational")]));
    expect(history.services.gcp.days).toEqual([
      { date: "2026-09-27", worst: "degraded", samples: 1, up: 0 },
      { date: "2026-09-28", worst: "operational", samples: 1, up: 1 },
    ]);
  });

  it("tracks the worst health seen that UTC day", () => {
    let history = mergeBoardIntoHistory(null, board("2026-09-27T01:00:00.000Z", [service("gcp", "operational")]));
    history = mergeBoardIntoHistory(history, board("2026-09-27T02:00:00.000Z", [service("gcp", "maintenance")]));
    history = mergeBoardIntoHistory(history, board("2026-09-27T03:00:00.000Z", [service("gcp", "degraded")]));
    history = mergeBoardIntoHistory(history, board("2026-09-27T04:00:00.000Z", [service("gcp", "unknown")]));
    expect(history.services.gcp.days[0]).toMatchObject({ worst: "degraded", samples: 4 });
  });

  it("computes the up fraction from operational samples", () => {
    let history = mergeBoardIntoHistory(null, board("2026-09-27T01:00:00.000Z", [service("gcp", "operational")]));
    history = mergeBoardIntoHistory(history, board("2026-09-27T02:00:00.000Z", [service("gcp", "outage")]));
    history = mergeBoardIntoHistory(history, board("2026-09-27T03:00:00.000Z", [service("gcp", "operational")]));
    expect(history.services.gcp.days[0].up).toBeCloseTo(2 / 3, 10);
    expect(history.services.gcp.days[0].samples).toBe(3);
  });

  it("is safe to merge the same snapshot day twice (bumps samples, recomputes)", () => {
    const snapshot = board("2026-09-27T12:00:00.000Z", [service("gcp", "operational")]);
    const once = mergeBoardIntoHistory(null, snapshot);
    const twice = mergeBoardIntoHistory(once, snapshot);
    expect(once.services.gcp.days[0]).toEqual({ date: "2026-09-27", worst: "operational", samples: 1, up: 1 });
    expect(twice.services.gcp.days[0]).toEqual({ date: "2026-09-27", worst: "operational", samples: 2, up: 1 });
  });

  it("leaves history alone when generatedAt is unusable", () => {
    const existing = mergeBoardIntoHistory(null, board("2026-09-27T12:00:00.000Z", [service("gcp", "operational")]));
    const next = mergeBoardIntoHistory(existing, board("not-a-date", [service("gcp", "outage")]));
    expect(next).toEqual(existing);
  });
});

describe("publicHistory", () => {
  it("exposes only date, worst, samples and up per day", () => {
    const document = mergeBoardIntoHistory(null, board("2026-09-27T12:00:00.000Z", [service("gcp", "degraded")]));
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

describe("security: public serializer and retention cap", () => {
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

  it("never copies collector failure or meta from a board sample into history", () => {
    const snapshot = {
      generatedAt: "2026-09-27T12:00:00.000Z",
      services: [
        fullService("gcp", {
          health: "unknown",
          failure: { kind: "parser", message: "do not store me" },
          meta: { token: "secret" },
          summary: "internal",
        }),
      ],
    };
    const next = mergeBoardIntoHistory(null, snapshot);
    expect(JSON.stringify(next)).not.toMatch(/do not store me|secret|internal|parser/);
    expect(next.services.gcp.days[0]).toEqual({ date: "2026-09-27", worst: "unknown", samples: 1, up: 0 });
  });

  it("caps each service at 30 days even if older days somehow remain in range", () => {
    const days = Array.from({ length: 40 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 8, 1 + i));
      return {
        date: date.toISOString().slice(0, 10),
        worst: "operational" as const,
        samples: 1,
        up: 1,
      };
    });
    const existing: HistoryDocument = {
      ...emptyHistory("2026-10-10T00:00:00.000Z"),
      services: { gcp: { days } },
    };
    const next = mergeBoardIntoHistory(existing, board("2026-10-10T12:00:00.000Z", [service("gcp", "operational")]));
    expect(next.services.gcp.days.length).toBeLessThanOrEqual(30);
    expect(next.services.gcp.days[0].date).toBe(oldestRetainedDate("2026-10-10", 30));
  });
});
