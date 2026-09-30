import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, type Handler, json, networkError, stubFetch, text, utf16 } from "../../test/stub-fetch.ts";
import { CATALOG } from "./catalog.ts";
import { collectAllServices } from "./sources.server.ts";
import type { ServiceId, ServiceSnapshot } from "./types.ts";

// Vendor endpoints used by src/lib/status/sources.server.ts collectors.
// Keep these in sync with the URLs the collectors actually fetch.
const URLS = {
  gcp: "https://status.cloud.google.com/incidents.json",
  gcpProducts: "https://status.cloud.google.com/products.json",
  androidProducts: "https://status.play.google.com/products.json",
  steamCm: "https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0",
  grokComponents: "https://status.x.ai/v2/components.json",
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
  components?: Array<{
    id: string;
    name: string;
    status: string;
    group?: boolean;
    group_id?: string | null;
    position?: number;
  }>;
  incidents?: Array<{ id: string; name: string; status: string; impact?: string }>;
}) {
  return {
    status: { indicator: overrides.indicator ?? "none", description: "All Systems Operational" },
    components: overrides.components ?? [],
    incidents: overrides.incidents ?? [],
    scheduled_maintenances: [],
  };
}

function googleIncident(
  overrides: Partial<{
    id: string;
    begin: string;
    end: string | null;
    modified: string;
    external_desc: string;
    status_impact: string;
    severity: string;
    service_name: string;
    uri: string;
    affected_products: Array<{ id?: string; title?: string }>;
  }>,
) {
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
      [URLS.chatgpt]: json({
        status: { indicator: "minor", description: "" },
        components: [],
        incidents: [],
        scheduled_maintenances: [],
      }),
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
    // The payload lists every service: the one with an active event comes
    // first, the quiet one (empty events array) follows as operational.
    expect(snapshot.components).toEqual([
      { name: "iCloud Mail", health: "outage", detail: "Some users are affected" },
      { name: "App Store", health: "operational" },
    ]);
    expect(snapshot.incidents[0].startedAt).toBe(new Date(epochMs).toISOString());
  });

  it("Statuspage: a healthy vendor lists every leaf component in the vendor's order, groups excluded", async () => {
    const summary = statuspageSummary({
      components: [
        { id: "g", name: "APIs (group)", status: "operational", group: true },
        { id: "1", name: "Chat", status: "operational", group_id: "g" },
        { id: "2", name: "Login", status: "operational", group_id: "g" },
        { id: "3", name: "Files", status: "operational", group_id: "g" },
      ],
    });
    stubFetch({ [URLS.chatgpt]: json(summary) });
    const chatgpt = (await collectAllServices()).find((s) => s.id === "chatgpt")!;
    expect(chatgpt.health).toBe("operational");
    expect(chatgpt.components).toEqual([
      { name: "Chat", health: "operational" },
      { name: "Login", health: "operational" },
      { name: "Files", health: "operational" },
    ]);
    expect("componentCount" in chatgpt).toBe(false);
  });

  it("Statuspage: per-group positions do not interleave groups; the page order is kept", async () => {
    // Statuspage numbers `position` within each group, so both groups have a
    // child at 1 and 2. The array is already in page order.
    const summary = statuspageSummary({
      components: [
        { id: "ga", name: "Group A", status: "operational", group: true },
        { id: "a1", name: "A one", status: "operational", group_id: "ga", position: 1 },
        { id: "a2", name: "A two", status: "operational", group_id: "ga", position: 2 },
        { id: "gb", name: "Group B", status: "operational", group: true },
        { id: "b1", name: "B one", status: "operational", group_id: "gb", position: 1 },
        { id: "b2", name: "B two", status: "operational", group_id: "gb", position: 2 },
      ],
    });
    stubFetch({ [URLS.chatgpt]: json(summary) });
    const chatgpt = (await collectAllServices()).find((s) => s.id === "chatgpt")!;
    expect(chatgpt.components.map((c) => c.name)).toEqual(["A one", "A two", "B one", "B two"]);
  });

  it("Statuspage: non-operational components lead, then operational ones, each in the vendor's order", async () => {
    const summary = statuspageSummary({
      indicator: "minor",
      components: [
        { id: "1", name: "Chat", status: "operational" },
        { id: "2", name: "Login", status: "degraded_performance" },
        { id: "3", name: "Files", status: "operational" },
        { id: "4", name: "Voice", status: "major_outage" },
      ],
    });
    stubFetch({ [URLS.claude]: json(summary) });
    const claude = (await collectAllServices()).find((s) => s.id === "claude")!;
    expect(claude.components.map((c) => [c.name, c.health])).toEqual([
      ["Login", "degraded"],
      ["Voice", "outage"],
      ["Chat", "operational"],
      ["Files", "operational"],
    ]);
  });

  it("Statuspage: a huge page is capped at 24 components, and a broken one past the cap still leads", async () => {
    const components = Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      name: `Component ${i}`,
      status: i === 55 ? "partial_outage" : "operational",
    }));
    stubFetch({ [URLS.spotify]: json(statuspageSummary({ indicator: "minor", components })) });
    const spotify = (await collectAllServices()).find((s) => s.id === "spotify")!;
    expect(spotify.components).toHaveLength(24);
    expect(spotify.componentCount).toBe(60);
    expect(spotify.components[0]).toEqual({ name: "Component 55", health: "degraded" });
    expect(spotify.components.slice(1).map((c) => c.name)).toEqual(
      Array.from({ length: 23 }, (_, i) => `Component ${i}`),
    );
  });

  it("Statuspage: a vendor page with no component list returns no components", async () => {
    stubFetch({ [URLS.chatgpt]: json(statuspageSummary({ components: [] })) });
    const chatgpt = (await collectAllServices()).find((s) => s.id === "chatgpt")!;
    expect(chatgpt.components).toEqual([]);
  });

  it("Epic and Fortnite list only their own leaf components, never the group rows", async () => {
    const summary = statuspageSummary({
      components: [
        { id: "g1", name: "Fortnite", status: "partial_outage", group: true },
        { id: "1", name: "Fortnite Matchmaking", status: "partial_outage", group_id: "g1" },
        { id: "2", name: "Fortnite Store", status: "operational", group_id: "g1" },
        { id: "g2", name: "Platform", status: "operational", group: true },
        { id: "3", name: "Accounts", status: "operational", group_id: "g2" },
      ],
    });
    stubFetch({ [URLS.epicFortnite]: json(summary) });
    const services = await collectAllServices();
    const epic = services.find((s) => s.id === "epic")!;
    const fortnite = services.find((s) => s.id === "fortnite")!;
    expect(epic.health).toBe("operational");
    expect(epic.components).toEqual([{ name: "Accounts", health: "operational" }]);
    expect(fortnite.health).toBe("degraded");
    expect(fortnite.components).toEqual([
      { name: "Fortnite Matchmaking", health: "degraded" },
      { name: "Fortnite Store", health: "operational" },
    ]);
  });

  it("Epic and Fortnite split by group name when the children have plain names", async () => {
    // As on status.epicgames.com: the children of the "Fortnite" group are
    // named Login, Matchmaking..., and only the group row says Fortnite.
    const summary = statuspageSummary({
      components: [
        { id: "g1", name: "Fortnite", status: "operational", group: true },
        { id: "1", name: "Login", status: "operational", group_id: "g1" },
        { id: "2", name: "Matchmaking", status: "partial_outage", group_id: "g1" },
        { id: "g2", name: "Epic Games Store", status: "operational", group: true },
        { id: "3", name: "Login", status: "operational", group_id: "g2" },
        { id: "4", name: "Purchasing", status: "major_outage", group_id: "g2" },
        { id: "5", name: "Rocket League", status: "operational" },
      ],
    });
    stubFetch({ [URLS.epicFortnite]: json(summary) });
    const services = await collectAllServices();
    const epic = services.find((s) => s.id === "epic")!;
    const fortnite = services.find((s) => s.id === "fortnite")!;
    expect(fortnite.components).toEqual([
      { name: "Matchmaking", health: "degraded" },
      { name: "Login", health: "operational" },
    ]);
    expect(fortnite.health).toBe("degraded");
    expect(epic.components).toEqual([
      { name: "Purchasing", health: "outage" },
      { name: "Login", health: "operational" },
      { name: "Rocket League", health: "operational" },
    ]);
    expect(epic.health).toBe("outage");
  });

  it("Apple: every service is a component, active ones first, capped at 24", async () => {
    const services = Array.from({ length: 30 }, (_, i) => ({
      serviceName: `Service ${i}`,
      events:
        i === 28
          ? [{ eventStatus: "ongoing", statusType: "issue", message: "Slow", epochStartDate: 1693440600000 }]
          : [{ eventStatus: "resolved", statusType: "outage", message: "Back", epochStartDate: 1693440600000 }],
    }));
    stubFetch({ [URLS.apple]: json({ services }) });
    const apple = (await collectAllServices()).find((s) => s.id === "apple")!;
    expect(apple.health).toBe("degraded");
    expect(apple.components).toHaveLength(24);
    expect(apple.componentCount).toBe(30);
    expect(apple.components[0]).toMatchObject({ name: "Service 28", health: "degraded" });
    expect(apple.components.slice(1).every((c) => c.health === "operational")).toBe(true);
    expect(apple.components[1].name).toBe("Service 0");
    expect(apple.meta).toEqual({ services: 30 });
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
    const failureLine = warnCalls
      .map((call) => String(call[0]))
      .find((line) => {
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
    // Card dates such as "Sep 21" are formatted in vitest.config.ts's UTC.
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
        { name: "Amazon Elastic Compute Cloud", health: "degraded", detail: "Increased API Error Rates" },
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
      // A real feed, trimmed. This clock keeps the Sep 21 betas inside the
      // 14-day window and puts the Sep 14 releases just outside it.
      vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
      stubFetch({ [URLS.appleOs]: text(fixture("apple-os/releases.rss")) });
      const appleOs = await collect("apple-os");
      expect(appleOs.failure).toBeUndefined();
      expect(appleOs.health).toBe("operational");
      expect(appleOs.summary).toBe("Latest: iOS 27.2 beta 2 (24B5089g) · Sep 21");
      // TestFlight and Xcode are not OS releases and are skipped; iOS 27.0
      // loses to the beta listed above it; visionOS's newest item is the
      // Sep 14 release, now older than 14 days.
      expect(appleOs.components).toEqual([
        { name: "iOS", health: "maintenance", detail: "27.2 beta 2 (24B5089g) · Sep 21" },
        { name: "iPadOS", health: "maintenance", detail: "27.2 beta 2 (24B5089g) · Sep 21" },
        { name: "macOS", health: "maintenance", detail: "27.2 beta 2 (26B5091g) · Sep 21" },
        { name: "watchOS", health: "maintenance", detail: "27.2 beta 2 (24S5091f) · Sep 21" },
        { name: "tvOS", health: "maintenance", detail: "27.2 beta 2 (24K5093g) · Sep 21" },
        { name: "visionOS", health: "operational", detail: "27.0 (24M362) · Sep 14" },
      ]);
      expect(appleOs.incidents).toEqual([]);
      expect(appleOs.meta).toEqual({
        latest: "iOS 27.2 beta 2 (24B5089g)",
        versions:
          "iOS=27.2 beta 2 (24B5089g)|iPadOS=27.2 beta 2 (24B5089g)|macOS=27.2 beta 2 (26B5091g)|" +
          "watchOS=27.2 beta 2 (24S5091f)|tvOS=27.2 beta 2 (24K5093g)|visionOS=27.0 (24M362)",
      });
    });

    it("Apple Developer Releases: a page with no OS items is unknown with a parser failure", async () => {
      stubFetch({
        [URLS.appleOs]: text(
          "<!DOCTYPE html><html><head><title>Apple Developer</title></head><body>We'll be back soon.</body></html>",
        ),
      });
      const appleOs = await collect("apple-os");
      expect(appleOs.health).toBe("unknown");
      expect(appleOs.failure).toEqual({ kind: "parser", message: "Apple OS release feed had no OS items." });
      expect(appleOs.components).toEqual([]);
    });
  });

  // Component lists for the vendors whose main feed names none. The payloads
  // under __fixtures__ are hand-written from the documented shapes (see the
  // fixtures README); the clock is pinned like the fixtures block above.
  describe("component lists", () => {
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

    const googleProducts = (count: number) => ({
      products: Array.from({ length: count }, (_, i) => ({ title: `Product ${i}`, id: `p${i}` })),
    });

    describe("Google Cloud products.json", () => {
      it("lists every product; open incidents degrade the products they name, the worst one wins", async () => {
        stubFetch({
          [URLS.gcp]: text(fixture("gcp/incidents.json")),
          [URLS.gcpProducts]: text(fixture("gcp/products.json")),
        });
        const gcp = await collect("gcp");
        expect(gcp.failure).toBeUndefined();
        // The overall status is the incidents' alone, as before.
        expect(gcp.health).toBe("outage");
        expect(gcp.componentCount).toBeUndefined();
        expect(gcp.components).toEqual([
          { name: "Google Compute Engine", health: "outage", detail: "Belgium (europe-west1)" },
          { name: "Cloud Run", health: "degraded", detail: "Elevated latency for new deployments" },
          // SERVICE_INFORMATION is a notice: operational, with its title.
          { name: "Google Cloud Storage", health: "operational", detail: "Billing export schema change on Sep 30" },
          { name: "Cloud Build", health: "operational" },
          { name: "Cloud SQL", health: "operational" },
          // Its only incident has ended.
          { name: "BigQuery", health: "operational" },
          { name: "Google Cloud Pub/Sub", health: "operational" },
          { name: "Vertex AI", health: "operational" },
        ]);
      });

      it("adds an affected product the catalogue does not list, and matches by title when ids differ", async () => {
        stubFetch({
          [URLS.gcp]: json([
            googleIncident({
              id: "a",
              status_impact: "SERVICE_DISRUPTION",
              affected_products: [
                { title: "cloud build", id: "renamed" },
                { title: "Cloud Armor", id: "armor" },
              ],
            }),
          ]),
          [URLS.gcpProducts]: json({ products: [{ title: "Cloud Build" }] }),
        });
        const gcp = await collect("gcp");
        expect(gcp.components).toEqual([
          { name: "Cloud Build", health: "degraded", detail: "Elevated errors" },
          { name: "Cloud Armor", health: "degraded", detail: "Elevated errors" },
        ]);
      });

      it("keeps the per-incident components when the catalogue is empty", async () => {
        stubFetch({
          [URLS.gcp]: text(fixture("gcp/incidents.json")),
          [URLS.gcpProducts]: json({ products: [] }),
        });
        const gcp = await collect("gcp");
        expect(gcp.components.map((c) => c.name)).toEqual([
          "Google Compute Engine",
          "Cloud Run",
          "Google Cloud Storage",
        ]);
      });

      it("keeps the per-incident components when the catalogue is malformed", async () => {
        for (const body of [json("nope"), json({ products: "x" }), json(null), text("<html>blocked</html>")]) {
          stubFetch({ [URLS.gcp]: text(fixture("gcp/incidents.json")), [URLS.gcpProducts]: body });
          const gcp = await collect("gcp");
          expect(gcp.failure).toBeUndefined();
          expect(gcp.components).toHaveLength(3);
        }
      });

      it("caps a long catalogue at 24 with the broken product first and reports the total", async () => {
        stubFetch({
          [URLS.gcp]: json([
            googleIncident({
              status_impact: "SERVICE_OUTAGE",
              affected_products: [{ title: "Product 40", id: "p40" }],
            }),
          ]),
          [URLS.gcpProducts]: json(googleProducts(45)),
        });
        const gcp = await collect("gcp");
        expect(gcp.components).toHaveLength(24);
        expect(gcp.componentCount).toBe(45);
        expect(gcp.components[0]).toEqual({ name: "Product 40", health: "outage", detail: "Elevated errors" });
        expect(gcp.components[1].name).toBe("Product 0");
      });

      it("a catalogue that fails (404, 503, network error) leaves the card and its status intact", async () => {
        const incidents = json([googleIncident({ status_impact: "SERVICE_DISRUPTION" })]);
        for (const products of [
          undefined,
          text("Unavailable", { status: 503, statusText: "Service Unavailable" }),
          networkError(),
        ]) {
          stubFetch({ [URLS.gcp]: incidents, [URLS.gcpProducts]: products });
          const gcp = await collect("gcp");
          expect(gcp.failure).toBeUndefined();
          expect(gcp.health).toBe("degraded");
          expect(gcp.components).toEqual([{ name: "Compute Engine", health: "degraded", detail: "Elevated errors" }]);
        }
      });

      it("fetches the catalogue alongside the incidents, not after them", async () => {
        let productsAsked!: () => void;
        const asked = new Promise<void>((resolve) => {
          productsAsked = resolve;
        });
        stubFetch({
          // Answers only once the catalogue request has been made: a serial
          // collector would wait here forever.
          [URLS.gcp]: async () => {
            await asked;
            return json([])();
          },
          [URLS.gcpProducts]: () => {
            productsAsked();
            return json(googleProducts(2))();
          },
        });
        const gcp = await collect("gcp");
        expect(gcp.failure).toBeUndefined();
        expect(gcp.components.map((c) => c.name)).toEqual(["Product 0", "Product 1"]);
      });

      it("a failing incidents feed still fails the card, whatever the catalogue says", async () => {
        stubFetch({ [URLS.gcpProducts]: json(googleProducts(3)) });
        const gcp = await collect("gcp");
        expect(gcp.health).toBe("unknown");
        expect(gcp.failure?.kind).toBe("http");
        expect(gcp.components).toEqual([]);
      });
    });

    describe("Google Play products.json", () => {
      it("uses the same shape at status.play.google.com", async () => {
        stubFetch({
          [URLS.android]: text(fixture("play/incidents.json")),
          [URLS.androidProducts]: text(fixture("play/products.json")),
        });
        const android = await collect("android");
        expect(android.health).toBe("degraded");
        expect(android.components).toEqual([
          { name: "Google Play Billing", health: "degraded", detail: "Some purchases fail to complete" },
          { name: "Google Play Store", health: "operational" },
          { name: "Google Play Console", health: "operational" },
        ]);
      });

      it("a missing products.json (404) keeps the per-incident components", async () => {
        stubFetch({ [URLS.android]: text(fixture("play/incidents.json")) });
        const android = await collect("android");
        expect(android.failure).toBeUndefined();
        expect(android.components).toEqual([
          { name: "Google Play Billing", health: "degraded", detail: "Some purchases fail to complete" },
        ]);
      });

      it("a quiet Play with no catalogue has no component list", async () => {
        stubFetch({ [URLS.android]: json([]) });
        const android = await collect("android");
        expect(android.health).toBe("operational");
        expect(android.components).toEqual([]);
      });
    });

    describe("Steam connection managers", () => {
      const steamOk = {
        [URLS.steamServerInfo]: json({ servertime: 1758000000 }),
        [URLS.steamFeatured]: json({ featured_win: [{ id: 1 }] }),
      };

      it("is an operational component when the directory lists servers", async () => {
        stubFetch({ ...steamOk, [URLS.steamCm]: text(fixture("steam/cm-list.json")) });
        const steam = await collect("steam");
        expect(steam.health).toBe("operational");
        expect(steam.components).toEqual([
          { name: "Steam Web API", health: "operational" },
          { name: "Steam Store", health: "operational" },
          { name: "Steam Connection Managers", health: "operational", detail: "5 servers listed" },
        ]);
      });

      it("is Unknown, never an outage, for an empty list or an unexpected shape", async () => {
        for (const body of [
          json({ response: { serverlist: [], serverlist_websockets: [], result: 1 } }),
          json({ response: {} }),
          json({ unexpected: true }),
          json(null),
        ]) {
          stubFetch({ ...steamOk, [URLS.steamCm]: body });
          const steam = await collect("steam");
          expect(steam.health).toBe("operational");
          expect(steam.components.at(-1)).toEqual({
            name: "Steam Connection Managers",
            health: "unknown",
            detail: "No servers listed.",
          });
        }
      });

      it("is Unknown, and the card unaffected, when the directory cannot be fetched", async () => {
        for (const cm of [
          undefined,
          text("Unavailable", { status: 503, statusText: "Service Unavailable" }),
          networkError("connection reset"),
        ]) {
          stubFetch({ ...steamOk, [URLS.steamCm]: cm });
          const steam = await collect("steam");
          expect(steam.failure).toBeUndefined();
          expect(steam.health).toBe("operational");
          expect(steam.components.at(-1)).toMatchObject({ name: "Steam Connection Managers", health: "unknown" });
        }
      });

      it("does not rescue a card whose two main endpoints both failed", async () => {
        stubFetch({ [URLS.steamCm]: text(fixture("steam/cm-list.json")) });
        const steam = await collect("steam");
        expect(steam.health).toBe("unknown");
        expect(steam.failure).toBeDefined();
        expect(steam.components).toEqual([]);
      });
    });

    describe("Grok components", () => {
      const feed = () => text(fixture("grok/feed.xml"));

      it("lists the vendor's Instatus components (parents replaced by their children); health stays the feed's", async () => {
        stubFetch({ [URLS.grok]: feed(), [URLS.grokComponents]: text(fixture("grok/components.json")) });
        const grok = await collect("grok");
        expect(grok.failure).toBeUndefined();
        // The feed's one active, degraded item decides the card, even though
        // a component reports a major outage.
        expect(grok.health).toBe("degraded");
        expect(grok.components).toEqual([
          { name: "grok.com", health: "degraded" },
          { name: "Image generation", health: "maintenance", detail: "Maintenance window" },
          { name: "Voice mode", health: "outage" },
          { name: "iOS app", health: "operational" },
          { name: "API", health: "operational" },
        ]);
      });

      it("derives components from the titles' service prefixes when there is no component endpoint", async () => {
        stubFetch({ [URLS.grok]: text(fixture("grok/feed-prefixed.xml")) });
        const grok = await collect("grok");
        expect(grok.health).toBe("outage");
        // API has two active items: the worst health and the newest detail.
        // Voice mode is resolved and the unprefixed title names no service.
        expect(grok.components).toEqual([
          { name: "API", health: "outage", detail: "Requests failing for some models" },
          { name: "grok.com", health: "degraded", detail: "Slow page loads" },
        ]);
        expect(grok.incidents).toHaveLength(4);
      });

      it("falls back to the titles when the endpoint is empty, malformed or failing", async () => {
        for (const components of [
          json({ components: [] }),
          json({ components: "x" }),
          json([]),
          text("<html>Just a moment...</html>"),
          text("Forbidden", { status: 403, statusText: "Forbidden" }),
          networkError(),
          undefined,
        ]) {
          stubFetch({ [URLS.grok]: text(fixture("grok/feed-prefixed.xml")), [URLS.grokComponents]: components });
          const grok = await collect("grok");
          expect(grok.failure).toBeUndefined();
          expect(grok.components.map((c) => c.name)).toEqual(["API", "grok.com"]);
        }
      });

      it("shows no components, and invents none, when the feed titles carry no prefix", async () => {
        stubFetch({ [URLS.grok]: feed() });
        const grok = await collect("grok");
        expect(grok.health).toBe("degraded");
        expect(grok.components).toEqual([]);
        expect(grok.componentCount).toBeUndefined();
      });

      it("caps a long component list at 24 and reports the total", async () => {
        const components = Array.from({ length: 30 }, (_, i) => ({
          id: String(i),
          name: `Part ${i}`,
          status: i === 29 ? "MAJOROUTAGE" : "OPERATIONAL",
        }));
        stubFetch({ [URLS.grok]: feed(), [URLS.grokComponents]: json({ components }) });
        const grok = await collect("grok");
        expect(grok.components).toHaveLength(24);
        expect(grok.componentCount).toBe(30);
        expect(grok.components[0]).toEqual({ name: "Part 29", health: "outage" });
      });

      it("fetches the component list alongside the feed, not after it", async () => {
        let componentsAsked!: () => void;
        const asked = new Promise<void>((resolve) => {
          componentsAsked = resolve;
        });
        stubFetch({
          [URLS.grok]: async () => {
            await asked;
            return feed()();
          },
          [URLS.grokComponents]: () => {
            componentsAsked();
            return json({ components: [{ name: "API", status: "OPERATIONAL" }] })();
          },
        });
        const grok = await collect("grok");
        expect(grok.failure).toBeUndefined();
        expect(grok.components).toEqual([{ name: "API", health: "operational" }]);
      });
    });

    describe("AWS components", () => {
      const at = Math.floor(Date.now() / 1000) - 3600;
      function awsEvent(overrides: Record<string, unknown> = {}) {
        return {
          date: String(at),
          arn: `arn:aws:health:${Math.random()}`,
          region_name: "N. Virginia",
          status: "1",
          service: "ec2-us-east-1",
          service_name: "Amazon Elastic Compute Cloud",
          summary: "Increased API Error Rates",
          event_log: [{ summary: "Increased API Error Rates", message: "Investigating.", status: 1, timestamp: at }],
          ...overrides,
        };
      }
      const serve = (events: unknown[]) => stubFetch({ [URLS.aws]: bytes(utf16(JSON.stringify(events))) });

      it("merges events per service: worst health wins, the newest event's summary is the detail", async () => {
        serve([
          awsEvent({ summary: "Older regional issue", date: String(at - 600), event_log: [{ timestamp: at - 600 }] }),
          awsEvent({
            region_name: "",
            summary: "Newest: multi-region outage",
            event_log: [
              { summary: "Service outage", message: "The service is unavailable.", status: 1, timestamp: at },
            ],
          }),
          awsEvent({ service_name: "AWS Lambda", service: "lambda-eu-west-1", summary: "Invoke latency" }),
        ]);
        const aws = await collect("aws");
        expect(aws.components).toEqual([
          { name: "Amazon Elastic Compute Cloud", health: "outage", detail: "Newest: multi-region outage" },
          { name: "AWS Lambda", health: "degraded", detail: "Invoke latency" },
        ]);
        expect(aws.componentCount).toBeUndefined();
        expect(aws.incidents).toHaveLength(3);
      });

      it("has no component list when nothing is active, and invents none", async () => {
        serve([awsEvent({ status: "0", summary: "[RESOLVED] Increased API Error Rates" })]);
        const aws = await collect("aws");
        expect(aws.health).toBe("operational");
        expect(aws.components).toEqual([]);
        expect(aws.componentCount).toBeUndefined();
      });

      it("skips an event that names no service", async () => {
        serve([awsEvent({ service_name: undefined, service: undefined })]);
        const aws = await collect("aws");
        expect(aws.health).toBe("degraded");
        expect(aws.components).toEqual([]);
      });

      it("caps at 24 services and reports the total", async () => {
        serve(
          Array.from({ length: 30 }, (_, i) =>
            awsEvent({
              service_name: `Service ${i}`,
              service: `svc-${i}`,
              region_name: "",
              summary: i === 27 ? "Outage" : "Elevated latency",
              event_log: [
                {
                  summary: i === 27 ? "Outage" : "Elevated latency",
                  message: i === 27 ? "The service is unavailable." : "Slow.",
                  status: 1,
                  timestamp: at,
                },
              ],
            }),
          ),
        );
        const aws = await collect("aws");
        expect(aws.components).toHaveLength(24);
        expect(aws.componentCount).toBe(30);
        expect(aws.components.map((c) => c.name)).toEqual(Array.from({ length: 24 }, (_, i) => `Service ${i}`));
      });
    });
  });
});
