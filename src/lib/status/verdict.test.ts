import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import type { BoardSnapshot, Health, ServiceSnapshot } from "./types";
import { countWord, verdict } from "./verdict";

/** The real sixteen, every one at `base`, with the given ids set to other states. */
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
  it("spells out zero to sixteen and uses numerals after", () => {
    expect(countWord(1)).toBe("one");
    expect(countWord(12)).toBe("twelve");
    expect(countWord(16)).toBe("sixteen");
    expect(countWord(17)).toBe("17");
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
    expect(CATALOG).toHaveLength(16);
    expect(calm.srSub).toBe("All sixteen services are running normally.");
    expect(calm.short).toBe("Everything is up");
  });
});

const degradedAll = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, "degraded" as Health]));

describe("verdict title, by what is wrong", () => {
  it("counts a single state and agrees the verb", () => {
    expect(verdict(board({ steam: "outage" })).title).toBe("One service is down.");
    expect(verdict(board({ steam: "outage", fortnite: "outage" })).title).toBe("Two services are down.");
    expect(verdict(board({ steam: "degraded" })).title).toBe("One service is degraded.");
    expect(verdict(board({ steam: "degraded", fortnite: "degraded" })).title).toBe("Two services are degraded.");
    expect(verdict(board({ claude: "maintenance" })).title).toBe("One service is in maintenance.");
    expect(verdict(board({ claude: "maintenance", aws: "maintenance" })).title).toBe(
      "Two services are in maintenance.",
    );
    expect(verdict(board(degradedAll("steam", "fortnite", "aws", "gcp", "epic"))).title).toBe(
      "Five services are degraded.",
    );
  });

  it("switches to numerals after sixteen", () => {
    const seventeen = board({}, "outage");
    seventeen.services.push({ ...seventeen.services[0], id: "gcp" });
    expect(verdict(seventeen).title).toBe("17 services are down.");
  });

  it("lists two states in urgency order, each with its own count and verb", () => {
    expect(verdict(board({ steam: "outage", fortnite: "degraded" })).title).toBe("One is down, one is degraded.");
    expect(verdict(board({ steam: "degraded", fortnite: "outage" })).title).toBe("One is down, one is degraded.");
    expect(verdict(board({ steam: "outage", fortnite: "outage", aws: "degraded" })).title).toBe(
      "Two are down, one is degraded.",
    );
    expect(verdict(board({ steam: "outage", fortnite: "degraded", aws: "degraded" })).title).toBe(
      "One is down, two are degraded.",
    );
    expect(verdict(board({ steam: "outage", claude: "maintenance" })).title).toBe(
      "One is down, one is in maintenance.",
    );
    expect(verdict(board({ steam: "degraded", claude: "maintenance", aws: "maintenance" })).title).toBe(
      "One is degraded, two are in maintenance.",
    );
  });

  it("lists three states with an and before the last", () => {
    expect(verdict(board({ steam: "outage", fortnite: "degraded", claude: "maintenance" })).title).toBe(
      "One is down, one is degraded and one is in maintenance.",
    );
    expect(verdict(board({ steam: "outage", fortnite: "outage", aws: "degraded", claude: "maintenance" })).title).toBe(
      "Two are down, one is degraded and one is in maintenance.",
    );
  });

  it("starts with the count word, so the pen underline sits on it", () => {
    for (const result of [
      verdict(board({ steam: "outage" })),
      verdict(board({ steam: "outage", fortnite: "degraded" })),
      verdict(board({ steam: "outage", fortnite: "degraded", claude: "maintenance" })),
    ]) {
      expect(result.title.split(" ")[0]).toMatch(/^(One|Two|Three)$/);
    }
  });
});

describe("verdict short form, for the floating bar", () => {
  it("counts a single state in numerals", () => {
    expect(verdict(board({ steam: "outage", fortnite: "outage" })).short).toBe("2 down");
    expect(verdict(board({ steam: "degraded" })).short).toBe("1 degraded");
    expect(verdict(board({ claude: "maintenance" })).short).toBe("1 in maintenance");
  });

  it("joins the states in urgency order and leaves out the ones at zero", () => {
    expect(verdict(board({ steam: "degraded", fortnite: "outage" })).short).toBe("1 down \u00b7 1 degraded");
    expect(verdict(board({ claude: "maintenance", fortnite: "outage" })).short).toBe("1 down \u00b7 1 in maintenance");
    expect(verdict(board({ claude: "maintenance", steam: "degraded", fortnite: "outage", aws: "outage" })).short).toBe(
      "2 down \u00b7 1 degraded \u00b7 1 in maintenance",
    );
  });
});

describe("verdict when something needs a look", () => {
  it("names the services state by state, worst first, and says the rest are fine", () => {
    const result = verdict(board({ steam: "degraded", fortnite: "outage" }));
    expect(result.sub).toBe("Fortnite is down. Steam is degraded. The other fourteen are running normally.");
    expect(result.count).toBe(2);
    expect(result.tone).toBe("outage");
    expect(result.hand).toBe(false);
    expect(result.srSub).toBe(result.sub);
  });

  it("agrees is and are with the number named in each state", () => {
    expect(verdict(board({ steam: "outage", fortnite: "outage" })).sub).toBe(
      "Steam and Fortnite are down. The other fourteen are running normally.",
    );
    const three = verdict(board({ steam: "outage", fortnite: "degraded", claude: "maintenance" }));
    expect(three.sub).toBe(
      "Steam is down. Fortnite is degraded. Claude is in maintenance. The other thirteen are running normally.",
    );
  });

  it("uses the singular for one other", () => {
    const all = board({}, "degraded");
    all.services[0] = { ...all.services[0], health: "operational" };
    expect(verdict(all).sub).toContain("The other one is running normally.");
  });

  it("names three in a state, then counts the rest", () => {
    expect(verdict(board(degradedAll("steam", "fortnite", "aws"))).sub).toBe(
      "AWS, Steam and Fortnite are degraded. The other thirteen are running normally.",
    );
    expect(verdict(board(degradedAll("steam", "fortnite", "aws", "gcp"))).sub).toBe(
      "GCP, AWS, Steam and 1 more are degraded. The other twelve are running normally.",
    );
    expect(verdict(board(degradedAll("steam", "fortnite", "aws", "gcp", "epic"))).sub).toBe(
      "GCP, AWS, Steam and 2 more are degraded. The other eleven are running normally.",
    );
  });

  it("caps the names per state, not for the whole sentence", () => {
    const result = verdict(
      board({
        ...degradedAll("steam", "fortnite", "aws", "gcp"),
        epic: "outage",
        claude: "outage",
        grok: "outage",
        android: "outage",
        windows: "maintenance",
      }),
    );
    expect(result.title).toBe("Four are down, four are degraded and one is in maintenance.");
    expect(result.sub).toBe(
      "Epic, Android, Grok and 1 more are down. GCP, AWS, Steam and 1 more are degraded. Windows 11 is in maintenance. The other seven are running normally.",
    );
    expect(result.short).toBe("4 down \u00b7 4 degraded \u00b7 1 in maintenance");
  });

  it("drops the sentence about the rest when nothing else is up", () => {
    expect(verdict(board({}, "outage")).sub).toBe("GCP, AWS, Steam and 13 more are down.");
  });

  it("hands the page every service it names, in order, to link", () => {
    const result = verdict(board({ steam: "degraded", fortnite: "outage" }));
    expect(result.subParts.filter((part) => part.id).map((part) => part.id)).toEqual(["fortnite", "steam"]);
    expect(result.subParts.map((part) => part.text).join("")).toBe(result.sub);
  });

  it("adds what it could not read, by name and linked, without counting it", () => {
    const result = verdict(board({ steam: "degraded", grok: "unknown", android: "unknown" }));
    expect(result.sub).toBe(
      "Steam is degraded. The other thirteen are running normally. I couldn't read Android and Grok.",
    );
    expect(result.subParts.filter((part) => part.id).map((part) => part.id)).toEqual(["steam", "android", "grok"]);
    expect(result.count).toBe(1);
    expect(result.tone).toBe("degraded");
    expect(result.title).toBe("One service is degraded.");
    expect(verdict(board({ steam: "degraded", grok: "unknown" })).sub).toBe(
      "Steam is degraded. The other fourteen are running normally. I couldn't read Grok.",
    );
  });

  it("keeps the unread clause after every state, with a mix", () => {
    const result = verdict(board({ steam: "outage", fortnite: "degraded", grok: "unknown" }));
    expect(result.title).toBe("One is down, one is degraded.");
    expect(result.sub).toBe(
      "Steam is down. Fortnite is degraded. The other thirteen are running normally. I couldn't read Grok.",
    );
  });

  it("spells out how many it could not read when there are more than two", () => {
    const result = verdict(board({ steam: "degraded", grok: "unknown", android: "unknown", claude: "unknown" }));
    expect(result.sub).toBe("Steam is degraded. The other twelve are running normally. I couldn't read three of them.");
    expect(result.subParts.filter((part) => part.id).map((part) => part.id)).toEqual(["steam"]);
    expect(result.count).toBe(1);
  });

  it("takes the tone from the worst thing, and counts maintenance", () => {
    expect(verdict(board({ claude: "maintenance" })).tone).toBe("maintenance");
    expect(verdict(board({ claude: "maintenance", aws: "unknown" })).tone).toBe("maintenance");
    expect(verdict(board({ claude: "maintenance", steam: "degraded" })).tone).toBe("degraded");
    expect(verdict(board({ claude: "maintenance", steam: "degraded", aws: "outage" })).tone).toBe("outage");
    expect(verdict(board({ claude: "maintenance" })).count).toBe(1);
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

describe("verdict compact form, for a narrow floating bar", () => {
  it("is the short form for one state", () => {
    expect(verdict(board({ steam: "outage", fortnite: "outage" })).compact).toBe("2 down");
    expect(verdict(board({ steam: "degraded" })).compact).toBe("1 degraded");
    expect(verdict(board({ claude: "maintenance" })).compact).toBe("1 in maintenance");
  });

  it("is the most urgent state and the rest counted for several", () => {
    expect(verdict(board({ steam: "degraded", fortnite: "outage" })).compact).toBe("1 down \u00b7 1 more");
    expect(verdict(board({ claude: "maintenance", steam: "degraded", fortnite: "outage" })).compact).toBe(
      "1 down \u00b7 2 more",
    );
    expect(
      verdict(board({ claude: "maintenance", steam: "degraded", fortnite: "outage", aws: "outage" })).compact,
    ).toBe("2 down \u00b7 2 more");
  });

  it("stays as short as the calm and unread-only forms", () => {
    expect(verdict(board({})).compact).toBe("Everything is up");
    expect(verdict(board({ android: "unknown" })).compact).toBe("Nothing needs a look");
  });
});
