// Shared builders for the snapshots the unit tests feed into the board's pure
// functions. Defaults are deliberately bland (the id doubles as the name, an
// operational card with no components or incidents), so a test states the
// fields it depends on through overrides instead of inheriting them.
//
// This module is not a test file: vitest only collects `*.test.ts`, and
// nothing outside tests imports it, so it never reaches a build.
import type { BoardSnapshot, Health, ServiceId, ServiceSnapshot } from "../lib/status/types.ts";

export const FIXTURE_TIME = "2026-09-25T00:00:00.000Z";

export function service(id: ServiceId, overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id,
    name: id,
    shortName: id,
    category: "cloud",
    health: "operational",
    summary: "",
    sourceName: "Source",
    sourceUrl: `https://status.example.com/${id}`,
    checkedAt: FIXTURE_TIME,
    latencyMs: 1,
    components: [],
    incidents: [],
    ...overrides,
  };
}

/** A board whose `counts` always agree with its services. */
export function board(
  services: ServiceSnapshot[],
  overrides: Partial<Omit<BoardSnapshot, "services" | "counts">> = {},
): BoardSnapshot {
  const counts: Record<Health, number> = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const item of services) counts[item.health] += 1;
  return {
    generatedAt: FIXTURE_TIME,
    durationMs: 1,
    ...overrides,
    services,
    counts,
  };
}
