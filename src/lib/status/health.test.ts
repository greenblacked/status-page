import { describe, expect, it } from "vitest";
import { attentionBreakdown, instatusComponent, SEVERITY_ORDER, urgencyOf, worseHealth } from "./health";

const none = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };

describe("attentionBreakdown", () => {
  it("names each state that needs attention, worst first", () => {
    expect(attentionBreakdown({ ...none, operational: 9, degraded: 2, outage: 1, unknown: 2 })).toBe(
      "1 outage · 2 degraded · 2 unknown",
    );
  });

  it("says Unknown when every item is Unknown, not Degraded", () => {
    expect(attentionBreakdown({ ...none, operational: 1, unknown: 13 })).toBe("13 unknown");
  });

  it("has nothing to list on an all-clear board", () => {
    expect(attentionBreakdown({ ...none, operational: 14 })).toBe("nothing to watch");
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
