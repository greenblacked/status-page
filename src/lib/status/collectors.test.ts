import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG } from "./catalog.ts";
import { collectAllServices } from "./sources.server.ts";
import type { ServiceId, ServiceSnapshot } from "./types.ts";
import { bytes, json, networkError, stubFetch, text, utf16, type Handler } from "../../test/stub-fetch.ts";

// Vendor endpoints used by src/lib/status/sources.server.ts collectors.
// Keep these in sync with the URLs the collectors actually fetch.
const URLS = {
  gcp: "https://status.cloud.google.com/incidents.json",
  steamServerInfo: "https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/",
  steamFeatured: "https://store.steampowered.com/api/featured/",
  cs2Sdr: "https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=730",
  cs2Players: "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=730",
  epicFortnite: "https://status.epicgames.com/api/v2/summary.json",
  spotify: "https://spotify.statuspage.io/api/v2/summary.json",
  apple: "https://www.apple.com/support/systemstatus/data/system_status_en_US.js",
  android: "https://status.play.google.com/incidents.json",
  chatgpt: "https://status.openai.com/api/v2/summary.json",
  claude: "https://status.claude.com/api/v2/summary.json",
  aws: "https://health.aws.amazon.com/public/currentevents",
  grok: "https://status.x.ai/feed.xml",
  mikrotikUpgrade: "https://upgrade.mikrotik.com/routeros/",
  mikrotikDownload: "https://download.mikrotik.com/routeros/",
  appleOs: "https://developer.apple.com/news/releases/rss/releases.rss",
};

const FIXTURES = new URL("./__fixtures__/", import.meta.url);

function fixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

// The five RouterOS version channel files, each answering `body(file)`.
const MIKROTIK_FILES = [
  "NEWESTa7.stable",
  "NEWESTa7.long-term",
  "NEWESTa7.testing",
  "NEWESTa7.development",
  "NEWESTa6.long-term",
];

function mikrotikChannels(body: (file: string) => string): Record<string, Handler> {
  return Object.fromEntries(MIKROTIK_FILES.map((file) => [`${URLS.mikrotikUpgrade}${file}`, text(body(file))]));
}

// Minimal but shape-correct Statuspage summary.json fixture.
function statuspageSummary(overrides: {
  indicator?: string;
  components?: Array<{ id: string; name: string; status: string; group?: boolean }>;
  incidents?: Array<{ id: string; name: string; status: string; impact?: string }>;
}) {
  return {
    status: { indicator: overrides.indicator ?? "none", description: "All Systems Operational" },
    components: overrides.components ?? [],
    incidents: overrides.incidents ?? [],
    scheduled_maintenances: [],
  };
}

function googleIncident(overrides: Partial<{
  id: string;
  begin: string;
  end: string | null;
  modified: string;
  external_desc: string;
  status_impact: string;
  severity: string;
  service_name: string;
  uri: string;
}>) {
  return {
    id: "incident-1",
    begin: "2026-09-20T00:00:00Z",
    external_desc: "Elevated errors",
    status_impact: "SERVICE_OUTAGE",
    service_name: "Compute Engine",
    uri: "/incidents/incident-1",
    ...overrides,
  };
}

describe("collectAllServices against stubbed vendor payloads", () => {
  beforeEach(() => {
    // A safety net: if a test forgets to call stubFetch, every URL 404s
    // instead of the real global fetch reaching out to the network.
    stubFetch({});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("splits Epic and Fortnite from the same Statuspage summary: a degraded Fortnite leaves Epic operational", async () => {
    const summary = statuspageSummary({
      components: [
        { id: "1", name: "Fortnite", status: "partial_outage" },
        { id: "2", name: "Store", status: "operational" },
      ],
    });
    stubFetch({ [URLS.epicFortnite]: json(summary) });
    const services = await collectAllServices();
    const epic = services.find((s) => s.id === "epic")!;
    const fortnite = services.find((s) => s.id === "fortnite")!;
    expect(epic.health).toBe("operational");
    expect(fortnite.health).toBe("degraded");
  });

  it("splits Epic and Fortnite the other way: a degraded Epic component leaves Fortnite operational", async () => {
    const summary = statuspageSummary({
      components: [
        { id: "1", name: "Fortnite", status: "operational" },
        { id: "2", name: "Accounts", status: "major_outage" },
      ],
    });
    stubFetch({ [URLS.epicFortnite]: json(summary) });
    const services = await collectAllServices();
    const epic = services.find((s) => s.id === "epic")!;
    const fortnite = services.find((s) => s.id === "fortnite")!;
    expect(epic.health).toBe("outage");
    expect(fortnite.health).toBe("operational");
  });

  it("maps plain Statuspage indicators: none/minor/major", async () => {
    stubFetch({
      [URLS.spotify]: json(statuspageSummary({ indicator: "none" })),
      [URLS.chatgpt]: json(statuspageSummary({ indicator: "minor" })),
      [URLS.claude]: json(statuspageSummary({ indicator: "major" })),
    });
    const services = await collectAllServices();
    expect(services.find((s) => s.id === "spotify")!.health).toBe("operational");
    expect(services.find((s) => s.id === "chatgpt")!.health).toBe("degraded");
    expect(services.find((s) => s.id === "claude")!.health).toBe("outage");
  });

  it("maps plain Statuspage indicators: critical/maintenance", async () => {
    stubFetch({
      [URLS.spotify]: json(statuspageSummary({ indicator: "critical" })),
      [URLS.chatgpt]: json(statuspageSummary({ indicator: "maintenance" })),
    });
    const services = await collectAllServices();
    expect(services.find((s) => s.id === "spotify")!.health).toBe("outage");
    expect(services.find((s) => s.id === "chatgpt")!.health).toBe("maintenance");
  });

  it("names the in-progress maintenance on a Statuspage card, even when the vendor sends no description", async () => {
    stubFetch({
      [URLS.claude]: json({
        status: { indicator: "maintenance", description: "" },
        components: [{ id: "c1", name: "claude.ai", status: "under_maintenance" }],
        incidents: [],
        scheduled_maintenances: [{ id: "m1", name: "Database upgrade", status: "in_progress" }],
      }),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "claude")!;
    expect(snapshot.health).toBe("maintenance");
    expect(snapshot.summary).toBe("Database upgrade");
  });

  it("falls back to a generic sentence instead of a blank summary when the description is empty", async () => {
    stubFetch({
      [URLS.chatgpt]: json({ status: { indicator: "minor", description: "" }, components: [], incidents: [], scheduled_maintenances: [] }),
    });
    const services = await collectAllServices();
    expect(services.find((s) => s.id === "chatgpt")!.summary).toBe("Degraded performance on one or more components.");
  });

  it("Google Cloud incidents.json: incident links resolve with or without a leading slash", async () => {
    stubFetch({
      [URLS.gcp]: json([
        googleIncident({ id: "a", uri: "incidents/abc" }),
        googleIncident({ id: "b", uri: "/incidents/def" }),
      ]),
    });
    const services = await collectAllServices();
    const urls = services.find((s) => s.id === "gcp")!.incidents.map((incident) => incident.url);
    expect(urls).toEqual([
      "https://status.cloud.google.com/incidents/abc",
      "https://status.cloud.google.com/incidents/def",
    ]);
  });

  it("Google Cloud incidents.json: only open incidents count, and health worsens with them", async () => {
    stubFetch({
      [URLS.gcp]: json([
        googleIncident({ id: "closed", end: "2026-09-19T00:00:00Z" }),
        googleIncident({ id: "open", status_impact: "SERVICE_OUTAGE" }),
      ]),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "gcp")!;
    expect(snapshot.health).toBe("outage");
    expect(snapshot.incidents).toHaveLength(1);
    expect(snapshot.incidents[0].id).toBe("open");
  });

  it("Google Cloud incidents.json: an ended incident alone is operational", async () => {
    stubFetch({
      [URLS.gcp]: json([googleIncident({ id: "closed", end: "2026-09-19T00:00:00Z" })]),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "gcp")!;
    expect(snapshot.health).toBe("operational");
    expect(snapshot.incidents).toHaveLength(0);
  });

  it("Google Play incidents.json: an ended incident alone is operational", async () => {
    stubFetch({
      [URLS.android]: json([googleIncident({ id: "closed", end: "2026-09-19T00:00:00Z" })]),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "android")!;
    expect(snapshot.health).toBe("operational");
    expect(snapshot.incidents).toHaveLength(0);
  });

  it("Steam: both endpoints returning a well-shaped payload is operational", async () => {
    stubFetch({
      [URLS.steamServerInfo]: json({ servertime: 1758000000 }),
      [URLS.steamFeatured]: json({ featured_win: [{ id: 1 }] }),
    });
    const services = await collectAllServices();
    expect(services.find((s) => s.id === "steam")!.health).toBe("operational");
  });

  it("Steam: one endpoint answering with the wrong shape (still 200) is degraded", async () => {
    stubFetch({
      [URLS.steamServerInfo]: json({ servertime: 1758000000 }),
      [URLS.steamFeatured]: json({ not_featured_win: [] }), // wrong shape, still HTTP 200
    });
    const services = await collectAllServices();
    expect(services.find((s) => s.id === "steam")!.health).toBe("degraded");
  });

  it("Steam: a 503 from one endpoint is degraded, with that endpoint's component non-operational", async () => {
    stubFetch({
      [URLS.steamServerInfo]: json({ servertime: 1758000000 }),
      [URLS.steamFeatured]: text("service unavailable", { status: 503, statusText: "Service Unavailable" }),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("degraded");
    expect(snapshot.components.find((c) => c.name === "Steam Store")).toMatchObject({
      health: "outage",
      detail: "503 Service Unavailable from store.steampowered.com",
    });
    expect(snapshot.components.find((c) => c.name === "Steam Web API")?.health).toBe("operational");
  });

  it("Steam: a network error on one endpoint is degraded, with that endpoint's component non-operational", async () => {
    stubFetch({
      [URLS.steamServerInfo]: networkError(),
      [URLS.steamFeatured]: json({ featured_win: [{ id: 1 }] }),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("degraded");
    expect(snapshot.components.find((c) => c.name === "Steam Web API")?.health).toBe("outage");
    expect(snapshot.components.find((c) => c.name === "Steam Store")?.health).toBe("operational");
  });

  it("Steam: a null body (still 200) on one endpoint is degraded, not a TypeError", async () => {
    stubFetch({
      [URLS.steamServerInfo]: json({ servertime: 1758000000 }),
      [URLS.steamFeatured]: json(null),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("degraded");
    expect(snapshot.components.find((c) => c.name === "Steam Store")?.detail).toBe("Unexpected response shape.");
  });

  it("Steam: a rejection on one endpoint and a wrong shape on the other reports the rejection", async () => {
    stubFetch({
      [URLS.steamServerInfo]: text("service unavailable", { status: 503, statusText: "Service Unavailable" }),
      [URLS.steamFeatured]: json(null),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure).toMatchObject({ kind: "http", status: 503 });
  });

  it("Steam: both endpoints answering with the wrong shape (still 200) is unknown with a parser failure", async () => {
    stubFetch({
      [URLS.steamServerInfo]: json({ servertime: "not-a-number" }),
      [URLS.steamFeatured]: json({ not_featured_win: [] }),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure?.kind).toBe("parser");
  });

  it("Steam: both endpoints returning a 503 is unknown with an http failure", async () => {
    stubFetch({
      [URLS.steamServerInfo]: text("service unavailable", { status: 503, statusText: "Service Unavailable" }),
      [URLS.steamFeatured]: text("service unavailable", { status: 503, statusText: "Service Unavailable" }),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure?.kind).toBe("http");
    expect(snapshot.failure?.status).toBe(503);
  });

  type PopFixture = { desc: string; geo: number[]; relays: Array<{ ipv4: string }> };

  // All 11 codes in sources.server.ts's EU_POPS set, so "N EU pops" fixtures
  // below don't depend on the description/geo fallback matching too.
  const ALL_EU_POP_CODES = ["ams", "fra", "fsn", "hel", "lhr", "mad", "par", "sto", "sto2", "vie", "waw"];

  function euPops(codes: string[], relayingCount: number): Record<string, PopFixture> {
    const pops: Record<string, PopFixture> = {};
    codes.forEach((code, index) => {
      pops[code] = {
        desc: `${code.toUpperCase()} Europe`,
        geo: [10, 50],
        relays: index < relayingCount ? [{ ipv4: "1.2.3.4" }] : [],
      };
    });
    return pops;
  }

  describe("CS2 Europe", () => {
    it("11 EU pops, 4 relaying, is degraded (below 40%)", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: euPops(ALL_EU_POP_CODES, 4) }),
        [URLS.cs2Players]: json({ response: { player_count: 500000, result: 1 } }),
      });
      const services = await collectAllServices();
      expect(services.find((s) => s.id === "cs2-europe")!.health).toBe("degraded");
    });

    it("11 EU pops, 5 relaying, is operational (pins the 40% threshold)", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: euPops(ALL_EU_POP_CODES, 5) }),
        [URLS.cs2Players]: json({ response: { player_count: 500000, result: 1 } }),
      });
      const services = await collectAllServices();
      expect(services.find((s) => s.id === "cs2-europe")!.health).toBe("operational");
    });

    it("5 EU pops, 3 relaying, is operational", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: euPops(ALL_EU_POP_CODES.slice(0, 5), 3) }),
        [URLS.cs2Players]: json({ response: { player_count: 500000, result: 1 } }),
      });
      const services = await collectAllServices();
      const snapshot = services.find((s) => s.id === "cs2-europe")!;
      expect(snapshot.health).toBe("operational");
      expect(snapshot.meta?.euWithRelays).toBe(3);
    });

    it("5 EU pops, 2 relaying, is degraded (pins the absolute floor of 3)", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: euPops(ALL_EU_POP_CODES.slice(0, 5), 2) }),
        [URLS.cs2Players]: json({ response: { player_count: 500000, result: 1 } }),
      });
      const services = await collectAllServices();
      expect(services.find((s) => s.id === "cs2-europe")!.health).toBe("degraded");
    });

    it("excludes a non-European pop from the European count", async () => {
      const pops: Record<string, PopFixture> = euPops(ALL_EU_POP_CODES.slice(0, 5), 5);
      pops.iad = { desc: "Sterling (Washington DC)", geo: [-77.5, 39.0], relays: [{ ipv4: "5.6.7.8" }] };
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops }),
        [URLS.cs2Players]: json({ response: { player_count: 500000, result: 1 } }),
      });
      const services = await collectAllServices();
      const snapshot = services.find((s) => s.id === "cs2-europe")!;
      expect(snapshot.meta?.euPops).toBe(5);
      expect(snapshot.components.some((c) => c.name === "Sterling (Washington DC)")).toBe(false);
    });

    it("is an outage when the relay config reports failure", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: false, pops: euPops(ALL_EU_POP_CODES, 11) }),
        [URLS.cs2Players]: json({ response: { player_count: 500000, result: 1 } }),
      });
      const services = await collectAllServices();
      expect(services.find((s) => s.id === "cs2-europe")!.health).toBe("outage");
    });

    it("is an outage when no European pops are listed", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: {} }),
        [URLS.cs2Players]: json({ response: { player_count: 500000, result: 1 } }),
      });
      const services = await collectAllServices();
      expect(services.find((s) => s.id === "cs2-europe")!.health).toBe("outage");
    });

    it("stays operational without a player count when that endpoint has a network error", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: euPops(ALL_EU_POP_CODES.slice(0, 5), 5) }),
        [URLS.cs2Players]: networkError(),
      });
      const services = await collectAllServices();
      const snapshot = services.find((s) => s.id === "cs2-europe")!;
      expect(snapshot.health).toBe("operational");
      expect(snapshot.summary).not.toContain("playing");
      expect(snapshot.meta?.players).toBe(0);
    });

    it("ignores a player count that is not a number", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: euPops(ALL_EU_POP_CODES.slice(0, 5), 5) }),
        [URLS.cs2Players]: json({ response: { player_count: "lots", result: 1 } }),
      });
      const services = await collectAllServices();
      const snapshot = services.find((s) => s.id === "cs2-europe")!;
      expect(snapshot.health).toBe("operational");
      expect(snapshot.meta?.players).toBe(0);
    });

    it("an SDR-healthy card stays operational when the player count endpoint 503s", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: euPops(ALL_EU_POP_CODES.slice(0, 5), 5) }),
        [URLS.cs2Players]: text("service unavailable", { status: 503, statusText: "Service Unavailable" }),
      });
      const services = await collectAllServices();
      const snapshot = services.find((s) => s.id === "cs2-europe")!;
      expect(snapshot.health).toBe("operational");
    });

    it("an SDR-healthy card stays operational when the player count body is null", async () => {
      stubFetch({
        [URLS.cs2Sdr]: json({ success: true, pops: euPops(ALL_EU_POP_CODES.slice(0, 5), 5) }),
        [URLS.cs2Players]: json(null),
      });
      const services = await collectAllServices();
      const snapshot = services.find((s) => s.id === "cs2-europe")!;
      expect(snapshot.health).toBe("operational");
    });
  });

  it("Apple: an active event makes that service's component non-operational, with a millisecond epoch preserved", async () => {
    const epochMs = 1693440600000; // 13-digit ms epoch; a *1000 regression would push this decades into the future
    stubFetch({
      [URLS.apple]: json({
        services: [
          {
            serviceName: "iCloud Mail",
            events: [
              {
                eventStatus: "ongoing",
                statusType: "outage",
                message: "Some users are affected",
                epochStartDate: epochMs,
                datePosted: "2026-08-30 12:30:00 UTC",
              },
            ],
          },
          {
            serviceName: "App Store",
            events: [],
          },
        ],
      }),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "apple")!;
    expect(snapshot.health).toBe("outage");
    // statusType "outage" maps to Health "outage" (see appleEventHealth).
    expect(snapshot.components.find((c) => c.name === "iCloud Mail")?.health).toBe("outage");
    // Only services with an active event get a component; App Store, whose
    // events array is empty, must not appear.
    expect(snapshot.components.map((c) => c.name)).toEqual(["iCloud Mail"]);
    expect(snapshot.incidents[0].startedAt).toBe(new Date(epochMs).toISOString());
  });

  it("a vendor returning HTTP 403 marks the service unknown with an http failure naming the vendor host", async () => {
    stubFetch({
      [URLS.spotify]: text("Forbidden", { status: 403, statusText: "Forbidden" }),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "spotify")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure?.kind).toBe("http");
    expect(snapshot.failure?.status).toBe(403);
    expect(snapshot.summary).toContain("spotify.statuspage.io");
    expect(snapshot.summary).not.toContain("/api/v2/summary.json");

    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls;
    const failureLine = warnCalls.map((call) => String(call[0])).find((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.event === "collector_failed" && parsed.service === "spotify";
      } catch {
        return false;
      }
    });
    expect(failureLine).toBeDefined();
  });

  // A catalog entry without a collector would otherwise ship a card that
  // never appears, and a collector without an entry would crash base().
  it("returns exactly one snapshot per catalog entry, in catalog order, even when every vendor is down", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    const services = await collectAllServices();
    expect(services.map((s) => s.id)).toEqual(CATALOG.map((entry) => entry.id));
    for (const snapshot of services) {
      expect(snapshot, snapshot.id).toMatchObject({ health: "unknown", failure: { kind: "network" } });
    }
  });

  it("a payload that parses but has the wrong shape is a parser failure", async () => {
    // Valid JSON, but not an array: googleIncidents iterates with .filter,
    // which does not exist on a plain object, so a TypeError escapes the
    // collector and classifyFailure reports it as "parser".
    stubFetch({
      [URLS.gcp]: json({ not: "an array" }),
    });
    const services = await collectAllServices();
    const snapshot = services.find((s) => s.id === "gcp")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure?.kind).toBe("parser");
  });

  // Whole payloads shaped like each vendor's real response, trimmed to a few
  // items, rather than the one-field objects above. __fixtures__/README.md
  // says where each comes from and how to refresh it.
  describe("vendor payload fixtures", () => {
    // The fixtures' dates are fixed, so pin the clock inside the collectors'
    // 14-day windows. Only Date is faked: fetchText's abort timer stays real.
    // Every timestamp sits near noon UTC, so the "Sep 18" style dates on the
    // cards read the same in any time zone from UTC-11 to UTC+11.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function collect(id: ServiceId): Promise<ServiceSnapshot> {
      const snapshot = (await collectAllServices()).find((s) => s.id === id);
      if (!snapshot) throw new Error(`no snapshot for ${id}`);
      return snapshot;
    }

    it("AWS currentevents: only the fresh, unresolved event is active, as regional impact", async () => {
      stubFetch({ [URLS.aws]: bytes(utf16(fixture("aws/currentevents.json"))) });
      const aws = await collect("aws");
      expect(aws.failure).toBeUndefined();
      expect(aws.health).toBe("degraded");
      expect(aws.summary).toBe("Amazon Elastic Compute Cloud — Increased API Error Rates");
      // The Lambda event reports resolved and the CloudFront one is 30 days
      // old, so neither shows up as a component or an incident.
      expect(aws.components).toEqual([
        { name: "Amazon Elastic Compute Cloud (N. Virginia)", health: "degraded", detail: "Increased API Error Rates" },
      ]);
      expect(aws.incidents).toEqual([
        {
          id: "arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/AWS_EC2_OPERATIONAL_ISSUE_4E7B1C2D9A0F",
          title: "Amazon Elastic Compute Cloud — Increased API Error Rates",
          health: "degraded",
          startedAt: "2026-09-20T10:00:00.000Z",
          updatedAt: "2026-09-20T11:00:00.000Z",
          url: "https://health.aws.amazon.com/health/status",
        },
      ]);
      expect(aws.meta).toEqual({ publicEvents: 3, active: 1 });
    });

    it("AWS currentevents: a truncated payload is unknown with a parser failure", async () => {
      const truncated = fixture("aws/currentevents.json").slice(0, 400);
      stubFetch({ [URLS.aws]: bytes(utf16(truncated)) });
      const aws = await collect("aws");
      expect(aws.health).toBe("unknown");
      expect(aws.failure?.kind).toBe("parser");
      expect(aws.components).toEqual([]);
      expect(aws.incidents).toEqual([]);
    });

    it("Grok feed.xml: a recent unresolved item is an incident; resolved and stale items are not", async () => {
      stubFetch({ [URLS.grok]: text(fixture("grok/feed.xml")) });
      const grok = await collect("grok");
      expect(grok.failure).toBeUndefined();
      expect(grok.health).toBe("degraded");
      expect(grok.summary).toBe("Elevated error rates on Grok & the xAI API");
      expect(grok.components).toEqual([]);
      expect(grok.incidents).toEqual([
        {
          id: "https://status.x.ai/incidents/01K5R8Q2V7M3",
          title: "Elevated error rates on Grok & the xAI API",
          health: "degraded",
          startedAt: "2026-09-20T09:30:00.000Z",
          url: "https://status.x.ai/incidents/01K5R8Q2V7M3",
        },
      ]);
      expect(grok.meta).toBeUndefined();
    });

    it("Grok feed.xml: a feed with no RSS items (an Atom feed) is unknown with a parser failure", async () => {
      stubFetch({
        [URLS.grok]: text(
          '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>xAI Status</title>' +
            "<entry><title>Elevated errors</title></entry></feed>",
        ),
      });
      const grok = await collect("grok");
      expect(grok.health).toBe("unknown");
      expect(grok.failure).toEqual({ kind: "parser", message: "Grok feed returned no readable items." });
      expect(grok.summary).toBe("Grok feed returned no readable items.");
      expect(grok.incidents).toEqual([]);
    });

    it("MikroTik: every channel becomes a component, and the newest release's CHANGELOG is the summary", async () => {
      stubFetch({
        ...mikrotikChannels((file) => fixture(`mikrotik/${file}`)),
        [`${URLS.mikrotikDownload}7.21beta4/CHANGELOG`]: text(fixture("mikrotik/7.21beta4/CHANGELOG")),
      });
      const mikrotik = await collect("mikrotik");
      expect(mikrotik.failure).toBeUndefined();
      expect(mikrotik.health).toBe("operational");
      expect(mikrotik.summary).toBe(
        "What's new in 7.21beta4 (2026-Sep-19 12:00) — bgp - fixed route refresh handling when the peer restarts",
      );
      // Released within 14 days reads as "maintenance": a fresh release is
      // worth a look, not an all-clear.
      expect(mikrotik.components).toEqual([
        { name: "RouterOS 7 stable", health: "maintenance", detail: "7.20.2 · Sep 15" },
        { name: "RouterOS 7 long-term", health: "operational", detail: "7.18.4 · Jul 22" },
        { name: "RouterOS 7 testing", health: "maintenance", detail: "7.21beta3 · Sep 17" },
        { name: "RouterOS 7 development", health: "maintenance", detail: "7.21beta4 · Sep 19" },
        { name: "RouterOS 6 long-term", health: "operational", detail: "6.49.19 · Mar 3" },
      ]);
      expect(mikrotik.incidents).toEqual([]);
      expect(mikrotik.meta).toEqual({
        latest: "7.20.2",
        versions:
          "RouterOS 7 stable=7.20.2|RouterOS 7 long-term=7.18.4|RouterOS 7 testing=7.21beta3|" +
          "RouterOS 7 development=7.21beta4|RouterOS 6 long-term=6.49.19",
      });
    });

    it("MikroTik: channel files that answer but hold no version are unknown with a parser failure", async () => {
      stubFetch(mikrotikChannels(() => "\n"));
      const mikrotik = await collect("mikrotik");
      expect(mikrotik.health).toBe("unknown");
      expect(mikrotik.failure).toEqual({
        kind: "parser",
        message: "MikroTik answered 5 version channel(s) in an unrecognised format.",
      });
      expect(mikrotik.components).toEqual([]);
      expect(mikrotik.meta).toBeUndefined();
    });

    it("Apple Developer Releases: the newest item per OS family, in family order, headed by the latest", async () => {
      stubFetch({ [URLS.appleOs]: text(fixture("apple-os/releases.rss")) });
      const appleOs = await collect("apple-os");
      expect(appleOs.failure).toBeUndefined();
      expect(appleOs.health).toBe("operational");
      expect(appleOs.summary).toBe("Latest: iOS 26.1 beta 2 (23B5059e) · Sep 18");
      // Xcode is not an OS and is skipped; the older iOS 26.0.1 loses to the
      // beta listed above it; visionOS is older than 14 days.
      expect(appleOs.components).toEqual([
        { name: "iOS", health: "maintenance", detail: "26.1 beta 2 (23B5059e) · Sep 18" },
        { name: "iPadOS", health: "maintenance", detail: "26.1 beta 2 (23B5059e) · Sep 18" },
        { name: "macOS", health: "maintenance", detail: "Tahoe 26.1 beta 2 (25B5042k) · Sep 18" },
        { name: "watchOS", health: "maintenance", detail: "26.0.1 (23R356) · Sep 14" },
        { name: "tvOS", health: "maintenance", detail: "26.0.1 (23J583) · Sep 14" },
        { name: "visionOS", health: "operational", detail: "26.0 (23M336) · Aug 21" },
      ]);
      expect(appleOs.incidents).toEqual([]);
      expect(appleOs.meta).toEqual({
        latest: "iOS 26.1 beta 2 (23B5059e)",
        versions:
          "iOS=26.1 beta 2 (23B5059e)|iPadOS=26.1 beta 2 (23B5059e)|macOS=Tahoe 26.1 beta 2 (25B5042k)|" +
          "watchOS=26.0.1 (23R356)|tvOS=26.0.1 (23J583)|visionOS=26.0 (23M336)",
      });
    });

    it("Apple Developer Releases: a page with no OS items is unknown with a parser failure", async () => {
      stubFetch({
        [URLS.appleOs]: text("<!DOCTYPE html><html><head><title>Apple Developer</title></head><body>We'll be back soon.</body></html>"),
      });
      const appleOs = await collect("apple-os");
      expect(appleOs.health).toBe("unknown");
      expect(appleOs.failure).toEqual({ kind: "parser", message: "Apple OS release feed had no OS items." });
      expect(appleOs.components).toEqual([]);
    });
  });
});
