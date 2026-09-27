import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchBoardHistory,
  formatUptimePercent,
  historySlots,
  historySlotTitle,
  historyStripSummary,
  sampleWeightedUptime,
  serviceHistoryDays,
  utcToday,
  worstHistoryDay,
} from "./board-history";
import type { HistoryDay, PublicHistory } from "./history";

function day(date: string, worst: HistoryDay["worst"], samples: number, up: number): HistoryDay {
  return { date, worst, samples, up };
}

function document(services: PublicHistory["services"]): PublicHistory {
  return {
    schema: 1,
    updatedAt: "2026-09-27T12:00:00.000Z",
    timezone: "UTC",
    retentionDays: 30,
    services,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("serviceHistoryDays", () => {
  it("returns days for a known id and [] for a missing one", () => {
    const history = document({
      aws: { days: [day("2026-09-27", "operational", 1, 1)] },
    });
    expect(serviceHistoryDays(history, "aws")).toEqual([day("2026-09-27", "operational", 1, 1)]);
    expect(serviceHistoryDays(history, "gcp")).toEqual([]);
    expect(serviceHistoryDays(null, "aws")).toEqual([]);
    expect(serviceHistoryDays(undefined, "aws")).toEqual([]);
  });
});

describe("historySlots", () => {
  it("pads a 30-day UTC window with empty slots", () => {
    const slots = historySlots([day("2026-09-27", "degraded", 2, 0.5)], "2026-09-27");
    expect(slots).toHaveLength(30);
    expect(slots[0]?.date).toBe("2026-08-29");
    expect(slots[0]?.day).toBeNull();
    expect(slots[29]).toEqual({ date: "2026-09-27", day: day("2026-09-27", "degraded", 2, 0.5) });
  });

  it("returns [] for a bad today stamp", () => {
    expect(historySlots([day("2026-09-27", "operational", 1, 1)], "nope")).toEqual([]);
  });
});

describe("sampleWeightedUptime", () => {
  it("weights by samples and ignores empty input", () => {
    expect(sampleWeightedUptime([])).toBeNull();
    expect(
      sampleWeightedUptime([day("2026-09-26", "operational", 1, 1), day("2026-09-27", "outage", 3, 0)]),
    ).toBeCloseTo(0.25);
  });
});

describe("formatUptimePercent", () => {
  it("formats common ranges", () => {
    expect(formatUptimePercent(1)).toBe("100%");
    expect(formatUptimePercent(0.995)).toBe("99.5%");
    expect(formatUptimePercent(0.05)).toBe("5.00%");
  });
});

describe("worstHistoryDay", () => {
  it("picks the worst health and ignores empty input", () => {
    expect(worstHistoryDay([])).toBeNull();
    expect(
      worstHistoryDay([
        day("2026-09-25", "operational", 1, 1),
        day("2026-09-26", "degraded", 1, 0),
        day("2026-09-27", "unknown", 1, 0),
      ]),
    ).toEqual(day("2026-09-26", "degraded", 1, 0));
  });
});

describe("historyStripSummary", () => {
  it("names uptime and the worst non-operational day", () => {
    const days = [day("2026-09-26", "degraded", 2, 0.5), day("2026-09-27", "operational", 2, 1)];
    expect(historyStripSummary(days, 0.75, days[0])).toBe(
      "2-day uptime history. 75.0% operational. worst day 2026-09-26: Degraded",
    );
  });
});

describe("historySlotTitle", () => {
  it("labels sampled and empty slots from public fields only", () => {
    expect(historySlotTitle({ date: "2026-09-27", day: day("2026-09-27", "outage", 1, 0) })).toBe("2026-09-27: Outage");
    expect(historySlotTitle({ date: "2026-09-26", day: null })).toBe("2026-09-26: no samples");
  });
});

describe("utcToday", () => {
  it("returns the UTC calendar day", () => {
    expect(utcToday(Date.parse("2026-09-27T23:30:00.000Z"))).toBe("2026-09-27");
    expect(utcToday(Number.NaN)).toBeNull();
  });
});

describe("fetchBoardHistory", () => {
  it("parses a well-formed body and keeps only public day fields", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        schema: 1,
        updatedAt: "2026-09-27T12:00:00.000Z",
        timezone: "UTC",
        retentionDays: 30,
        services: {
          aws: {
            days: [{ date: "2026-09-27", worst: "operational", samples: 1, up: 1, secret: "drop-me" }],
          },
        },
      }),
    );
    const history = await fetchBoardHistory(fetchImpl as unknown as typeof fetch);
    expect(history.services.aws?.days).toEqual([day("2026-09-27", "operational", 1, 1)]);
  });

  it("returns empty on non-OK, malformed JSON, or network failure", async () => {
    const empty503 = await fetchBoardHistory(
      vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    );
    expect(empty503.services).toEqual({});
    expect(empty503.schema).toBe(1);

    const emptyBad = await fetchBoardHistory(
      vi.fn(async () => Response.json({ schema: 99 })) as unknown as typeof fetch,
    );
    expect(emptyBad.services).toEqual({});

    const emptyNet = await fetchBoardHistory(
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    );
    expect(emptyNet.services).toEqual({});
  });
});
