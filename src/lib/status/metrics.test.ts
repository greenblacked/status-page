import { describe, expect, it } from "vitest";
import { prometheusMetrics } from "./metrics";
import { board, service } from "../../test/fixtures.ts";

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

  it("declares every family once and ends with a newline", () => {
    const types = lines.filter((line) => line.startsWith("# TYPE"));
    expect(types).toHaveLength(7);
    expect(new Set(types).size).toBe(7);
    expect(types.every((line) => line.endsWith(" gauge"))).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("does not export summaries or other free text", () => {
    const withText = prometheusMetrics(board([service("gcp", { health: "degraded", summary: 'Errors in "us-east1"\n' })]));
    expect(withText).not.toContain("us-east1");
  });
});
