import { describe, expect, it } from "vitest";
import {
  barShownAt,
  boardHeadline,
  dockProgress,
  documentTitle,
  groupServices,
  incidentLink,
  keyboardFocus,
  serviceAnchor,
  sortByUrgency,
  sortIncidents,
} from "./layout";
import type { BoardSnapshot, CategoryId, Health, Incident, ServiceId, ServiceSnapshot } from "./types";

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
  it("puts what needs a look first, most urgent first, keeping catalog order within a severity", () => {
    const groups = groupServices([
      service("gcp", "degraded"),
      service("aws", "operational"),
      service("steam", "maintenance", "gaming"),
      service("apple", "outage", "platforms"),
      service("grok", "unknown", "ai"),
      service("fortnite", "degraded", "gaming"),
      service("mikrotik", "operational", "updates"),
    ]);
    expect(groups.attention.map((s) => s.id)).toEqual(["apple", "gcp", "fortnite", "steam"]);
    expect(groups.unread.map((s) => s.id)).toEqual(["grok"]);
    expect(groups.operational.map((s) => s.id)).toEqual(["aws"]);
    expect(groups.releases.map((s) => s.id)).toEqual(["mikrotik"]);
  });

  it("lists a release tracker whose source fails as unread, not as attention or a release", () => {
    const groups = groupServices([service("apple-os", "unknown", "updates")]);
    expect(groups.unread.map((s) => s.id)).toEqual(["apple-os"]);
    expect(groups.attention).toEqual([]);
    expect(groups.releases).toEqual([]);
  });

  it("keeps every service in exactly one group", () => {
    const input = [
      service("gcp", "operational"),
      service("aws", "unknown"),
      service("steam", "degraded", "gaming"),
      service("apple", "maintenance", "platforms"),
      service("mikrotik", "operational", "updates"),
    ];
    const groups = groupServices(input);
    const ids = [...groups.attention, ...groups.unread, ...groups.operational, ...groups.releases].map((s) => s.id);
    expect(ids.sort()).toEqual(input.map((s) => s.id).sort());
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

  it("orders outage, degraded, unknown, maintenance", () => {
    const sorted = sortByUrgency([
      service("grok", "unknown"),
      service("steam", "maintenance"),
      service("gcp", "degraded"),
      service("apple", "outage"),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["apple", "gcp", "grok", "steam"]);
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
  it("reads everything is up only when every service is operational", () => {
    expect(boardHeadline(board([service("gcp", "operational")]))).toEqual({
      tone: "operational",
      title: "Everything is up.",
    });
  });

  it("counts what needs a look, in words, with one shape", () => {
    expect(boardHeadline(board([service("apple", "outage", "platforms", "Apple")])).title).toBe(
      "One thing needs a look.",
    );
    expect(boardHeadline(board([service("gcp", "degraded"), service("aws", "degraded")])).title).toBe(
      "Two things need a look.",
    );
    expect(
      boardHeadline(board([service("gcp", "degraded"), service("aws", "degraded"), service("steam", "degraded")]))
        .title,
    ).toBe("Three things need a look.");
  });

  it("takes its tone from the worst thing that needs a look, and never from an unreadable source", () => {
    const headline = boardHeadline(board([service("grok", "unknown", "ai"), service("gcp", "degraded")]));
    expect(headline).toEqual({ tone: "degraded", title: "One thing needs a look." });
    expect(
      boardHeadline(board([service("gcp", "maintenance"), service("aws", "unknown"), service("steam", "outage")])).tone,
    ).toBe("outage");
  });

  it("says nothing needs a look when the only trouble is unreadable sources", () => {
    expect(boardHeadline(board([service("grok", "unknown", "ai", "Grok")]))).toEqual({
      tone: "unknown",
      title: "Nothing needs a look.",
    });
  });

  it("counts maintenance as something to look at", () => {
    expect(boardHeadline(board([service("claude", "maintenance", "ai", "Claude")]))).toEqual({
      tone: "maintenance",
      title: "One thing needs a look.",
    });
  });
});

describe("documentTitle and serviceAnchor", () => {
  it("prefixes the tab title with the number of outages and degradations, and only then", () => {
    expect(documentTitle(board([service("gcp", "operational")]), "Status")).toBe("Status");
    expect(documentTitle(board([service("gcp", "degraded"), service("aws", "outage")]), "Status")).toBe("(2) Status");
  });

  it("does not count an unreadable source or planned maintenance in the tab", () => {
    expect(documentTitle(board([service("gcp", "degraded"), service("aws", "unknown")]), "Status")).toBe("(1) Status");
    expect(
      documentTitle(
        board([service("gcp", "maintenance"), service("aws", "unknown"), service("steam", "unknown")]),
        "Status",
      ),
    ).toBe("Status");
  });

  it("builds a stable element id per service", () => {
    expect(serviceAnchor("cs2-europe")).toBe("service-cs2-europe");
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
  it("rests at 0 until the page reaches the point the field starts to move", () => {
    expect(dockProgress(0, 400, 48)).toBe(0);
    expect(dockProgress(400, 400, 48)).toBe(0);
  });

  it("is 1 once the move is done", () => {
    expect(dockProgress(448, 400, 48)).toBe(1);
  });

  it("clamps an overscroll bounce at both ends", () => {
    expect(dockProgress(-30, 400, 48)).toBe(0);
    expect(dockProgress(9000, 400, 48)).toBe(1);
  });

  it("is halfway at the middle of the range, eased at both ends", () => {
    expect(dockProgress(424, 400, 48)).toBeCloseTo(0.5, 5);
    // Smoothstep: slower than linear near each pose.
    expect(dockProgress(404.8, 400, 48)).toBeLessThan(0.1);
    expect(dockProgress(443.2, 400, 48)).toBeGreaterThan(0.9);
  });

  it("only ever rises as the page scrolls down", () => {
    let last = -1;
    for (let y = 380; y <= 470; y += 1) {
      const p = dockProgress(y, 400, 48);
      expect(p).toBeGreaterThanOrEqual(last);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      last = p;
    }
  });
});

describe("barShownAt", () => {
  it("comes up at its start and not before", () => {
    expect(barShownAt(299, 300, false)).toBe(false);
    expect(barShownAt(300, 300, false)).toBe(true);
  });

  it("stays up until the page is a hysteresis above its start", () => {
    expect(barShownAt(295, 300, true)).toBe(true);
    expect(barShownAt(292, 300, true)).toBe(true);
    expect(barShownAt(291.9, 300, true)).toBe(false);
  });

  it("does not flicker while a finger hovers around the start", () => {
    let shown = false;
    const seen: boolean[] = [];
    for (const y of [296, 300, 297, 301, 294, 299, 293]) {
      shown = barShownAt(y, 300, shown);
      seen.push(shown);
    }
    expect(seen).toEqual([false, true, true, true, true, true, true]);
  });
});

describe("sortIncidents", () => {
  const incident = (id: string, health: Health, startedAt?: string, extra: Partial<Incident> = {}): Incident => ({
    id,
    title: id,
    health,
    startedAt,
    ...extra,
  });

  it("orders by severity, then most recent first", () => {
    const sorted = sortIncidents([
      incident("old-degraded", "degraded", "2026-09-25T06:00:00Z"),
      incident("outage", "outage", "2026-09-25T01:00:00Z"),
      incident("new-degraded", "degraded", "2026-09-25T09:00:00Z"),
      incident("maintenance", "maintenance", "2026-09-25T10:00:00Z"),
      incident("unknown", "unknown", "2026-09-25T10:00:00Z"),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["outage", "new-degraded", "old-degraded", "unknown", "maintenance"]);
  });

  it("puts informational notices after every real problem, whatever their health", () => {
    const sorted = sortIncidents([
      incident("notice", "operational", "2026-09-25T12:00:00Z", { informational: true }),
      incident("maintenance", "maintenance", "2026-09-25T01:00:00Z"),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["maintenance", "notice"]);
  });

  it("falls back to the update time, keeps the vendor's order on a tie, and does not mutate", () => {
    const input = [
      incident("a", "degraded"),
      { ...incident("b", "degraded"), updatedAt: "2026-09-25T05:00:00Z" },
      incident("c", "degraded"),
    ];
    expect(sortIncidents(input).map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(input.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("incidentLink", () => {
  const withIncidents = (sourceUrl: string, incidents: Incident[]): ServiceSnapshot => ({
    ...service("aws", "degraded"),
    sourceUrl,
    incidents,
  });

  it("points at the worst incident that has a page, not the first listed", () => {
    const link = incidentLink(
      withIncidents("https://status.example.com/", [
        { id: "minor", title: "Minor", health: "degraded", url: "https://status.example.com/minor" },
        { id: "major", title: "Major", health: "outage", url: "https://status.example.com/major" },
      ]),
    );
    expect(link).toBe("https://status.example.com/major");
  });

  it("skips a worse incident that has no url", () => {
    const link = incidentLink(
      withIncidents("https://status.example.com/", [
        { id: "major", title: "Major", health: "outage" },
        { id: "minor", title: "Minor", health: "degraded", url: "https://status.example.com/minor" },
      ]),
    );
    expect(link).toBe("https://status.example.com/minor");
  });

  it("offers no incident link when the url is the card's own source page", () => {
    const dashboard = "https://health.aws.amazon.com/health/status";
    expect(incidentLink(withIncidents(dashboard, [{ id: "1", title: "T", health: "degraded", url: dashboard }]))).toBe(
      undefined,
    );
    // A trailing slash or a fragment is still the same page.
    expect(
      incidentLink(
        withIncidents(`${dashboard}/`, [{ id: "1", title: "T", health: "degraded", url: `${dashboard}#x` }]),
      ),
    ).toBe(undefined);
  });

  it("is undefined with no incidents", () => {
    expect(incidentLink(withIncidents("https://status.example.com/", []))).toBe(undefined);
  });
});

describe("release trackers and the board's attention", () => {
  it("a fresh release marks a component, never the tracker: not attention, not the title, not the headline", () => {
    const tracker: ServiceSnapshot = {
      ...service("mikrotik", "operational", "updates"),
      components: [
        { name: "RouterOS 7 stable", health: "maintenance", detail: "7.20.2 · Sep 15" },
        { name: "RouterOS 7 long-term", health: "operational", detail: "7.18.4 · Jul 22" },
      ],
    };
    const snapshot = board([service("gcp", "operational"), tracker]);
    expect(groupServices(snapshot.services).attention).toEqual([]);
    expect(groupServices(snapshot.services).releases.map((item) => item.id)).toEqual(["mikrotik"]);
    expect(documentTitle(snapshot, "Status")).toBe("Status");
    expect(boardHeadline(snapshot)).toEqual({ tone: "operational", title: "Everything is up." });
  });
});
