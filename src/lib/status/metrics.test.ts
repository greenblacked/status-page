import { describe, expect, it } from "vitest";
import { board, service } from "../../test/fixtures.ts";
import { prometheusMetrics } from "./metrics";

describe("prometheusMetrics", () => {
  const text = prometheusMetrics(
    board(
      [
        service("gcp", { health: "outage", incidents: [{ id: "1", title: "Down", health: "outage" }] }),
        service("aws", { health: "unknown", latencyMs: 250, failure: { kind: "timeout", message: "timed out" } }),
      ],
      { durationMs: 1500 },
    ),
  );
  const lines = text.split("\n");

  it("exports health as a state set with exactly one state set per service", () => {
    const gcp = lines.filter((line) => line.startsWith('statusbar_service_status{service="gcp"'));
    expect(gcp).toHaveLength(5);
    expect(gcp.filter((line) => line.endsWith(" 1"))).toEqual([
      'statusbar_service_status{service="gcp",category="cloud",status="outage"} 1',
    ]);
  });

  it("exports the incidents a source listed, not only the ones the collector kept", () => {
    const capped = prometheusMetrics(
      board([service("gcp", { incidents: [{ id: "1", title: "Down", health: "outage" }], incidentCount: 80 })]),
    );
    expect(capped).toContain('statusbar_service_incidents{service="gcp",category="cloud"} 80');
  });

  it("exports incidents, source reachability, latency and counts", () => {
    expect(lines).toContain('statusbar_service_incidents{service="gcp",category="cloud"} 1');
    expect(lines).toContain('statusbar_source_up{service="gcp",category="cloud"} 1');
    expect(lines).toContain('statusbar_source_up{service="aws",category="cloud"} 0');
    expect(lines).toContain('statusbar_source_latency_seconds{service="aws",category="cloud"} 0.25');
    expect(lines).toContain('statusbar_services{status="outage"} 1');
    expect(lines).toContain('statusbar_services{status="operational"} 0');
  });

  it("exports the snapshot's timestamp and duration in seconds", () => {
    expect(lines).toContain("statusbar_snapshot_timestamp_seconds 1790294400");
    expect(lines).toContain("statusbar_snapshot_duration_seconds 1.5");
  });

  it("exports how long before the snapshot each source was read, in whole seconds", () => {
    const aged = prometheusMetrics(
      board(
        [
          service("gcp", { checkedAt: "2026-09-24T23:58:29.700Z" }),
          service("aws", { checkedAt: "2026-09-25T00:00:00.000Z" }),
          // A clock a little ahead of the snapshot's never reads as a negative age.
          service("azure", { checkedAt: "2026-09-25T00:00:02.000Z" }),
        ],
        { generatedAt: "2026-09-25T00:00:00.000Z" },
      ),
    ).split("\n");
    expect(aged).toContain('statusbar_service_check_age_seconds{service="gcp",category="cloud"} 90');
    expect(aged).toContain('statusbar_service_check_age_seconds{service="aws",category="cloud"} 0');
    expect(aged).toContain('statusbar_service_check_age_seconds{service="azure",category="cloud"} 0');
    expect(aged).toContain("# TYPE statusbar_service_check_age_seconds gauge");
  });

  it("declares every family once and ends with a newline", () => {
    const types = lines.filter((line) => line.startsWith("# TYPE"));
    expect(types).toHaveLength(8);
    expect(new Set(types).size).toBe(8);
    expect(types.every((line) => line.endsWith(" gauge"))).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("does not export summaries or other free text", () => {
    const withText = prometheusMetrics(
      board([service("gcp", { health: "degraded", summary: 'Errors in "us-east1"\n' })]),
    );
    expect(withText).not.toContain("us-east1");
  });
});
