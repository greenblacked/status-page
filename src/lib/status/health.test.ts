import { describe, expect, it } from "vitest";
import {
  ALL_CLEAR_SUMMARY,
  googleImpact,
  googleImpactInfo,
  healthLabel,
  instatusComponent,
  overallSummary,
  SEVERITY_ORDER,
  statusIoHealth,
  statuspageComponentDetail,
  statuspageIncidentImpact,
  urgencyOf,
  worseHealth,
} from "./health";

describe("healthLabel", () => {
  it("names the five states, and calls an unreadable source No data rather than Unknown", () => {
    expect(SEVERITY_ORDER.map(healthLabel)).toEqual(["Outage", "Degraded", "No data", "Maintenance", "Operational"]);
  });
});

describe("overallSummary", () => {
  it("is short, first person where it speaks of itself, and never restates the state's name", () => {
    expect(overallSummary("operational", 0)).toBe(ALL_CLEAR_SUMMARY);
    expect(ALL_CLEAR_SUMMARY).toBe("Nothing reported.");
    expect(overallSummary("operational", 1)).toBe("Up. 1 resolved recently.");
    expect(overallSummary("operational", 2)).toBe("Up. 2 resolved recently.");
    expect(overallSummary("maintenance", 0)).toBe("Maintenance in progress.");
    expect(overallSummary("degraded", 0)).toBe("Some parts are slow or failing.");
    expect(overallSummary("outage", 0)).toBe("Down right now.");
    expect(overallSummary("unknown", 0)).toBe("Couldn't read their status page.");
  });

  it("prefers the vendor's own words when it has some, and falls back when they are empty", () => {
    expect(overallSummary("degraded", 1, "Elevated errors")).toBe("Elevated errors");
    expect(overallSummary("outage", 1, "")).toBe("Down right now.");
  });
});

describe("instatusComponent", () => {
  it("maps Instatus component statuses, ignoring case", () => {
    expect(instatusComponent("OPERATIONAL")).toBe("operational");
    expect(instatusComponent("degradedperformance")).toBe("degraded");
    expect(instatusComponent("PARTIALOUTAGE")).toBe("degraded");
    expect(instatusComponent("MAJOROUTAGE")).toBe("outage");
    expect(instatusComponent("UNDERMAINTENANCE")).toBe("maintenance");
  });

  it("reads anything else, or nothing, as unknown", () => {
    expect(instatusComponent("HASISSUES")).toBe("unknown");
    expect(instatusComponent(undefined)).toBe("unknown");
  });
});

describe("severity order", () => {
  it("is outage, degraded, unknown, maintenance, operational", () => {
    expect([...SEVERITY_ORDER]).toEqual(["outage", "degraded", "unknown", "maintenance", "operational"]);
    expect(urgencyOf("outage")).toBe(0);
    expect(urgencyOf("degraded")).toBe(1);
    expect(urgencyOf("unknown")).toBe(2);
    expect(urgencyOf("maintenance")).toBe(3);
    expect(urgencyOf("operational")).toBe(4);
  });

  it("worseHealth agrees, in both argument orders", () => {
    expect(worseHealth("unknown", "degraded")).toBe("degraded");
    expect(worseHealth("degraded", "unknown")).toBe("degraded");
    expect(worseHealth("unknown", "maintenance")).toBe("unknown");
    expect(worseHealth("maintenance", "unknown")).toBe("unknown");
    expect(worseHealth("maintenance", "operational")).toBe("maintenance");
    expect(worseHealth("outage", "unknown")).toBe("outage");
    expect(worseHealth("operational", "operational")).toBe("operational");
  });
});

describe("googleImpact", () => {
  it("maps the documented impacts", () => {
    expect(googleImpact("SERVICE_OUTAGE")).toBe("outage");
    expect(googleImpact("SERVICE_DISRUPTION")).toBe("degraded");
    expect(googleImpact("SERVICE_MAINTENANCE")).toBe("maintenance");
  });

  it("reads SERVICE_INFORMATION as an operational notice, never as degraded", () => {
    expect(googleImpactInfo("SERVICE_INFORMATION")).toEqual({ health: "operational", informational: true });
    expect(googleImpact("SERVICE_INFORMATION")).toBe("operational");
    expect(googleImpactInfo("AVAILABLE")).toEqual({ health: "operational", informational: true });
  });

  it("reads a value it does not know as unknown, and a real impact as not informational", () => {
    expect(googleImpactInfo("SOMETHING_NEW")).toEqual({ health: "unknown", informational: false });
    expect(googleImpactInfo(undefined, undefined)).toEqual({ health: "unknown", informational: false });
    expect(googleImpactInfo("SERVICE_OUTAGE")).toEqual({ health: "outage", informational: false });
  });

  it("falls back to the severity only when the impact is missing or empty", () => {
    expect(googleImpact(undefined, "critical")).toBe("outage");
    expect(googleImpact("", "high")).toBe("degraded");
    expect(googleImpact("  ", "medium")).toBe("degraded");
    expect(googleImpact(undefined, "low")).toBe("degraded");
    expect(googleImpact("SERVICE_INFORMATION", "high")).toBe("operational");
  });
});

describe("statuspageIncidentImpact", () => {
  it("reads impact none as an operational notice", () => {
    expect(statuspageIncidentImpact("none")).toEqual({ health: "operational", informational: true });
    expect(statuspageIncidentImpact("NONE")).toEqual({ health: "operational", informational: true });
  });

  it("maps real impacts and never marks them informational", () => {
    expect(statuspageIncidentImpact("minor")).toEqual({ health: "degraded", informational: false });
    expect(statuspageIncidentImpact("major")).toEqual({ health: "outage", informational: false });
    expect(statuspageIncidentImpact("critical")).toEqual({ health: "outage", informational: false });
    expect(statuspageIncidentImpact("maintenance")).toEqual({ health: "maintenance", informational: false });
  });

  it("reads a missing or unrecognised impact as unknown, not as an all-clear", () => {
    expect(statuspageIncidentImpact(undefined)).toEqual({ health: "unknown", informational: false });
    expect(statuspageIncidentImpact("")).toEqual({ health: "unknown", informational: false });
    expect(statuspageIncidentImpact("weird")).toEqual({ health: "unknown", informational: false });
  });
});

describe("statuspageComponentDetail", () => {
  it("names a partial outage, and only that", () => {
    expect(statuspageComponentDetail("partial_outage")).toBe("Partial outage");
    expect(statuspageComponentDetail("PARTIAL_OUTAGE")).toBe("Partial outage");
    expect(statuspageComponentDetail("degraded_performance")).toBeUndefined();
    expect(statuspageComponentDetail(undefined)).toBeUndefined();
  });
});

describe("statusIoHealth", () => {
  it.each([
    [100, "operational"],
    [200, "maintenance"],
    [300, "degraded"],
    [400, "degraded"],
    [500, "outage"],
    [600, "degraded"],
  ])("code %i is %s", (code, health) => {
    expect(statusIoHealth(code)).toBe(health);
  });

  it.each([[undefined], [null], ["100"], [0], [-100], [150], [700], [Number.NaN], [{}], [[100]]])(
    "%j is unknown, never an all-clear",
    (code) => {
      expect(statusIoHealth(code)).toBe("unknown");
    },
  );
});
