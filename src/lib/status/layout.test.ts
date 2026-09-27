import { describe, expect, it } from "vitest";
import { boardHeadline, documentTitle, groupServices, keyboardFocus, scrolledPast, serviceAnchor } from "./layout";
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
  it("puts every non-operational service first, worst first, keeping catalog order within a severity", () => {
    const groups = groupServices([
      service("gcp", "degraded"),
      service("aws", "operational"),
      service("steam", "maintenance", "gaming"),
      service("apple", "outage", "platforms"),
      service("grok", "unknown", "ai"),
      service("fortnite", "degraded", "gaming"),
      service("mikrotik", "operational", "updates"),
    ]);
    expect(groups.attention.map((s) => s.id)).toEqual(["apple", "grok", "gcp", "fortnite", "steam"]);
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
    expect(documentTitle(board([service("gcp", "operational")]), "Status Bar")).toBe("Status Bar");
    expect(documentTitle(board([service("gcp", "degraded"), service("aws", "unknown")]), "Status Bar")).toBe(
      "(2) Status Bar",
    );
  });

  it("builds a stable element id per service", () => {
    expect(serviceAnchor("cs2-europe")).toBe("service-cs2-europe");
  });
});

describe("scrolledPast", () => {
  const entry = (isIntersecting: boolean, top: number) => ({ isIntersecting, boundingClientRect: { top } });

  it("counts an element as gone only once it has left through the top", () => {
    expect(scrolledPast(entry(false, -120), 64)).toBe(true);
    // Still under the floating bar's strip counts as gone too.
    expect(scrolledPast(entry(false, 40), 64)).toBe(true);
    expect(scrolledPast(entry(true, -10), 64)).toBe(false);
    // Out of view below the fold is not scrolled past.
    expect(scrolledPast(entry(false, 900), 64)).toBe(false);
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
