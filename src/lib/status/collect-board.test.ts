import { describe, expect, it } from "vitest";
import { assembleBoard } from "./collect-board";
import type { ServiceSnapshot } from "./types";

function service(overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: "gcp",
    name: "Google Cloud",
    shortName: "GCP",
    category: "cloud",
    health: "operational",
    summary: "",
    sourceName: "Google Cloud Status",
    sourceUrl: "https://status.cloud.google.com",
    checkedAt: "2026-09-27T00:00:00.000Z",
    latencyMs: 10,
    components: [],
    incidents: [],
    ...overrides,
  };
}

describe("assembleBoard", () => {
  it("counts services by health and stamps a generation time", () => {
    const before = Date.now();
    const board = assembleBoard(
      [
        service({ health: "operational" }),
        service({ id: "aws", health: "outage" }),
        service({ id: "epic", health: "operational" }),
      ],
      250,
    );
    const after = Date.now();

    expect(board.durationMs).toBe(250);
    expect(board.services).toHaveLength(3);
    expect(board.counts).toEqual({ operational: 2, degraded: 0, outage: 1, maintenance: 0, unknown: 0 });
    expect(Date.parse(board.generatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(board.generatedAt)).toBeLessThanOrEqual(after);
  });

  it("counts every health state, including empty input", () => {
    const board = assembleBoard([], 0);
    expect(board.counts).toEqual({ operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 });
  });
});
