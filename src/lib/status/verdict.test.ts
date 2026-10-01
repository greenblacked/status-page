import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import type { BoardSnapshot, Health, ServiceSnapshot } from "./types";
import { countWord, verdict } from "./verdict";

/** The real fifteen, every one at `base`, with the given ids set to other states. */
function board(overrides: Partial<Record<string, Health>> = {}, base: Health = "operational"): BoardSnapshot {
  const services: ServiceSnapshot[] = CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    shortName: entry.shortName,
    category: entry.category,
    health: overrides[entry.id] ?? base,
    summary: "",
    sourceName: entry.sourceName,
    sourceUrl: entry.sourceUrl,
    checkedAt: "2026-09-30T10:00:00Z",
    latencyMs: 100,
    components: [],
    incidents: [],
  }));
  const counts = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const service of services) counts[service.health] += 1;
  return { generatedAt: "2026-09-30T10:00:00Z", durationMs: 1, services, counts };
}

describe("countWord", () => {
  it("spells out zero to fifteen and uses numerals after", () => {
    expect(countWord(1)).toBe("one");
    expect(countWord(12)).toBe("twelve");
    expect(countWord(15)).toBe("fifteen");
    expect(countWord(16)).toBe("16");
    expect(countWord(-1)).toBe("-1");
  });
});

describe("verdict when everything is up", () => {
  const calm = verdict(board());

  it("says so, with the hand note and no visible sub line", () => {
    expect(calm.title).toBe("Everything is up.");
    expect(calm.tone).toBe("operational");
    expect(calm.hand).toBe(true);
    expect(calm.count).toBe(0);
    expect(calm.sub).toBe("");
    expect(calm.subParts).toEqual([]);
  });

  it("gives a screen reader the sentence the hand note stands for, counted from the catalog", () => {
    expect(CATALOG).toHaveLength(15);
    expect(calm.srSub).toBe("All fifteen services are running normally.");
    expect(calm.short).toBe("Everything is up");
  });
});

describe("verdict when something needs a look", () => {
  it("counts in words and agrees the verb", () => {
    expect(verdict(board({ steam: "degraded" })).title).toBe("One thing needs a look.");
    expect(verdict(board({ steam: "degraded", fortnite: "outage" })).title).toBe("Two things need a look.");
    const many = Object.fromEntries(CATALOG.slice(0, 5).map((entry) => [entry.id, "degraded" as Health]));
    expect(verdict(board(many)).title).toBe("Five things need a look.");
  });

  it("switches to numerals after fifteen", () => {
    const sixteen = board({}, "outage");
    sixteen.services.push({ ...sixteen.services[0], id: "gcp" });
    expect(verdict(sixteen).title).toBe("16 things need a look.");
  });

  it("names the services worst first and says the rest are fine", () => {
    const result = verdict(board({ steam: "degraded", fortnite: "outage" }));
    expect(result.sub).toBe("Fortnite and Steam. The other thirteen are running normally.");
    expect(result.count).toBe(2);
    expect(result.tone).toBe("outage");
    expect(result.hand).toBe(false);
    expect(result.short).toBe("2 need a look");
    expect(result.srSub).toBe(result.sub);
  });

  it("uses the singular for one thing and for one other", () => {
    expect(verdict(board({ steam: "degraded" })).short).toBe("1 needs a look");
    const all = board({}, "degraded");
    all.services[0] = { ...all.services[0], health: "operational" };
    expect(verdict(all).sub).toContain("The other one is running normally.");
  });

  it("names three, then counts the rest", () => {
    expect(verdict(board({ steam: "degraded", fortnite: "degraded", aws: "degraded" })).sub).toBe(
      "AWS, Steam and Fortnite. The other twelve are running normally.",
    );
    expect(verdict(board({ steam: "degraded", fortnite: "degraded", aws: "degraded", gcp: "degraded" })).sub).toBe(
      "GCP, AWS, Steam and 1 more. The other eleven are running normally.",
    );
    const five = board({ steam: "degraded", fortnite: "degraded", aws: "degraded", gcp: "degraded", epic: "degraded" });
    expect(verdict(five).sub).toBe("GCP, AWS, Steam and 2 more. The other ten are running normally.");
  });

  it("drops the second sentence when nothing else is up", () => {
    expect(verdict(board({}, "outage")).sub).toBe("GCP, AWS, Steam and 12 more.");
  });

  it("hands the page every service it names, in order, to link", () => {
    const result = verdict(board({ steam: "degraded", fortnite: "outage" }));
    expect(result.subParts.filter((part) => part.id).map((part) => part.id)).toEqual(["fortnite", "steam"]);
    expect(result.subParts.map((part) => part.text).join("")).toBe(result.sub);
  });

  it("adds what it could not read, by name and linked, without counting it", () => {
    const result = verdict(board({ steam: "degraded", grok: "unknown", android: "unknown" }));
    expect(result.sub).toBe("Steam. The other twelve are running normally. I couldn't read Android and Grok.");
    expect(result.subParts.filter((part) => part.id).map((part) => part.id)).toEqual(["steam", "android", "grok"]);
    expect(result.count).toBe(1);
    expect(result.tone).toBe("degraded");
    expect(verdict(board({ steam: "degraded", grok: "unknown" })).sub).toBe(
      "Steam. The other thirteen are running normally. I couldn't read Grok.",
    );
  });

  it("spells out how many it could not read when there are more than two", () => {
    const result = verdict(board({ steam: "degraded", grok: "unknown", android: "unknown", claude: "unknown" }));
    expect(result.sub).toBe("Steam. The other eleven are running normally. I couldn't read three of them.");
    expect(result.subParts.filter((part) => part.id).map((part) => part.id)).toEqual(["steam"]);
    expect(result.count).toBe(1);
  });

  it("takes the tone from the worst thing, and counts maintenance", () => {
    expect(verdict(board({ claude: "maintenance" })).tone).toBe("maintenance");
    expect(verdict(board({ claude: "maintenance", aws: "unknown" })).tone).toBe("maintenance");
    expect(verdict(board({ claude: "maintenance", steam: "degraded" })).tone).toBe("degraded");
  });
});

describe("verdict when sources could not be read", () => {
  it("does not call it a problem, and names one or two", () => {
    const one = verdict(board({ grok: "unknown" }));
    expect(one.title).toBe("Nothing needs a look.");
    expect(one.tone).toBe("unknown");
    expect(one.count).toBe(0);
    expect(one.hand).toBe(false);
    expect(one.sub).toBe("I couldn't read Grok.");
    expect(one.short).toBe("Nothing needs a look");
    expect(verdict(board({ grok: "unknown", android: "unknown" })).sub).toBe("I couldn't read Android and Grok.");
  });

  it("counts them when there are more than two, and links the ones it names", () => {
    expect(verdict(board({ grok: "unknown", android: "unknown", claude: "unknown" })).sub).toBe(
      "I couldn't read three of them.",
    );
    expect(
      verdict(board({ grok: "unknown", android: "unknown" }))
        .subParts.filter((part) => part.id)
        .map((part) => part.id),
    ).toEqual(["android", "grok"]);
  });
});
