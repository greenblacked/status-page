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
  textSeverity,
  urgencyOf,
  worseHealth,
} from "./health";
import { azureItemHealth, grokItemHealth } from "./sources.server.ts";

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

describe("textSeverity", () => {
  it.each([
    ["Resolved", "operational"],
    ["Available", "operational"],
    ["All systems operational", "operational"],
    ["Partial outage", "degraded"],
    ["partial  OUTAGE in one region", "degraded"],
    ["Degraded performance", "degraded"],
    ["Performance issues", "degraded"],
    ["Service disruption", "degraded"],
    ["Major outage", "outage"],
    ["Outage", "outage"],
    ["Service unavailable", "outage"],
    ["Down", "outage"],
    ["Under maintenance", "maintenance"],
    ["Investigating", undefined],
    ["", undefined],
  ] as const)("reads %j as %s", (text, health) => {
    expect(textSeverity(text)).toBe(health);
  });

  it("matches whole words only", () => {
    expect(textSeverity("unavailable")).toBe("outage");
    expect(textSeverity("unresolved")).toBeUndefined();
    expect(textSeverity("downstream")).toBeUndefined();
    expect(textSeverity("outages")).toBeUndefined();
  });

  it("reads the milder state first when a value names several", () => {
    expect(textSeverity("Degraded, not a full outage")).toBe("degraded");
    expect(textSeverity("Outage resolved")).toBe("operational");
    expect(textSeverity("Outage during maintenance")).toBe("outage");
  });
});

describe("a partial outage in a feed reads as on a Statuspage component", () => {
  it("is degraded in Grok's and Azure's feeds", () => {
    expect(grokItemHealth("<p>Severity: Partial outage</p><p>Status: Identified</p>")).toBe("degraded");
    expect(grokItemHealth("Partial outage in one region")).toBe("degraded");
    expect(azureItemHealth("Partial outage - Azure SQL - West Europe")).toBe("degraded");
  });

  it("leaves a full outage an outage", () => {
    expect(grokItemHealth("<p>Severity: Major outage</p><p>Status: Monitoring</p>")).toBe("outage");
    expect(grokItemHealth("Partial outage became a major outage")).toBe("outage");
    expect(azureItemHealth("Outage - Azure SQL - West Europe")).toBe("outage");
    expect(azureItemHealth("Partial outage - Virtual Machines - Service unavailable")).toBe("outage");
  });

  it("reads a one-word Grok severity of major, critical or full as an outage", () => {
    expect(grokItemHealth("<p>Severity: Major</p><p>Status: Investigating</p>")).toBe("outage");
    expect(grokItemHealth("<p>Severity: Critical</p><p>Status: Identified</p>")).toBe("outage");
    expect(grokItemHealth("<p>Severity: Full</p>")).toBe("outage");
    expect(grokItemHealth("<p>Severity: Minor</p><p>Status: Investigating</p>")).toBe("degraded");
    expect(grokItemHealth("<p>Severity: Major</p><p>Status: Resolved</p>")).toBe("operational");
  });

  it("leaves an Azure outage an outage when its title also names the symptoms", () => {
    expect(azureItemHealth("Outage - Azure Front Door: degraded performance")).toBe("outage");
    expect(azureItemHealth("Service outage - Azure SQL: disruption in West Europe")).toBe("outage");
    expect(azureItemHealth("Partial outage in East US; outage in West Europe")).toBe("outage");
    expect(azureItemHealth("Partial outage - Storage - degraded performance")).toBe("degraded");
    expect(azureItemHealth("Partial outage during maintenance - Storage")).toBe("degraded");
  });
});
