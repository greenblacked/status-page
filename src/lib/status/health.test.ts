import { describe, expect, it } from "vitest";
import { attentionBreakdown, instatusComponent } from "./health";

const none = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };

describe("attentionBreakdown", () => {
  it("names each state that needs attention, worst first", () => {
    expect(attentionBreakdown({ ...none, operational: 9, degraded: 2, outage: 1, unknown: 2 })).toBe(
      "1 outage · 2 degraded · 2 unknown",
    );
  });

  it("pluralises the one label that is a noun", () => {
    expect(attentionBreakdown({ ...none, operational: 12, outage: 2 })).toBe("2 outages");
    expect(attentionBreakdown({ ...none, operational: 0, outage: 14 })).toBe("14 outages");
    expect(attentionBreakdown({ ...none, operational: 13, outage: 1 })).toBe("1 outage");
    expect(attentionBreakdown({ ...none, operational: 9, maintenance: 5 })).toBe("5 maintenance");
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
