import { describe, expect, it } from "vitest";
import {
  boardHeadline,
  dockProgress,
  documentTitle,
  groupServices,
  keyboardFocus,
  serviceAnchor,
  serviceIndex,
  sortByUrgency,
} from "./layout";
import type { BoardSnapshot, CategoryId, Health, ServiceId, ServiceSnapshot } from "./types";

function service(id: ServiceId, health: Health, category: CategoryId = "cloud", name: string = id): ServiceSnapshot {
  return {
    id,
    name,
    shortName: id.toUpperCase(),
    category,
    health,
    summary: "",
    sourceName: "",
    sourceUrl: "https://example.com",
    checkedAt: "2026-09-25T00:00:00Z",
    latencyMs: 1,
    components: [],
    incidents: [],
  };
}

function board(services: ServiceSnapshot[]): BoardSnapshot {
  const counts = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const item of services) counts[item.health] += 1;
  return { generatedAt: "2026-09-25T00:00:00Z", durationMs: 1, services, counts };
}

describe("groupServices", () => {
  it("puts every non-operational service first, most urgent first, keeping catalog order within a severity", () => {
    const groups = groupServices([
      service("gcp", "degraded"),
      service("aws", "operational"),
      service("steam", "maintenance", "gaming"),
      service("apple", "outage", "platforms"),
      service("grok", "unknown", "ai"),
      service("fortnite", "degraded", "gaming"),
      service("mikrotik", "operational", "updates"),
    ]);
    expect(groups.attention.map((s) => s.id)).toEqual(["apple", "gcp", "fortnite", "steam", "grok"]);
    expect(groups.operational.map((s) => s.id)).toEqual(["aws"]);
    expect(groups.releases.map((s) => s.id)).toEqual(["mikrotik"]);
  });

  it("lists a release tracker under attention when its source fails", () => {
    const groups = groupServices([service("apple-os", "unknown", "updates")]);
    expect(groups.attention.map((s) => s.id)).toEqual(["apple-os"]);
    expect(groups.releases).toEqual([]);
  });

  it("does not reorder the caller's array", () => {
    const input = [service("gcp", "operational"), service("apple", "outage")];
    groupServices(input);
    expect(input.map((s) => s.id)).toEqual(["gcp", "apple"]);
  });
});

describe("sortByUrgency", () => {
  const incident = (startedAt?: string) => ({ id: "i", title: "t", health: "degraded" as const, startedAt });
  const withIncident = (id: ServiceId, health: Health, ...starts: Array<string | undefined>) => ({
    ...service(id, health),
    incidents: starts.map(incident),
  });

  it("orders outage, degraded, maintenance, unknown", () => {
    const sorted = sortByUrgency([
      service("grok", "unknown"),
      service("steam", "maintenance"),
      service("gcp", "degraded"),
      service("apple", "outage"),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["apple", "gcp", "steam", "grok"]);
  });

  it("puts the most recently started incident first within a severity", () => {
    const sorted = sortByUrgency([
      withIncident("gcp", "degraded", "2026-09-25T08:00:00Z"),
      withIncident("aws", "degraded", "2026-09-25T07:00:00Z", "2026-09-25T10:00:00Z"),
      withIncident("steam", "degraded", "2026-09-25T09:00:00Z"),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["aws", "steam", "gcp"]);
  });

  it("ranks a service with no readable incident start after one with a start, then keeps the given order", () => {
    const sorted = sortByUrgency([
      service("steam", "degraded"),
      withIncident("epic", "degraded", undefined, "not a date"),
      withIncident("aws", "degraded", "2026-09-25T08:00:00Z"),
      service("gcp", "degraded"),
    ]);
    // aws has the only readable start; the rest tie and keep the order given.
    expect(sorted.map((s) => s.id)).toEqual(["aws", "steam", "epic", "gcp"]);
  });

  it("puts a worse severity ahead of a newer incident", () => {
    const sorted = sortByUrgency([
      withIncident("aws", "degraded", "2026-09-25T12:00:00Z"),
      withIncident("gcp", "outage", "2026-09-24T00:00:00Z"),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["gcp", "aws"]);
  });

  it("returns an empty list, and a copy, when nothing needs attention", () => {
    expect(sortByUrgency([])).toEqual([]);
    const input = [service("aws", "outage"), service("gcp", "degraded")];
    expect(sortByUrgency(input)).not.toBe(input);
  });

  it("leaves the attention group empty when every service is operational", () => {
    expect(groupServices([service("aws", "operational")]).attention).toEqual([]);
    expect(groupServices([]).attention).toEqual([]);
  });

  it("changes which service leads when the data changes", () => {
    const before = groupServices([service("gcp", "degraded"), service("apple", "maintenance")]).attention;
    const after = groupServices([service("gcp", "degraded"), service("apple", "outage")]).attention;
    expect(before[0].id).toBe("gcp");
    expect(after[0].id).toBe("apple");
  });
});

describe("boardHeadline", () => {
  it("reads all clear only when every service is operational", () => {
    expect(boardHeadline(board([service("gcp", "operational")]))).toEqual({
      tone: "operational",
      title: "All systems operational",
    });
  });

  it("names up to two services, then counts", () => {
    expect(boardHeadline(board([service("apple", "outage", "platforms", "Apple")])).title).toBe("Outage: Apple");
    expect(
      boardHeadline(
        board([service("gcp", "degraded", "cloud", "Google Cloud"), service("aws", "degraded", "cloud", "AWS")]),
      ).title,
    ).toBe("Degraded: Google Cloud and AWS");
    expect(
      boardHeadline(board([service("gcp", "degraded"), service("aws", "degraded"), service("steam", "degraded")]))
        .title,
    ).toBe("3 services degraded");
  });

  it("names confirmed breakage before an unreadable source, and says so in the tone", () => {
    const headline = boardHeadline(
      board([service("grok", "unknown", "ai"), service("gcp", "degraded", "cloud", "Google Cloud")]),
    );
    expect(headline).toEqual({ tone: "degraded", title: "Degraded: Google Cloud" });
  });

  it("reports unreadable sources and maintenance when nothing is broken", () => {
    expect(boardHeadline(board([service("grok", "unknown", "ai", "Grok")])).title).toBe("Grok could not be read");
    expect(boardHeadline(board([service("claude", "maintenance", "ai", "Claude")])).title).toBe("Maintenance: Claude");
  });
});

describe("documentTitle and serviceAnchor", () => {
  it("prefixes the tab title with the attention count only when there is one", () => {
    expect(documentTitle(board([service("gcp", "operational")]), "Status Page")).toBe("Status Page");
    expect(documentTitle(board([service("gcp", "degraded"), service("aws", "unknown")]), "Status Page")).toBe(
      "(2) Status Page",
    );
  });

  it("builds a stable element id per service", () => {
    expect(serviceAnchor("cs2-europe")).toBe("service-cs2-europe");
  });

  it("numbers each service by its catalog place, not its place on the board", () => {
    expect(serviceIndex("gcp")).toBe("01");
    expect(serviceIndex("cs2-europe")).toBe("04");
    expect(serviceIndex("apple-os")).toBe("14");
    expect(serviceIndex("nope" as ServiceId)).toBe("");
  });
});

describe("keyboardFocus", () => {
  const element = (visible: boolean) => ({ matches: (selector: string) => selector === ":focus-visible" && visible });

  it("holds for keyboard focus and not for a click", () => {
    expect(keyboardFocus(element(true))).toBe(true);
    expect(keyboardFocus(element(false))).toBe(false);
  });

  it("assumes keyboard focus where :focus-visible is unknown, and ignores non-elements", () => {
    const old = {
      matches: () => {
        throw new SyntaxError("unknown pseudo-class");
      },
    };
    expect(keyboardFocus(old)).toBe(true);
    expect(keyboardFocus(null)).toBe(false);
    expect(keyboardFocus(notAnElement())).toBe(false);
  });
});

function notAnElement(): object {
  return { matches: "not a function" };
}

describe("dockProgress", () => {
  it("rests at 0 until the field reaches the point it starts to move", () => {
    expect(dockProgress(400, 10, 48)).toBe(0);
    expect(dockProgress(58, 10, 48)).toBe(0);
  });

  it("is 1 once the field sits at its stick point", () => {
    expect(dockProgress(10, 10, 48)).toBe(1);
  });

  it("clamps an overscroll bounce at both ends", () => {
    expect(dockProgress(-30, 10, 48)).toBe(1);
    expect(dockProgress(9000, 10, 48)).toBe(0);
  });

  it("is halfway at the middle of the range, eased at both ends", () => {
    expect(dockProgress(34, 10, 48)).toBeCloseTo(0.5, 5);
    // Smoothstep: slower than linear near each pose.
    expect(dockProgress(58 - 4.8, 10, 48)).toBeLessThan(0.1);
    expect(dockProgress(10 + 4.8, 10, 48)).toBeGreaterThan(0.9);
  });

  it("only ever rises as the field climbs", () => {
    let last = -1;
    for (let top = 80; top >= -10; top -= 1) {
      const p = dockProgress(top, 10, 48);
      expect(p).toBeGreaterThanOrEqual(last);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      last = p;
    }
  });
});
