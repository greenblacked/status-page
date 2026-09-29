import { describe, expect, it } from "vitest";
import { READY_MAX_AGE_MS, readiness } from "./readiness";
import type { BoardSnapshot, Health, ServiceSnapshot } from "./types";

// Only `health` matters to readiness(); the rest of a service is irrelevant.
function board(generatedAt: string, healths: Health[]): BoardSnapshot {
  const counts = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  const services = healths.map((health) => {
    counts[health] += 1;
    return { health } as ServiceSnapshot;
  });
  return { generatedAt, durationMs: 100, services, counts };
}

const at = Date.parse("2026-09-27T12:00:00.000Z");

describe("readiness", () => {
  it("is ready when the board is recent and at least one source answered", () => {
    expect(readiness(board("2026-09-27T11:58:30.000Z", ["operational", "unknown", "outage"]), at)).toEqual({
      status: "ready",
      generatedAt: "2026-09-27T11:58:30.000Z",
      ageSeconds: 90,
      services: 3,
      unknown: 1,
    });
  });

  it("is still ready at exactly the age limit, and stale one millisecond past it", () => {
    const edge = new Date(at - READY_MAX_AGE_MS).toISOString();
    const past = new Date(at - READY_MAX_AGE_MS - 1).toISOString();
    expect(readiness(board(edge, ["operational"]), at).status).toBe("ready");
    expect(readiness(board(past, ["operational"]), at).status).toBe("stale");
  });

  it("is blind when every service is unknown, however fresh", () => {
    expect(readiness(board("2026-09-27T12:00:00.000Z", ["unknown", "unknown"]), at)).toMatchObject({
      status: "blind",
      services: 2,
      unknown: 2,
    });
  });

  it("is blind when the board has no services at all", () => {
    expect(readiness(board("2026-09-27T12:00:00.000Z", []), at).status).toBe("blind");
  });

  it("reports stale before blind, since a board too old to trust says little about its services", () => {
    expect(readiness(board("2026-09-27T11:00:00.000Z", ["unknown"]), at).status).toBe("stale");
  });

  it("treats an unparseable timestamp as stale with an unknown age", () => {
    expect(readiness(board("not a date", ["operational"]), at)).toMatchObject({ status: "stale", ageSeconds: -1 });
  });

  it("does not report a negative age when the clock is slightly behind the snapshot", () => {
    expect(readiness(board("2026-09-27T12:00:05.000Z", ["operational"]), at)).toMatchObject({
      status: "ready",
      ageSeconds: 0,
    });
  });
});
