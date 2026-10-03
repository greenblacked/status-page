import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, type Handler, json, networkError, stubFetch, text, utf16 } from "../../test/stub-fetch.ts";
import { CATALOG } from "./catalog.ts";
import { assembleBoard } from "./collect-board.ts";
import { diffBoards, releaseChange } from "./diff.ts";
import { MAX_BODY_BYTES } from "./http.ts";
import {
  collectAllServices,
  MAX_NESTED_ROWS,
  MAX_RSS_ITEMS,
  MAX_RSS_SCANNED,
  MAX_SCANNED_ROWS,
} from "./sources.server.ts";
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
  github: "https://www.githubstatus.com/api/v2/summary.json",
  gitlab: "https://api.status.io/1.0/status/5b36dc6502d06804c08349f7",
  confluence: "https://confluence.status.atlassian.com/api/v2/summary.json",
  azure: "https://rssfeed.azure.status.microsoft/en-us/status/feed/",
  apple: "https://www.apple.com/support/systemstatus/data/system_status_en_US.js",
  android: "https://status.play.google.com/incidents.json",
  chatgpt: "https://status.openai.com/api/v2/summary.json",
  claude: "https://status.claude.com/api/v2/summary.json",
  aws: "https://health.aws.amazon.com/public/currentevents",
  grok: "https://status.x.ai/feed.xml",
  mikrotikUpgrade: "https://upgrade.mikrotik.com/routeros/",
  mikrotikDownload: "https://download.mikrotik.com/routeros/",
  appleOs: "https://developer.apple.com/news/releases/rss/releases.rss",
  windows: "https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information",
  androidOs: "https://developer.android.com/about/versions",
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
  // Loose on purpose: several tests send components, incidents and maintenance
  // with fields missing or null.
  components?: unknown[];
  incidents?: unknown[];
  scheduled_maintenances?: unknown[];
}) {
  return {
    status: { indicator: overrides.indicator ?? "none", description: "All Systems Operational" },
    components: overrides.components ?? [],
    incidents: overrides.incidents ?? [],
    scheduled_maintenances: overrides.scheduled_maintenances ?? [],
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
    expect(services.find((s) => s.id === "chatgpt")!.summary).toBe("Some parts are slow or failing.");
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

  it.each([
    [403, "Forbidden"],
    [429, "Too Many Requests"],
  ])(
    "Steam: a %i from the store is not a failure: card operational, Store unknown with an honest detail",
    async (status, statusText) => {
      stubFetch({
        [URLS.steamServerInfo]: json({ servertime: 1758000000 }),
        [URLS.steamFeatured]: text("refused", { status, statusText }),
      });
      const services = await collectAllServices();
      const snapshot = services.find((s) => s.id === "steam")!;
      expect(snapshot.health).toBe("operational");
      expect(snapshot.failure).toBeUndefined();
      expect(snapshot.components.find((c) => c.name === "Steam Store")).toEqual({
        name: "Steam Store",
        health: "unknown",
        detail: `Store refused the check (${status})`,
      });
      expect(snapshot.components.find((c) => c.name === "Steam Web API")?.health).toBe("operational");
    },
  );

  it("Steam: a Web API answering with the wrong shape while the store is fine is degraded", async () => {
    stubFetch({
      [URLS.steamServerInfo]: json({ servertime: "not-a-number" }),
      [URLS.steamFeatured]: json({ featured_win: [{ id: 1 }] }),
    });
    const snapshot = (await collectAllServices()).find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("degraded");
    expect(snapshot.components.find((c) => c.name === "Steam Web API")?.health).toBe("outage");
  });

  it("Steam: a refused store does not make a failing Web API look fine: nothing usable is unknown, with the real fault", async () => {
    stubFetch({
      [URLS.steamServerInfo]: text("service unavailable", { status: 503, statusText: "Service Unavailable" }),
      [URLS.steamFeatured]: text("refused", { status: 403, statusText: "Forbidden" }),
    });
    const snapshot = (await collectAllServices()).find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure).toMatchObject({ kind: "http", status: 503 });
  });

  it("Steam: a refused Web API with the store fine is operational, Web API unknown", async () => {
    stubFetch({
      [URLS.steamServerInfo]: text("refused", { status: 403, statusText: "Forbidden" }),
      [URLS.steamFeatured]: json({ featured_win: [{ id: 1 }] }),
    });
    const snapshot = (await collectAllServices()).find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("operational");
    expect(snapshot.components.find((c) => c.name === "Steam Web API")).toEqual({
      name: "Steam Web API",
      health: "unknown",
      detail: "Web API refused the check (403)",
    });
  });

  it("Steam: a refused Web API and a store that failed is unknown, with the store's real fault", async () => {
    stubFetch({
      [URLS.steamServerInfo]: text("refused", { status: 403, statusText: "Forbidden" }),
      [URLS.steamFeatured]: text("service unavailable", { status: 503, statusText: "Service Unavailable" }),
    });
    const snapshot = (await collectAllServices()).find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure).toMatchObject({ kind: "http", status: 503 });
  });

  it("Steam: a wrong-shape Web API and a refused store is unknown with a parser failure", async () => {
    stubFetch({
      [URLS.steamServerInfo]: json({ servertime: "not-a-number" }),
      [URLS.steamFeatured]: text("refused", { status: 403, statusText: "Forbidden" }),
    });
    const snapshot = (await collectAllServices()).find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure?.kind).toBe("parser");
  });

  it("Steam: both endpoints refusing the check is unknown", async () => {
    stubFetch({
      [URLS.steamServerInfo]: text("refused", { status: 403, statusText: "Forbidden" }),
      [URLS.steamFeatured]: text("refused", { status: 403, statusText: "Forbidden" }),
    });
    const snapshot = (await collectAllServices()).find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("unknown");
    expect(snapshot.failure).toMatchObject({ kind: "http", status: 403 });
  });

  it("Steam: a Cloudflare bot challenge on the store is a refusal, whatever its status", async () => {
    stubFetch({
      [URLS.steamServerInfo]: json({ servertime: 1758000000 }),
      [URLS.steamFeatured]: () =>
        new Response("challenge", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "cf-mitigated": "challenge" },
        }),
    });
    const snapshot = (await collectAllServices()).find((s) => s.id === "steam")!;
    expect(snapshot.health).toBe("operational");
    expect(snapshot.components.find((c) => c.name === "Steam Store")).toMatchObject({
      health: "unknown",
      detail: "Store refused the check (503)",
    });
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

  it("Apple: an upcoming event is upcomingMaintenance, not maintenance, until it is ongoing", async () => {
    const start = Date.parse("2026-09-21T02:00:00Z");
    const end = Date.parse("2026-09-21T04:00:00Z");
    stubFetch({
      [URLS.apple]: json({
        services: [
          {
            serviceName: "Apple Music",
            events: [
              {
                eventStatus: "upcoming",
                statusType: "maintenance",
                message: "Scheduled maintenance",
                epochStartDate: start,
                epochEndDate: end,
              },
            ],
          },
          { serviceName: "App Store", events: [] },
        ],
      }),
    });
    const apple = (await collectAllServices()).find((s) => s.id === "apple")!;
    expect(apple.health).toBe("operational");
    expect(apple.summary).toBe("Nothing reported.");
    expect(apple.incidents).toEqual([]);
    expect(apple.components).toEqual([
      { name: "Apple Music", health: "operational" },
      { name: "App Store", health: "operational" },
    ]);
    expect(apple.upcomingMaintenance).toEqual([
      {
        id: `Apple Music-${start}`,
        title: "Apple Music: Scheduled maintenance",
        scheduledFor: "2026-09-21T02:00:00.000Z",
        scheduledUntil: "2026-09-21T04:00:00.000Z",
        url: "https://www.apple.com/support/systemstatus/",
      },
    ]);

    // The same event once it is ongoing is real maintenance.
    stubFetch({
      [URLS.apple]: json({
        services: [
          {
            serviceName: "Apple Music",
            events: [
              {
                eventStatus: "ongoing",
                statusType: "maintenance",
                message: "Scheduled maintenance",
                epochStartDate: start,
              },
            ],
          },
        ],
      }),
    });
    const later = (await collectAllServices()).find((s) => s.id === "apple")!;
    expect(later.health).toBe("maintenance");
    expect(later.upcomingMaintenance).toBeUndefined();
  });

  it("Apple: incidents are sorted worst first, and the summary names the worst", async () => {
    stubFetch({
      [URLS.apple]: json({
        services: [
          {
            serviceName: "Apple Music",
            events: [{ eventStatus: "ongoing", statusType: "issue", message: "Slow", epochStartDate: 1000 }],
          },
          {
            serviceName: "iCloud Mail",
            events: [{ eventStatus: "ongoing", statusType: "outage", message: "Down", epochStartDate: 2000 }],
          },
        ],
      }),
    });
    const apple = (await collectAllServices()).find((s) => s.id === "apple")!;
    expect(apple.incidents.map((i) => [i.health, i.title])).toEqual([
      ["outage", "iCloud Mail: Down"],
      ["degraded", "Apple Music: Slow"],
    ]);
    expect(apple.summary).toBe("iCloud Mail: Down");
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

  it("Statuspage: non-operational components lead, worst first, then operational ones in the vendor's order", async () => {
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
      ["Voice", "outage"],
      ["Login", "degraded"],
      ["Chat", "operational"],
      ["Files", "operational"],
    ]);
  });

  it("Statuspage: an unreadable component ranks after the confirmed problems and before maintenance, as on the board", async () => {
    const summary = statuspageSummary({
      indicator: "minor",
      components: [
        { id: "1", name: "Chat", status: "operational" },
        { id: "2", name: "Mystery", status: "something_new" },
        { id: "3", name: "Login", status: "degraded_performance" },
        { id: "4", name: "Files", status: "under_maintenance" },
        { id: "5", name: "Voice", status: "major_outage" },
      ],
    });
    stubFetch({ [URLS.claude]: json(summary) });
    const claude = (await collectAllServices()).find((s) => s.id === "claude")!;
    expect(claude.components.map((c) => [c.name, c.health])).toEqual([
      ["Voice", "outage"],
      ["Login", "degraded"],
      ["Mystery", "unknown"],
      ["Files", "maintenance"],
      ["Chat", "operational"],
    ]);
  });

  it("Statuspage: a huge page is capped at 300 components, and a broken one past the cap still leads", async () => {
    const components = Array.from({ length: 320 }, (_, i) => ({
      id: String(i),
      name: `Component ${i}`,
      status: i === 315 ? "partial_outage" : "operational",
    }));
    stubFetch({ [URLS.spotify]: json(statuspageSummary({ indicator: "minor", components })) });
    const spotify = (await collectAllServices()).find((s) => s.id === "spotify")!;
    expect(spotify.components).toHaveLength(300);
    expect(spotify.componentCount).toBe(320);
    expect(spotify.components[0]).toEqual({ name: "Component 315", health: "degraded", detail: "Partial outage" });
    expect(spotify.components.slice(1).map((c) => c.name)).toEqual(
      Array.from({ length: 299 }, (_, i) => `Component ${i}`),
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
      { name: "Fortnite Matchmaking", health: "degraded", detail: "Partial outage" },
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
      { name: "Matchmaking", health: "degraded", detail: "Partial outage" },
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

  it("Google Cloud: a SERVICE_INFORMATION item is an informational notice, and the service stays operational", async () => {
    stubFetch({
      [URLS.gcp]: json([
        googleIncident({
          id: "note",
          status_impact: "SERVICE_INFORMATION",
          external_desc: "Billing export schema change",
          service_name: "Cloud Billing",
          uri: "incidents/note",
        }),
      ]),
    });
    const gcp = (await collectAllServices()).find((s) => s.id === "gcp")!;
    expect(gcp.health).toBe("operational");
    expect(gcp.summary).toBe("Nothing reported.");
    expect(gcp.components).toEqual([]);
    expect(gcp.incidents).toEqual([
      {
        id: "note",
        title: "Billing export schema change",
        health: "operational",
        informational: true,
        startedAt: "2026-09-20T00:00:00.000Z",
        updatedAt: undefined,
        url: "https://status.cloud.google.com/incidents/note",
      },
    ]);
  });

  it("Google Cloud: an impact this code does not know is unknown, and a real outage still sorts first", async () => {
    stubFetch({
      [URLS.gcp]: json([
        googleIncident({ id: "odd", status_impact: "SOMETHING_NEW", external_desc: "Odd", uri: "incidents/odd" }),
        googleIncident({ id: "down", status_impact: "SERVICE_OUTAGE", external_desc: "Down", uri: "incidents/down" }),
      ]),
    });
    const gcp = (await collectAllServices()).find((s) => s.id === "gcp")!;
    expect(gcp.health).toBe("outage");
    expect(gcp.incidents.map((i) => [i.id, i.health])).toEqual([
      ["down", "outage"],
      ["odd", "unknown"],
    ]);
    expect(gcp.summary).toBe("Down");
  });

  describe("Statuspage incidents and maintenance", () => {
    const claudeOf = async () => (await collectAllServices()).find((s) => s.id === "claude")!;

    it("lists an impact-none incident as an informational notice, not as an Operational row", async () => {
      stubFetch({
        [URLS.claude]: json(
          statuspageSummary({
            incidents: [{ id: "n1", name: "Scheduled database upgrade", status: "investigating", impact: "none" }],
          }),
        ),
      });
      const claude = await claudeOf();
      expect(claude.health).toBe("operational");
      expect(claude.summary).toBe("Nothing reported.");
      expect(claude.incidents).toEqual([
        { id: "n1", title: "Scheduled database upgrade", health: "operational", informational: true },
      ]);
    });

    // Trimmed from the live Claude page: every component Operational, the page indicator "none", and
    // one open incident that the vendor has not tied to any component.
    const claudeWithIncident = (incident: Record<string, unknown>) =>
      statuspageSummary({
        indicator: "none",
        components: [
          { id: "c1", name: "claude.ai", status: "operational" },
          { id: "c2", name: "Claude API (api.anthropic.com)", status: "operational" },
          { id: "c3", name: "Claude Code", status: "operational" },
        ],
        incidents: [
          {
            id: "credits",
            name: "Delayed credits on the Claude Platform",
            status: "monitoring",
            started_at: "2026-10-01T19:20:00Z",
            components: [],
            ...incident,
          },
        ],
      });

    it.each([
      ["minor", "degraded"],
      ["major", "outage"],
      ["critical", "outage"],
    ])("an active %s incident makes the card %s, though every component is Operational", async (impact, health) => {
      stubFetch({ [URLS.claude]: json(claudeWithIncident({ impact })) });
      const claude = await claudeOf();
      expect(claude.health).toBe(health);
      expect(claude.summary).toBe("Delayed credits on the Claude Platform");
      expect(claude.components.every((component) => component.health === "operational")).toBe(true);
      expect(claude.incidents).toHaveLength(1);
      expect(claude.incidents[0]).toMatchObject({ health, title: "Delayed credits on the Claude Platform" });
      expect(claude.incidents[0].informational).toBeUndefined();
    });

    it("an active impact-none notice leaves the same Claude page Operational, with the notice listed", async () => {
      stubFetch({ [URLS.claude]: json(claudeWithIncident({ impact: "none" })) });
      const claude = await claudeOf();
      expect(claude.health).toBe("operational");
      expect(claude.summary).toBe("Nothing reported.");
      expect(claude.incidents[0]).toMatchObject({ health: "operational", informational: true });
    });

    it.each([[{ impact: undefined }], [{ impact: "" }]])(
      "an active incident with no impact is a problem: Degraded, not No data",
      async (incident) => {
        stubFetch({ [URLS.claude]: json(claudeWithIncident(incident)) });
        const claude = await claudeOf();
        expect(claude.health).toBe("degraded");
        expect(claude.summary).toBe("Delayed credits on the Claude Platform");
        expect(claude.failure).toBeUndefined();
        expect(claude.incidents[0].informational).toBeUndefined();
      },
    );

    it("a resolved incident does not raise the card", async () => {
      stubFetch({ [URLS.claude]: json(claudeWithIncident({ impact: "major", status: "resolved" })) });
      const claude = await claudeOf();
      expect(claude.health).toBe("operational");
      expect(claude.incidents).toEqual([]);
    });

    it("an incident is never masked by a notice, and never lowers a worse component or indicator", async () => {
      const summary = claudeWithIncident({ impact: "minor" });
      summary.incidents.push({ id: "n", name: "FYI", status: "monitoring", impact: "none" });
      stubFetch({ [URLS.claude]: json(summary) });
      expect((await claudeOf()).health).toBe("degraded");

      const worse = statuspageSummary({
        indicator: "major",
        components: [{ id: "c1", name: "claude.ai", status: "major_outage" }],
        incidents: [{ id: "i", name: "Slow", status: "investigating", impact: "minor" }],
      });
      stubFetch({ [URLS.claude]: json(worse) });
      expect((await claudeOf()).health).toBe("outage");
    });

    it("an active incident outranks maintenance in progress, which still sets maintenance when otherwise up", async () => {
      const summary = claudeWithIncident({ impact: "minor" });
      summary.scheduled_maintenances = [{ id: "m", name: "Database upgrade", status: "in_progress" }];
      stubFetch({ [URLS.claude]: json(summary) });
      expect((await claudeOf()).health).toBe("degraded");

      summary.incidents = [];
      stubFetch({ [URLS.claude]: json(summary) });
      expect((await claudeOf()).health).toBe("maintenance");
    });

    it("a problem incident among many notices sets the card and is listed first", async () => {
      const incidents = Array.from({ length: 12 }, (_, i) => ({
        id: `n${i}`,
        name: `Notice ${i}`,
        status: "monitoring",
        impact: "none",
        started_at: `2026-10-01T10:${String(i).padStart(2, "0")}:00Z`,
      }));
      incidents.push({
        id: "bad",
        name: "Real problem",
        status: "identified",
        impact: "major",
        started_at: "2026-09-01T00:00:00Z",
      });
      stubFetch({ [URLS.claude]: json(statuspageSummary({ incidents })) });
      const claude = await claudeOf();
      expect(claude.health).toBe("outage");
      expect(claude.incidents[0].id).toBe("bad");
    });

    it("an Epic/Fortnite incident raises only the card it belongs to", async () => {
      const components = [
        { id: "g1", name: "Fortnite", status: "operational", group: true },
        { id: "1", name: "Login", status: "operational", group_id: "g1" },
        { id: "g2", name: "Epic Games Store", status: "operational", group: true },
        { id: "3", name: "Login", status: "operational", group_id: "g2" },
      ];
      stubFetch({
        [URLS.epicFortnite]: json(
          statuspageSummary({
            components,
            incidents: [
              { id: "b", name: "Login failures", status: "investigating", impact: "major", components: [{ id: "1" }] },
            ],
          }),
        ),
      });
      const services = await collectAllServices();
      expect(services.find((s) => s.id === "fortnite")!.health).toBe("outage");
      expect(services.find((s) => s.id === "epic")!.health).toBe("operational");
    });

    it("sorts incidents by urgency, then recency, and names the worst one in the summary", async () => {
      stubFetch({
        [URLS.claude]: json(
          statuspageSummary({
            indicator: "major",
            incidents: [
              { id: "note", name: "FYI", status: "monitoring", impact: "none", started_at: "2026-09-20T11:00:00Z" },
              {
                id: "old-minor",
                name: "Old minor",
                status: "identified",
                impact: "minor",
                started_at: "2026-09-20T08:00:00Z",
              },
              {
                id: "new-minor",
                name: "New minor",
                status: "identified",
                impact: "minor",
                started_at: "2026-09-20T10:00:00Z",
              },
              {
                id: "major",
                name: "Big outage",
                status: "investigating",
                impact: "major",
                started_at: "2026-09-20T07:00:00Z",
              },
            ],
          }),
        ),
      });
      const claude = await claudeOf();
      expect(claude.incidents.map((i) => i.id)).toEqual(["major", "new-minor", "old-minor", "note"]);
      expect(claude.summary).toBe("Big outage");
    });

    it("survives incidents and maintenance with missing fields, instead of failing the card", async () => {
      stubFetch({
        [URLS.claude]: json(
          statuspageSummary({
            indicator: "minor",
            components: [{ id: "1", status: "degraded_performance" }, null],
            incidents: [{ impact: "minor" }, null, { id: "r", name: "Done", status: "resolved", impact: "minor" }],
            scheduled_maintenances: [{ name: "No status" }, null],
          }),
        ),
      });
      const claude = await claudeOf();
      expect(claude.failure).toBeUndefined();
      expect(claude.health).toBe("degraded");
      expect(claude.components).toEqual([{ name: "Component", health: "degraded" }]);
      // A status-less incident is not known to be resolved, so it stays; an
      // unnamed one gets a generic title and a stable id.
      expect(claude.incidents).toHaveLength(1);
      expect(claude.incidents[0]).toMatchObject({ title: "Incident", health: "degraded" });
      expect(claude.incidents[0].id).toMatch(/^statuspage-[0-9a-f]{8}$/);
    });

    it("attributes an Epic/Fortnite incident by the components it lists, ahead of its name", async () => {
      const components = [
        { id: "g1", name: "Fortnite", status: "operational", group: true },
        { id: "1", name: "Login", status: "major_outage", group_id: "g1" },
        { id: "g2", name: "Epic Games Store", status: "operational", group: true },
        { id: "3", name: "Login", status: "operational", group_id: "g2" },
      ];
      stubFetch({
        [URLS.epicFortnite]: json(
          statuspageSummary({
            components,
            incidents: [
              // Named for Fortnite, but it lists the Epic store's Login.
              {
                id: "a",
                name: "Fortnite login errors",
                status: "investigating",
                impact: "minor",
                components: [{ id: "3", name: "Login", group_id: "g2" }],
              },
              // No mention of Fortnite in the name; it lists the Fortnite group's Login.
              {
                id: "b",
                name: "Login failures",
                status: "investigating",
                impact: "major",
                components: [{ id: "1" }],
              },
              // Lists nothing, so the name decides.
              { id: "c", name: "Fortnite matchmaking delays", status: "identified", impact: "minor" },
              { id: "d", name: "Payments delays", status: "identified", impact: "minor" },
            ],
          }),
        ),
      });
      const services = await collectAllServices();
      const epic = services.find((s) => s.id === "epic")!;
      const fortnite = services.find((s) => s.id === "fortnite")!;
      expect(epic.incidents.map((i) => i.id)).toEqual(["a", "d"]);
      expect(fortnite.incidents.map((i) => i.id)).toEqual(["b", "c"]);
    });

    it("keeps scheduled maintenance as upcoming, soonest first, without changing health", async () => {
      stubFetch({
        [URLS.claude]: json(
          statuspageSummary({
            scheduled_maintenances: [
              {
                id: "later",
                name: "Later window",
                status: "scheduled",
                scheduled_for: "2026-09-25T02:00:00Z",
                scheduled_until: "2026-09-25T03:00:00Z",
                shortlink: "https://stspg.io/later",
              },
              { id: "soon", name: "Sooner window", status: "scheduled", scheduled_for: "2026-09-21T02:00:00Z" },
              { id: "done", name: "Finished", status: "completed", scheduled_for: "2026-09-10T02:00:00Z" },
            ],
          }),
        ),
      });
      const claude = await claudeOf();
      expect(claude.health).toBe("operational");
      expect(claude.summary).toBe("Nothing reported.");
      expect(claude.upcomingMaintenance).toEqual([
        { id: "soon", title: "Sooner window", scheduledFor: "2026-09-21T02:00:00.000Z" },
        {
          id: "later",
          title: "Later window",
          scheduledFor: "2026-09-25T02:00:00.000Z",
          scheduledUntil: "2026-09-25T03:00:00.000Z",
          url: "https://stspg.io/later",
        },
      ]);
    });

    it("has no upcomingMaintenance field when nothing is scheduled, and in-progress work is maintenance", async () => {
      stubFetch({
        [URLS.claude]: json(
          statuspageSummary({
            scheduled_maintenances: [{ id: "m", name: "Database upgrade", status: "in_progress" }],
          }),
        ),
      });
      const claude = await claudeOf();
      expect(claude.health).toBe("maintenance");
      expect(claude.summary).toBe("Database upgrade");
      expect("upcomingMaintenance" in claude).toBe(false);
    });
  });

  it("Apple: every service is a component, active ones first, capped at 300", async () => {
    const services = Array.from({ length: 310 }, (_, i) => ({
      serviceName: `Service ${i}`,
      events:
        i === 308
          ? [{ eventStatus: "ongoing", statusType: "issue", message: "Slow", epochStartDate: 1693440600000 }]
          : [{ eventStatus: "resolved", statusType: "outage", message: "Back", epochStartDate: 1693440600000 }],
    }));
    stubFetch({ [URLS.apple]: json({ services }) });
    const apple = (await collectAllServices()).find((s) => s.id === "apple")!;
    expect(apple.health).toBe("degraded");
    expect(apple.components).toHaveLength(300);
    expect(apple.componentCount).toBe(310);
    expect(apple.components[0]).toMatchObject({ name: "Service 308", health: "degraded" });
    expect(apple.components.slice(1).every((c) => c.health === "operational")).toBe(true);
    expect(apple.components[1].name).toBe("Service 0");
    expect(apple.meta).toEqual({ services: 310 });
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

  it("holds the logged failure message to its limit", async () => {
    // A transport error's own message is vendor-influenced text of any length.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("z".repeat(10_000))));
    await collectAllServices();
    const logged = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(String(call[0])) as { event: string; message: string })
      .filter((line) => line.event === "collector_failed");
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line.message.length).toBeLessThanOrEqual(500);
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

  it("a body that is not JSON is a parser failure whose message does not quote the body", async () => {
    stubFetch({ [URLS.gcp]: text("<html>Attention Required: SECRET-CHALLENGE-TEXT</html>") });
    const snapshot = (await collectAllServices()).find((s) => s.id === "gcp")!;
    expect(snapshot.failure).toEqual({
      kind: "parser",
      // What the body looked like and how it was labelled, never its text.
      message: "SyntaxError: response was not valid JSON (looks like HTML, text/xml)",
    });
    // The hint is for the failure record; the reader-visible summary stays generic.
    expect(snapshot.summary).toBe("Official source did not respond.");
    expect(JSON.stringify(snapshot)).not.toContain("SECRET-CHALLENGE-TEXT");
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
      expect(aws.summary).toBe("Amazon Elastic Compute Cloud (N. Virginia) — Increased API Error Rates");
      // The Lambda event reports resolved and the CloudFront one is 30 days
      // old, so neither shows up as a component or an incident.
      expect(aws.components).toEqual([
        { name: "Amazon Elastic Compute Cloud", health: "degraded", detail: "N. Virginia · Increased API Error Rates" },
      ]);
      expect(aws.incidents).toEqual([
        {
          id: "arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/AWS_EC2_OPERATIONAL_ISSUE_4E7B1C2D9A0F",
          title: "Amazon Elastic Compute Cloud (N. Virginia) — Increased API Error Rates",
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

    it("AWS currentevents: a multi-service event yields one row per impacted service, merged across events and regions", async () => {
      stubFetch({ [URLS.aws]: bytes(utf16(fixture("aws/currentevents-multiple.json"))) });
      const aws = await collect("aws");
      expect(aws.failure).toBeUndefined();
      expect(aws.health).toBe("outage");
      // Worst first, then the newest: the global IAM outage, the N. Virginia
      // disruption (status 3, so an outage even though it is one region) and
      // the Ireland performance issue. "Multiple services" is replaced by the
      // services still affected (Lambda has recovered) and the region is named.
      expect(aws.incidents.map((incident) => [incident.title, incident.health])).toEqual([
        ["AWS Identity and Access Management — Global sign-in outage", "outage"],
        [
          "Amazon Elastic Compute Cloud and Amazon Relational Database Service (N. Virginia) — Increased Error Rates and Latencies",
          "outage",
        ],
        ["Amazon Elastic Compute Cloud (Ireland) — Elevated Launch Failures", "degraded"],
      ]);
      expect(aws.summary).toBe("AWS Identity and Access Management — Global sign-in outage");
      // "Multiple services" is never a row. Lambda has recovered (current 0)
      // so it is not one either. EC2 merges the Virginia and Ireland events:
      // the worse health, both regions, and the newest event's summary.
      expect(aws.components).toEqual([
        {
          name: "Amazon Elastic Compute Cloud",
          health: "outage",
          detail: "N. Virginia, Ireland · Elevated Launch Failures",
        },
        { name: "AWS Identity and Access Management", health: "outage", detail: "Global sign-in outage" },
        {
          name: "Amazon Relational Database Service",
          health: "degraded",
          detail: "N. Virginia · Increased Error Rates and Latencies",
        },
      ]);
    });

    it("AWS currentevents: an event with no ARN gets the same content-derived id on every sweep", async () => {
      const event = {
        date: "1789898400",
        region_name: "Ohio",
        status: "2",
        service_name: "Amazon S3",
        summary: "Increased latency",
        event_log: [{ summary: "Increased latency", message: "Investigating.", status: 2, timestamp: 1789898400 }],
      };
      stubFetch({ [URLS.aws]: bytes(utf16(JSON.stringify([event]))) });
      const first = (await collect("aws")).incidents[0].id;
      stubFetch({ [URLS.aws]: bytes(utf16(JSON.stringify([event]))) });
      const second = (await collect("aws")).incidents[0].id;
      expect(first).toBe(second);
      expect(first).toMatch(/^aws-[0-9a-f]{8}$/);
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

    it("GitHub summary.json: a degraded and a partly-out component, an active incident and upcoming maintenance", async () => {
      stubFetch({ [URLS.github]: json(JSON.parse(fixture("github/summary.json"))) });
      const github = await collect("github");
      expect(github.failure).toBeUndefined();
      // Minor indicator, a partial outage on Actions and a minor incident: degraded.
      expect(github.health).toBe("degraded");
      expect(github.summary).toBe("Disruption with some GitHub services");
      expect(github.components.map((c) => [c.name, c.health, c.detail])).toEqual([
        ["Pull Requests", "degraded", undefined],
        ["Actions", "degraded", "Partial outage"],
        ["Git Operations", "operational", undefined],
        ["API Requests", "operational", undefined],
        ["Webhooks", "operational", undefined],
        ["Issues", "operational", undefined],
        ["Packages", "operational", undefined],
        ["Pages", "operational", undefined],
        ["Codespaces", "operational", undefined],
        ["Copilot", "operational", undefined],
      ]);
      // The resolved webhook incident is not listed.
      expect(github.incidents).toEqual([
        {
          id: "q2zmv0t6k8x1",
          title: "Disruption with some GitHub services",
          health: "degraded",
          startedAt: "2026-09-20T09:41:00.000Z",
          updatedAt: "2026-09-20T11:30:00.000Z",
          url: "https://stspg.io/q2zmv0t6k8x1",
        },
      ]);
      expect(github.upcomingMaintenance).toEqual([
        {
          id: "m4w9t2x7b1qa",
          title: "Scheduled maintenance for Codespaces",
          scheduledFor: "2026-09-24T02:00:00.000Z",
          scheduledUntil: "2026-09-24T04:00:00.000Z",
          url: "https://stspg.io/m4w9t2x7b1qa",
        },
      ]);
      expect(github.sourceUrl).toBe("https://www.githubstatus.com/");
    });

    it("GitHub summary.json: the page's own pointer to itself is not a service", async () => {
      stubFetch({ [URLS.github]: json(JSON.parse(fixture("github/summary.json"))) });
      const github = await collect("github");
      expect(github.components.some((c) => c.name.startsWith("Visit "))).toBe(false);
      expect(github.components).toHaveLength(10);
    });

    it("GitLab status.json (Status.io): a partial disruption, its components with the affected containers, an incident and upcoming maintenance", async () => {
      stubFetch({ [URLS.gitlab]: json(JSON.parse(fixture("gitlab/status.json"))) });
      const gitlab = await collect("gitlab");
      expect(gitlab.failure).toBeUndefined();
      expect(gitlab.health).toBe("degraded");
      expect(gitlab.summary).toBe("Elevated errors on Git over SSH");
      expect(gitlab.components).toEqual([
        { name: "Git Operations", health: "degraded", detail: "Partial Service Disruption (SSH)" },
        { name: "Container Registry", health: "degraded", detail: "Degraded Performance (Primary)" },
        { name: "Website", health: "operational" },
        { name: "API", health: "operational" },
        { name: "GitLab Pages", health: "operational" },
      ]);
      // The newest message's status (400), not the first (300), is the incident's.
      expect(gitlab.incidents).toEqual([
        {
          id: "65f1c0de0000000000000001",
          title: "Elevated errors on Git over SSH",
          health: "degraded",
          startedAt: "2026-09-20T10:05:00.000Z",
          updatedAt: "2026-09-20T10:12:00.000Z",
          url: "https://status.gitlab.com/pages/incident/5b36dc6502d06804c08349f7/65f1c0de0000000000000001",
        },
      ]);
      expect(gitlab.upcomingMaintenance).toEqual([
        {
          id: "65f1c0de0000000000000002",
          title: "Database upgrade",
          scheduledFor: "2026-09-27T01:00:00.000Z",
          scheduledUntil: "2026-09-27T03:00:00.000Z",
          url: "https://status.gitlab.com/pages/maintenance/5b36dc6502d06804c08349f7/65f1c0de0000000000000002",
        },
      ]);
      expect(gitlab.sourceUrl).toBe("https://status.gitlab.com/");
    });

    it.each([
      [100, "operational"],
      [200, "maintenance"],
      [300, "degraded"],
      [400, "degraded"],
      [500, "outage"],
      [600, "degraded"],
    ])("GitLab: the page's status_code %i is %s", async (code, expected) => {
      const status = JSON.parse(fixture("gitlab/status.json"));
      status.result.status_overall.status_code = code;
      // Only the page's own code is under test: no incident to raise it.
      status.result.incidents = [];
      stubFetch({ [URLS.gitlab]: json(status) });
      const gitlab = await collect("gitlab");
      expect(gitlab.failure).toBeUndefined();
      expect(gitlab.health).toBe(expected);
    });

    it.each([[undefined], [null], ["100"], [0], [700], [150]])(
      "GitLab: a status_code of %j is unknown with a parser failure, not an all-clear",
      async (code) => {
        const status = JSON.parse(fixture("gitlab/status.json"));
        status.result.status_overall.status_code = code;
        stubFetch({ [URLS.gitlab]: json(status) });
        const gitlab = await collect("gitlab");
        expect(gitlab.health).toBe("unknown");
        expect(gitlab.failure).toEqual({ kind: "parser", message: "Status.io reply has no readable overall status." });
      },
    );

    it("GitLab: active maintenance on an otherwise operational page is maintenance, and names the window", async () => {
      const status = JSON.parse(fixture("gitlab/status.json"));
      status.result.status_overall.status_code = 100;
      status.result.incidents = [];
      status.result.maintenance.active = [{ name: "Registry maintenance", _id: "m1" }];
      stubFetch({ [URLS.gitlab]: json(status) });
      const gitlab = await collect("gitlab");
      expect(gitlab.health).toBe("maintenance");
      expect(gitlab.summary).toBe("Registry maintenance");
    });

    it("GitLab: an open incident raises an operational page, and one with no status still counts as degraded", async () => {
      const status = JSON.parse(fixture("gitlab/status.json"));
      status.result.status_overall.status_code = 100;
      status.result.incidents = [
        { name: "Pipelines delayed", _id: "i1", datetime_open: "2026-09-20T10:00:00.000Z", messages: [] },
      ];
      stubFetch({ [URLS.gitlab]: json(status) });
      const gitlab = await collect("gitlab");
      expect(gitlab.health).toBe("degraded");
      expect(gitlab.incidents[0]).toMatchObject({ title: "Pipelines delayed", health: "unknown" });
    });

    it("GitLab: an open incident whose newest update says operational is a notice, not a problem", async () => {
      const status = JSON.parse(fixture("gitlab/status.json"));
      status.result.status_overall.status_code = 100;
      status.result.status_overall.status = "Operational";
      status.result.incidents = [
        {
          name: "Pipelines delayed",
          _id: "i1",
          datetime_open: "2026-09-20T10:00:00.000Z",
          messages: [
            { state: 100, status: 300, datetime: "2026-09-20T10:00:00.000Z" },
            { state: 300, status: 100, datetime: "2026-09-20T11:00:00.000Z" },
          ],
        },
      ];
      stubFetch({ [URLS.gitlab]: json(status) });
      const gitlab = await collect("gitlab");
      expect(gitlab.health).toBe("operational");
      expect(gitlab.incidents).toHaveLength(1);
      expect(gitlab.incidents[0]).toMatchObject({
        title: "Pipelines delayed",
        health: "operational",
        informational: true,
      });
      // Listed, but not counted: the card does not read "Up. 1 resolved recently."
      expect(gitlab.summary).not.toMatch(/resolved|1 incident/i);
    });

    it("GitLab: a service disruption in a component is an outage", async () => {
      const status = JSON.parse(fixture("gitlab/status.json"));
      status.result.status[2].status_code = 500;
      status.result.status[2].status = "Service Disruption";
      stubFetch({ [URLS.gitlab]: json(status) });
      const gitlab = await collect("gitlab");
      expect(gitlab.components[0]).toMatchObject({ name: "Git Operations", health: "outage" });
    });

    it("GitLab: an incident link that would leave the vendor's host falls back to the card's page", async () => {
      const status = JSON.parse(fixture("gitlab/status.json"));
      status.result.incidents[0]._id = "../../..//evil.example/x";
      stubFetch({ [URLS.gitlab]: json(status) });
      const url = (await collect("gitlab")).incidents[0].url ?? "";
      expect(new URL(url).host).toBe("status.gitlab.com");
    });

    it("Confluence summary.json: a major outage leads, with its incidents worst first; groups are not rows", async () => {
      stubFetch({ [URLS.confluence]: json(JSON.parse(fixture("confluence/summary.json"))) });
      const confluence = await collect("confluence");
      expect(confluence.failure).toBeUndefined();
      expect(confluence.health).toBe("outage");
      expect(confluence.summary).toBe("Users cannot edit pages in Confluence Cloud");
      expect(confluence.components.map((c) => [c.name, c.health])).toEqual([
        ["Editor", "outage"],
        ["Notifications", "degraded"],
        ["Search", "operational"],
        ["Marketplace Apps", "operational"],
      ]);
      expect(confluence.incidents.map((i) => [i.title, i.health])).toEqual([
        ["Users cannot edit pages in Confluence Cloud", "outage"],
        ["Delayed email notifications", "degraded"],
      ]);
      expect(confluence.upcomingMaintenance).toBeUndefined();
    });

    it.each(["github", "confluence"] as const)(
      "%s: a JSON body that is not a Statuspage summary is unknown with a parser failure",
      async (id) => {
        stubFetch({ [URLS[id]]: json(JSON.parse(fixture(`${id}/summary-malformed.json`))) });
        const snapshot = await collect(id);
        expect(snapshot.health).toBe("unknown");
        expect(snapshot.failure).toEqual({ kind: "parser", message: "Statuspage summary has no status." });
        expect(snapshot.incidents).toEqual([]);
        expect(snapshot.components).toEqual([]);
      },
    );

    it("GitLab: a JSON body that is not a Status.io status is unknown with a parser failure", async () => {
      stubFetch({ [URLS.gitlab]: json(JSON.parse(fixture("gitlab/status-malformed.json"))) });
      const gitlab = await collect("gitlab");
      expect(gitlab.health).toBe("unknown");
      expect(gitlab.failure).toEqual({ kind: "parser", message: "Status.io reply has no result." });
      expect(gitlab.incidents).toEqual([]);
      expect(gitlab.components).toEqual([]);
    });

    // Dense payloads: the largest bodies the 4 MiB cap lets through, made of the
    // smallest entries (`{}`, three bytes with its comma), so an array holds the
    // most rows a body can. Reading such a body once mapped every row before
    // any cap applied (about 190 MiB of heap for a million components, fatal
    // under a 128 MiB heap); the arrays are now cut first, so the work is
    // bounded by MAX_SCANNED_ROWS, not by the body.
    const DENSE_BUDGET_MS = 5000;
    const dense = (rows: number, row = "{}") => `[${Array.from({ length: rows }, () => row).join(",")}]`;
    const raw = (body: string): Handler => {
      expect(body.length).toBeLessThan(MAX_BODY_BYTES);
      return () => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };

    it("GitLab: a dense Status.io body (900,000 components, 200,000 incidents, 200,000 maintenance) is cut before it is mapped", async () => {
      const body = `{"result":{"status_overall":{"status":"Operational","status_code":100},"status":${dense(900_000)},"incidents":${dense(200_000)},"maintenance":{"active":${dense(100_000)},"upcoming":${dense(100_000)}}}}`;
      stubFetch({ [URLS.gitlab]: raw(body) });
      const started = performance.now();
      const gitlab = await collect("gitlab");
      expect(performance.now() - started).toBeLessThan(DENSE_BUDGET_MS);
      expect(gitlab.failure).toBeUndefined();
      // Counts are of what was read: the first MAX_SCANNED_ROWS of each array, never the body's millions.
      expect(gitlab.components).toHaveLength(300);
      expect(gitlab.componentCount).toBe(MAX_SCANNED_ROWS);
      expect(gitlab.incidents).toHaveLength(50);
      expect(gitlab.incidentCount).toBe(MAX_SCANNED_ROWS);
      expect(gitlab.upcomingMaintenance?.length ?? 0).toBeLessThanOrEqual(3);
    });

    it("GitLab: a component with 50,000 containers and an incident with 100,000 messages are cut to the nested bound", async () => {
      // The first MAX_NESTED_ROWS containers are fine; every one past them is down.
      const fine = dense(MAX_NESTED_ROWS, '{"name":"ok","status_code":100}').slice(1, -1);
      const down = dense(50_000, '{"name":"late","status_code":300}').slice(1, -1);
      const containers = `[${fine},${down}]`;
      const message = '{"status":300}';
      const body = `{"result":{"status_overall":{"status":"Operational","status_code":100},"status":[{"name":"Git","status_code":300,"status":"Degraded","containers":${containers}}],"incidents":[{"_id":"a","name":"Slow","messages":${dense(100_000, message)}}]}}`;
      stubFetch({ [URLS.gitlab]: raw(body) });
      const started = performance.now();
      const gitlab = await collect("gitlab");
      expect(performance.now() - started).toBeLessThan(DENSE_BUDGET_MS);
      expect(gitlab.failure).toBeUndefined();
      // The containers past the bound are not read, so none is named as affected.
      expect(gitlab.components[0]).toEqual({ name: "Git", health: "degraded", detail: "Degraded" });
      expect(gitlab.incidents[0]).toMatchObject({ id: "a", title: "Slow", health: "degraded" });
    });

    it.each(["github", "confluence"] as const)(
      "%s: a dense Statuspage body (900,000 components, 300,000 incidents, 100,000 maintenance) is cut before it is mapped",
      async (id) => {
        const body = `{"status":{"indicator":"none","description":"All Systems Operational"},"components":${dense(900_000)},"incidents":${dense(300_000)},"scheduled_maintenances":${dense(100_000)}}`;
        stubFetch({ [URLS[id]]: raw(body) });
        const started = performance.now();
        const snapshot = await collect(id);
        expect(performance.now() - started).toBeLessThan(DENSE_BUDGET_MS);
        expect(snapshot.failure).toBeUndefined();
        expect(snapshot.components).toHaveLength(300);
        expect(snapshot.componentCount).toBe(MAX_SCANNED_ROWS);
        expect(snapshot.incidents).toHaveLength(50);
        expect(snapshot.incidentCount).toBe(MAX_SCANNED_ROWS);
      },
    );

    const azureItem = (i: number) =>
      `<item><title>Outage ${i}</title><pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate></item>`;

    it("Azure: a dense feed past the scan bound is unknown with a parser failure, never an all-clear", async () => {
      const xml = `<rss><channel>${Array.from({ length: 40_000 }, (_, i) => azureItem(i)).join("")}</channel></rss>`;
      stubFetch({ [URLS.azure]: raw(xml) });
      const started = performance.now();
      const azure = await collect("azure");
      expect(performance.now() - started).toBeLessThan(DENSE_BUDGET_MS);
      expect(azure.health).toBe("unknown");
      expect(azure.failure).toEqual({
        kind: "parser",
        message: `RSS feed has more than ${MAX_RSS_SCANNED} items.`,
      });
      expect(azure.incidents).toEqual([]);
    });

    it("Azure: a feed of exactly the scan bound is read, and keeps MAX_RSS_ITEMS", async () => {
      const xml = `<rss><channel>${Array.from({ length: MAX_RSS_SCANNED }, (_, i) => azureItem(i)).join("")}</channel></rss>`;
      stubFetch({ [URLS.azure]: raw(xml) });
      const azure = await collect("azure");
      expect(azure.failure).toBeUndefined();
      expect(azure.incidents).toHaveLength(50);
      expect(azure.incidentCount).toBe(MAX_RSS_ITEMS);
    });

    it("Grok: an oldest-first feed with its current outage past the scan bound is unknown, not operational", async () => {
      const old = (i: number) =>
        `<item><title>Old ${i}</title><description>Status: Resolved</description><pubDate>Sun, 01 Mar 2026 10:00:00 GMT</pubDate></item>`;
      const current = `<item><title>Major outage</title><description>Major outage</description><pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate></item>`;
      const xml = `<rss><channel>${Array.from({ length: MAX_RSS_SCANNED }, (_, i) => old(i)).join("")}${current}</channel></rss>`;
      stubFetch({ [URLS.grok]: raw(xml) });
      const grok = await collect("grok");
      expect(grok.health).toBe("unknown");
      expect(grok.failure?.kind).toBe("parser");
      expect(grok.incidents).toEqual([]);
    });

    it("Azure: an Atom document (feed-malformed.xml) is unknown with a parser failure", async () => {
      stubFetch({ [URLS.azure]: text(fixture("azure/feed-malformed.xml")) });
      const azure = await collect("azure");
      expect(azure.health).toBe("unknown");
      expect(azure.failure).toEqual({ kind: "parser", message: "Azure feed was not an RSS channel." });
      expect(azure.incidents).toEqual([]);
      expect(azure.components).toEqual([]);
    });

    it.each(["github", "confluence", "gitlab"] as const)(
      "%s: a body that is not JSON, and a null body, are parser failures",
      async (id) => {
        stubFetch({ [URLS[id]]: text("<html>Attention Required</html>") });
        expect((await collect(id)).failure?.kind).toBe("parser");
        stubFetch({ [URLS[id]]: json(null) });
        expect((await collect(id)).failure?.kind).toBe("parser");
      },
    );

    it.each(["github", "confluence", "gitlab"] as const)("%s: a 503 is unknown with an http failure", async (id) => {
      stubFetch({ [URLS[id]]: text("down", { status: 503 }) });
      const snapshot = await collect(id);
      expect(snapshot.health).toBe("unknown");
      expect(snapshot.failure).toMatchObject({ kind: "http", status: 503 });
    });

    it("GitHub: an incident link off Statuspage's and the vendor's hosts falls back to the card's page", async () => {
      const summary = JSON.parse(fixture("github/summary.json"));
      summary.incidents[0].shortlink = "https://evil.example/q2zmv0t6k8x1";
      stubFetch({ [URLS.github]: json(summary) });
      expect((await collect("github")).incidents[0].url).toBe("https://www.githubstatus.com/");
    });

    it("Azure feed.xml: unresolved recent items are incidents, worst first; resolved, review and stale items are not", async () => {
      stubFetch({ [URLS.azure]: text(fixture("azure/feed.xml")) });
      const azure = await collect("azure");
      expect(azure.failure).toBeUndefined();
      expect(azure.health).toBe("outage");
      expect(azure.summary).toBe("Virtual Machines - UK South - Service unavailable");
      expect(azure.components).toEqual([]);
      expect(azure.incidents).toEqual([
        {
          id: "https://azure.status.microsoft/en-us/status/#azure-2026-09-20-vm-uk-south",
          title: "Virtual Machines - UK South - Service unavailable",
          health: "outage",
          startedAt: "2026-09-20T07:05:00.000Z",
          url: "https://azure.status.microsoft/en-us/status/#azure-2026-09-20-vm-uk-south",
        },
        {
          id: "https://azure.status.microsoft/en-us/status/#azure-2026-09-20-sql-west-europe",
          title: "Azure SQL Database - West Europe - Investigating degraded connectivity",
          health: "degraded",
          startedAt: "2026-09-20T10:20:00.000Z",
          url: "https://azure.status.microsoft/en-us/status/#azure-2026-09-20-sql-west-europe",
        },
      ]);
      expect(azure.sourceUrl).toBe("https://azure.status.microsoft/en-us/status/");
    });

    it("Azure feed.xml: a channel with no items is operational, not a failure", async () => {
      stubFetch({
        [URLS.azure]: text(
          '<?xml version="1.0"?><rss version="2.0"><channel><title>Azure Status</title></channel></rss>',
        ),
      });
      const azure = await collect("azure");
      expect(azure.failure).toBeUndefined();
      expect(azure.health).toBe("operational");
      expect(azure.incidents).toEqual([]);
    });

    it("Azure feed.xml: only resolved items leave the card operational", async () => {
      const feed = fixture("azure/feed.xml");
      const resolvedOnly =
        feed.slice(0, feed.indexOf("<item>")) +
        feed.slice(feed.indexOf("<item>", feed.indexOf("azure-2026-09-19-storage-resolved") - 80));
      stubFetch({ [URLS.azure]: text(resolvedOnly) });
      const azure = await collect("azure");
      expect(azure.health).toBe("operational");
      expect(azure.incidents).toEqual([]);
    });

    it("Azure feed.xml: maintenance is maintenance, and an item without a date or with a foreign link is handled", async () => {
      const item = (title: string, extra: string) =>
        `<item><title>${title}</title>${extra}<description>Impact.</description></item>`;
      stubFetch({
        [URLS.azure]: text(
          '<rss version="2.0"><channel>' +
            item(
              "Planned maintenance - Key Vault",
              "<pubDate>Sun, 20 Sep 2026 08:00:00 GMT</pubDate><link>https://evil.example/x</link>",
            ) +
            item("Undated incident", "") +
            "</channel></rss>",
        ),
      });
      const azure = await collect("azure");
      expect(azure.health).toBe("maintenance");
      // The undated item cannot be shown to be current; the foreign link is replaced by the card's page.
      expect(azure.incidents).toHaveLength(1);
      expect(azure.incidents[0]).toMatchObject({
        title: "Planned maintenance - Key Vault",
        health: "maintenance",
        url: "https://azure.status.microsoft/en-us/status/",
      });
    });

    it("Azure feed.xml: resolution words inside an active item do not end the incident", async () => {
      const when = new Date(Date.now() - 3_600_000).toUTCString();
      const item = (title: string, description: string) =>
        `<item><title>${title}</title><pubDate>${when}</pubDate><description>${description}</description></item>`;
      stubFetch({
        [URLS.azure]: text(
          `<rss version="2.0"><channel>${[
            item("Storage - East US", "We have partially mitigated the issue and are continuing to restore service."),
            item("Networking - Global", "The issue has not been fully mitigated."),
            item("SQL - West Europe", "Services have been restored in East US; West Europe remains impacted."),
            item("App Service - Central US", "We will provide a root cause analysis once mitigated."),
          ].join("")}</channel></rss>`,
        ),
      });
      const azure = await collect("azure");
      expect(azure.failure).toBeUndefined();
      expect(azure.health).toBe("degraded");
      expect(azure.incidents).toHaveLength(4);
    });

    it.each([
      "Preliminary Post Incident Review (PIR) – Azure Front Door – Outage across multiple regions",
      "Final Post Incident Review (PIR) – Azure Front Door – Outage across multiple regions",
      "Final-PIR – Storage – East US",
    ])("Azure feed.xml: %j is over, so the card stays operational", async (title) => {
      const when = new Date(Date.now() - 3_600_000).toUTCString();
      stubFetch({
        [URLS.azure]: text(
          `<rss version="2.0"><channel><item><title>${title}</title><pubDate>${when}</pubDate></item></channel></rss>`,
        ),
      });
      const azure = await collect("azure");
      expect(azure.failure).toBeUndefined();
      expect(azure.health).toBe("operational");
      expect(azure.incidents).toEqual([]);
    });

    it("Azure feed.xml: items that are not over, none with a readable date, are unknown with a parser failure", async () => {
      stubFetch({
        [URLS.azure]: text(
          '<rss version="2.0"><channel><item><title>Virtual Machines - UK South - Service unavailable</title></item><item><title>Storage - East US</title><pubDate>not a date</pubDate></item></channel></rss>',
        ),
      });
      const azure = await collect("azure");
      expect(azure.health).toBe("unknown");
      expect(azure.failure).toEqual({ kind: "parser", message: "Azure feed items have no readable date." });
      expect(azure.incidents).toEqual([]);
    });

    it("Azure feed.xml: undated items that are over do not make the feed unreadable", async () => {
      stubFetch({
        [URLS.azure]: text(
          '<rss version="2.0"><channel><item><title>RESOLVED - Storage - East US</title></item></channel></rss>',
        ),
      });
      const azure = await collect("azure");
      expect(azure.failure).toBeUndefined();
      expect(azure.health).toBe("operational");
    });

    it("Azure feed.xml: a word in the description that suggests an outage does not make one", async () => {
      const when = new Date(Date.now() - 3_600_000).toUTCString();
      stubFetch({
        [URLS.azure]: text(
          `<rss version="2.0"><channel><item><title>Storage - East US - Increased latency</title><pubDate>${when}</pubDate><description>Requests may be intermittently unavailable in one region. Drill down in Service Health.</description></item></channel></rss>`,
        ),
      });
      expect((await collect("azure")).health).toBe("degraded");
    });

    it.each([
      [
        "an Atom feed",
        '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>x</title></entry></feed>',
      ],
      ["an HTML page", "<html><body>Service Unavailable</body></html>"],
      ["an empty body", ""],
    ])("Azure feed: %s is unknown with a parser failure", async (_name, body) => {
      stubFetch({ [URLS.azure]: text(body) });
      const azure = await collect("azure");
      expect(azure.health).toBe("unknown");
      expect(azure.failure).toEqual({ kind: "parser", message: "Azure feed was not an RSS channel." });
      expect(azure.incidents).toEqual([]);
    });

    it("Azure feed: a 403 is unknown with an http failure naming the vendor host", async () => {
      stubFetch({ [URLS.azure]: text("Forbidden", { status: 403 }) });
      const azure = await collect("azure");
      expect(azure.health).toBe("unknown");
      expect(azure.failure).toMatchObject({ kind: "http", status: 403 });
      expect(azure.summary).toContain("azure.status.microsoft");
    });

    it("MikroTik: every channel becomes a component, and the collector reads the version channels only", async () => {
      const asked: string[] = [];
      const routes = mikrotikChannels((file) => fixture(`mikrotik/${file}`));
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith(URLS.mikrotikDownload)) asked.push(url);
        return routes[url]?.() ?? new Response("not found", { status: 404 });
      });
      const mikrotik = await collect("mikrotik");
      expect(mikrotik.failure).toBeUndefined();
      expect(mikrotik.health).toBe("operational");
      // The changelogs are the board's business, after the sweep (mikrotik-notes.server.ts): the collector
      // never asks for one, so its result cannot depend on how fast or whether the changelog host answers.
      expect(asked).toEqual([]);
      expect(mikrotik.summary).toBe("Latest RouterOS 7.20.2 · Sep 15");
      // Released within 14 days reads as "maintenance": a fresh release is
      // worth a look, not an all-clear.
      expect(mikrotik.components.map(({ name, health, detail }) => ({ name, health, detail }))).toEqual([
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

    it("MikroTik: each channel's Details carry its version, date and changelog link, and no notes yet", async () => {
      stubFetch(mikrotikChannels((file) => fixture(`mikrotik/${file}`)));
      const mikrotik = await collect("mikrotik");
      const release = (name: string) => mikrotik.components.find((component) => component.name === name)?.release;
      expect(release("RouterOS 7 stable")).toEqual({
        version: "7.20.2",
        releasedAt: "2026-09-15T12:00:00.000Z",
        url: "https://download.mikrotik.com/routeros/7.20.2/CHANGELOG",
        linkLabel: "Release notes",
      });
      expect(mikrotik.components.every((component) => component.release?.notes === undefined)).toBe(true);
    });

    it("MikroTik: the headline pairs the displayed channel's version with its own date", async () => {
      // Stable (7.20.2, Sep 15) is shown even though development (7.21beta4) is newer, Sep 19.
      stubFetch(mikrotikChannels((file) => fixture(`mikrotik/${file}`)));
      expect((await collect("mikrotik")).summary).toBe("Latest RouterOS 7.20.2 · Sep 15");
      // Without a stable channel the newest one is displayed, with its own date.
      const routes = mikrotikChannels((file) => fixture(`mikrotik/${file}`));
      delete routes[`${URLS.mikrotikUpgrade}NEWESTa7.stable`];
      stubFetch(routes);
      expect((await collect("mikrotik")).summary).toBe("Latest RouterOS 7.21beta4 · Sep 19");
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
      expect(appleOs.components.map(({ name, health, detail }) => ({ name, health, detail }))).toEqual([
        { name: "iOS", health: "maintenance", detail: "27.2 beta 2 (24B5089g) · Sep 21" },
        { name: "iPadOS", health: "maintenance", detail: "27.2 beta 2 (24B5089g) · Sep 21" },
        { name: "macOS", health: "maintenance", detail: "27.2 beta 2 (26B5091g) · Sep 21" },
        { name: "watchOS", health: "maintenance", detail: "27.2 beta 2 (24S5091f) · Sep 21" },
        { name: "tvOS", health: "maintenance", detail: "27.2 beta 2 (24K5093g) · Sep 21" },
        { name: "visionOS", health: "operational", detail: "27.0 (24M362) · Sep 14" },
      ]);
      // The Details: the build apart from the version, the feed's own date and the release's page on apple.com;
      // the feed has no notes text, so there is none.
      expect(appleOs.components[0].release).toEqual({
        version: "27.2 beta 2",
        build: "24B5089g",
        releasedAt: "2026-09-21T17:00:00.000Z",
        url: "https://developer.apple.com/news/releases/?id=09212026a",
        // The post links the downloads and the notes; it is not the notes.
        linkLabel: "Apple Developer post",
      });
      expect(appleOs.components[5].release).toMatchObject({ version: "27.0", build: "24M362" });
      expect(appleOs.components.some((component) => component.release?.notes !== undefined)).toBe(false);
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

    it("Windows release health: the newest versions, headed by the newest one", async () => {
      // Hand-built from the page's known layout (see the fixtures README). The
      // clock puts only 26H2's availability (Sep 29) inside the 14-day window:
      // 26H1's Sep 22 update is a revision, not a new release. 23H2 is the
      // fifth row and is not kept.
      vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
      stubFetch({ [URLS.windows]: text(fixture("windows/windows11-release-information.html")) });
      const windows = await collect("windows");
      expect(windows.failure).toBeUndefined();
      expect(windows.health).toBe("operational");
      expect(windows.summary).toBe("Latest: Windows 11 26H2 (build 26300.1000) · Sep 29");
      expect(windows.components.map(({ name, health, detail }) => ({ name, health, detail }))).toEqual([
        { name: "26H2", health: "maintenance", detail: "26300.1000 · Sep 29" },
        { name: "26H1", health: "operational", detail: "28000.1575 · Sep 22" },
        { name: "25H2", health: "operational", detail: "26200.8100 · Sep 8" },
        { name: "24H2", health: "operational", detail: "26100.8100 · Sep 8" },
      ]);
      // The Details: bare UTC days (the table has no times), a later update only when it differs, and the page
      // itself as the link, since it has no notes text.
      const page = "https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information";
      expect(windows.components[0].release).toEqual({
        version: "26H2",
        build: "26300.1000",
        releasedAt: "2026-09-29",
        url: page,
      });
      expect(windows.components[1].release).toEqual({
        version: "26H1",
        build: "28000.1575",
        releasedAt: "2026-02-10",
        updatedAt: "2026-09-22",
        url: page,
      });
      expect(windows.incidents).toEqual([]);
      expect(windows.meta).toEqual({
        latest: "Windows 11 26H2 (build 26300.1000)",
        // The release fingerprint names each feature version, not its build: a monthly build bump must not
        // read as a new release. The build stays in the component details above.
        versions: "Windows 11 26H2=released|Windows 11 26H1=released|Windows 11 25H2=released|Windows 11 24H2=released",
      });
    });

    it.each(["America/Los_Angeles", "Pacific/Kiritimati"])(
      "Windows release health: the days read the same on a host in %s",
      async (tz) => {
        const zone = process.env.TZ;
        process.env.TZ = tz;
        try {
          vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
          stubFetch({ [URLS.windows]: text(fixture("windows/windows11-release-information.html")) });
          const windows = await collect("windows");
          expect(windows.summary).toBe("Latest: Windows 11 26H2 (build 26300.1000) · Sep 29");
          expect(windows.components[0].detail).toBe("26300.1000 · Sep 29");
        } finally {
          process.env.TZ = zone;
        }
      },
    );

    it("Windows release health: a version the page adds later becomes the headline and a fresh release", async () => {
      vi.setSystemTime(new Date("2027-09-30T12:00:00.000Z"));
      const page = fixture("windows/windows11-release-information.html").replace(
        '<tbody>\n<tr>\n<td><a href="#26h2">26H2</a></td>',
        '<tbody>\n<tr><td>27H2</td><td>General Availability Channel</td><td>2027-09-28</td><td>2027-09-28</td><td>27500.1</td></tr>\n<tr>\n<td><a href="#26h2">26H2</a></td>',
      );
      expect(page).toContain("27H2");
      stubFetch({ [URLS.windows]: text(page) });
      const windows = await collect("windows");
      expect(windows.failure).toBeUndefined();
      expect(windows.summary).toBe("Latest: Windows 11 27H2 (build 27500.1) · Sep 28");
      expect(windows.components.map((component) => [component.name, component.health])).toEqual([
        ["27H2", "maintenance"],
        ["26H2", "operational"],
        ["26H1", "operational"],
        ["25H2", "operational"],
      ]);
      expect(String(windows.meta?.versions).startsWith("Windows 11 27H2=released|Windows 11 26H2=released|")).toBe(
        true,
      );
    });

    it("Windows release health: a monthly build bump is no new release, a new feature version is", async () => {
      vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
      const original = fixture("windows/windows11-release-information.html");
      const board = async (page: string) => {
        stubFetch({ [URLS.windows]: text(page) });
        return assembleBoard([await collect("windows")], 0);
      };
      const before = await board(original);
      // Microsoft's monthly cumulative update: 26H2 moves from build 26300.1000 to 26300.1100.
      const bumped = original.replaceAll("26300.1000", "26300.1100");
      expect(bumped).not.toBe(original);
      const after = await board(bumped);
      const windows = after.services[0];
      // The build is on the card and in its Details...
      expect(windows.summary).toBe("Latest: Windows 11 26H2 (build 26300.1100) · Sep 29");
      expect(windows.components[0].release?.build).toBe("26300.1100");
      // ...and is no release: no change, no Changed bar, no Recent changes entry.
      expect(diffBoards(before, after)).toEqual([]);
      expect(releaseChange(before.services[0], windows)).toBe("");
      // A feature version the page adds is one.
      const added = original.replace(
        '<tbody>\n<tr>\n<td><a href="#26h2">26H2</a></td>',
        '<tbody>\n<tr><td>27H2</td><td>General Availability Channel</td><td>2026-09-30</td><td>2026-09-30</td><td>27500.1</td></tr>\n<tr>\n<td><a href="#26h2">26H2</a></td>',
      );
      expect(added).toContain("27H2");
      const next = await board(added);
      expect(diffBoards(after, next)).toEqual([
        expect.objectContaining({ id: "windows", release: true, summary: "Windows 11 27H2 released" }),
      ]);
    });

    it("Windows release health: a page without the versions table is unknown with a parser failure", async () => {
      stubFetch({ [URLS.windows]: text("<!DOCTYPE html><html><body><h1>Service unavailable</h1></body></html>") });
      const windows = await collect("windows");
      expect(windows.health).toBe("unknown");
      expect(windows.failure).toEqual({
        kind: "parser",
        message: "Windows release page had no readable version table.",
      });
      expect(windows.components).toEqual([]);
      expect(windows.meta).toBeUndefined();
    });

    it("Windows release health: a versions table whose rows hold no version or date is unknown too", async () => {
      stubFetch({
        [URLS.windows]: text(
          "<table><tr><th>Version</th><th>Availability date</th></tr><tr><td>coming soon</td><td>TBA</td></tr></table>",
        ),
      });
      const windows = await collect("windows");
      expect(windows.health).toBe("unknown");
      expect(windows.failure?.kind).toBe("parser");
    });

    it("Windows release health: a page over the size limit is unknown, not parsed", async () => {
      stubFetch({ [URLS.windows]: text(`<table>${"<tr><td>26H2</td></tr>".repeat(200_000)}</table>`) });
      const windows = await collect("windows");
      expect(windows.health).toBe("unknown");
      expect(windows.failure).toEqual({
        kind: "parser",
        message: "Response from learn.microsoft.com is larger than 4 MiB",
      });
    });

    it("Android releases page: the newest versions, headed by the newest one, with no date to mark one fresh", async () => {
      // A trimmed real capture of https://developer.android.com/about/versions
      // (2026-10-01). The page gives versions and no dates, so nothing is ever
      // "New release" here; a version that joins the list reaches the change
      // feed through the version map instead (see diff.test.ts).
      stubFetch({ [URLS.androidOs]: text(fixture("android-os/versions.html")) });
      const android = await collect("android-os");
      expect(android.failure).toBeUndefined();
      expect(android.health).toBe("operational");
      expect(android.summary).toBe("Latest: Android 17");
      // The page gives no date and no notes, so the Details have each version's own page and nothing else: the
      // version is the name (printed once) and "released" is not a version.
      expect(android.components).toEqual(
        [17, 16, 15, 14].map((version) => ({
          name: `Android ${version}`,
          health: "operational",
          detail: "released",
          release: {
            version: `Android ${version}`,
            url: `https://developer.android.com/about/versions/${version}`,
            linkLabel: `Android ${version} page`,
          },
        })),
      );
      expect(android.incidents).toEqual([]);
      expect(android.meta).toEqual({
        latest: "Android 17",
        versions: "Android 17=released|Android 16=released|Android 15=released|Android 14=released",
      });
    });

    it("Android releases page: a major version the page adds later becomes the headline on its own", async () => {
      const page = fixture("android-os/versions.html").replace(
        '<li class="devsite-nav-item"><a href="/about/versions/17"',
        '<li class="devsite-nav-item"><a href="/about/versions/18"\n        class="devsite-nav-title"\n      ><span class="devsite-nav-text" tooltip>Android 18</span></a></li>\n\n  <li class="devsite-nav-item"><a href="/about/versions/17"',
      );
      stubFetch({ [URLS.androidOs]: text(page) });
      const android = await collect("android-os");
      expect(android.failure).toBeUndefined();
      expect(android.summary).toBe("Latest: Android 18");
      expect(android.components.map((component) => component.name)).toEqual([
        "Android 18",
        "Android 17",
        "Android 16",
        "Android 15",
      ]);
      expect(String(android.meta?.versions).startsWith("Android 18=released|Android 17=released|")).toBe(true);
    });

    it("Android releases page: the footer alone is enough, and a repeated link counts once", async () => {
      const link = (n: number) => `<a href="/about/versions/${n}" class="x">\n  Android ${n}\n</a>`;
      stubFetch({ [URLS.androidOs]: text(`<ul>${link(16)}${link(16)}${link(17)}</ul>`) });
      const android = await collect("android-os");
      expect(android.components.map((component) => component.name)).toEqual(["Android 17", "Android 16"]);
    });

    it("Android releases page: a page without the version links is unknown with a parser failure", async () => {
      stubFetch({ [URLS.androidOs]: text("<!DOCTYPE html><html><body><h1>We'll be right back</h1></body></html>") });
      const android = await collect("android-os");
      expect(android.health).toBe("unknown");
      expect(android.failure).toEqual({
        kind: "parser",
        message: "Android releases page had no readable version list.",
      });
      expect(android.components).toEqual([]);
      expect(android.meta).toBeUndefined();
    });

    it("Android releases page: links to other pages or with other text are not versions", async () => {
      const page =
        '<a href="/about/versions/17/qpr1">Android 17</a><a href="/about/versions/17">Android Beta</a>' +
        '<a href="https://example.com/about/versions/17">Android 17</a><a href="/about/versions/pie">Android 9</a>' +
        '<a href="/about/versions/16"><img alt="Android 16"></a><a href="/about/versions/123">Android 123</a>';
      stubFetch({ [URLS.androidOs]: text(page) });
      const android = await collect("android-os");
      expect(android.health).toBe("unknown");
      expect(android.failure?.kind).toBe("parser");
    });

    it("Android releases page: a page over the size limit is unknown, not parsed", async () => {
      stubFetch({
        [URLS.androidOs]: text(`<ul>${'<a href="/about/versions/17">Android 17</a>'.repeat(120_000)}</ul>`),
      });
      const android = await collect("android-os");
      expect(android.health).toBe("unknown");
      expect(android.failure).toEqual({
        kind: "parser",
        message: "Response from developer.android.com is larger than 4 MiB",
      });
    });

    it("Android releases page: a redirect off the vendor's host is refused", async () => {
      stubFetch({
        [URLS.androidOs]: () =>
          new Response(null, { status: 302, headers: { location: "https://example.com/about/versions" } }),
      });
      const android = await collect("android-os");
      expect(android.health).toBe("unknown");
      expect(android.failure?.kind).toBe("network");
      expect(android.failure?.message).toContain("off the vendor's host");
    });

    it("Android releases page: a redirect within the vendor's host is followed", async () => {
      stubFetch({
        [URLS.androidOs]: () =>
          new Response(null, { status: 301, headers: { location: "https://developer.android.com/about/versions/" } }),
        "https://developer.android.com/about/versions/": text(fixture("android-os/versions.html")),
      });
      const android = await collect("android-os");
      expect(android.failure).toBeUndefined();
      expect(android.summary).toBe("Latest: Android 17");
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
        // Worst first, then catalogue order. The information-only notice
        // (SERVICE_INFORMATION) reports no impact, so Cloud Storage stays
        // Operational: it is not degraded and it is not a row of its own.
        expect(gcp.components).toEqual([
          { name: "Google Compute Engine", health: "outage", detail: "Belgium (europe-west1)" },
          { name: "Cloud Run", health: "degraded", detail: "Elevated latency for new deployments" },
          { name: "Google Cloud Storage", health: "operational" },
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
        // The notice names no affected service, so it adds no row.
        expect(gcp.components.map((c) => c.name)).toEqual(["Google Compute Engine", "Cloud Run"]);
      });

      it("keeps the per-incident components when the catalogue is malformed", async () => {
        for (const body of [json("nope"), json({ products: "x" }), json(null), text("<html>blocked</html>")]) {
          stubFetch({ [URLS.gcp]: text(fixture("gcp/incidents.json")), [URLS.gcpProducts]: body });
          const gcp = await collect("gcp");
          expect(gcp.failure).toBeUndefined();
          expect(gcp.components).toHaveLength(2);
        }
      });

      it("keeps a full 215-product catalogue whole, with no reported total", async () => {
        stubFetch({ [URLS.gcp]: json([]), [URLS.gcpProducts]: json(googleProducts(215)) });
        const gcp = await collect("gcp");
        expect(gcp.components).toHaveLength(215);
        expect(gcp.componentCount).toBeUndefined();
        expect(gcp.components.every((c) => c.health === "operational")).toBe(true);
      });

      it("caps a long catalogue at 300 with the broken product first and reports the total", async () => {
        stubFetch({
          [URLS.gcp]: json([
            googleIncident({
              status_impact: "SERVICE_OUTAGE",
              affected_products: [{ title: "Product 310", id: "p310" }],
            }),
          ]),
          [URLS.gcpProducts]: json(googleProducts(320)),
        });
        const gcp = await collect("gcp");
        expect(gcp.components).toHaveLength(300);
        expect(gcp.componentCount).toBe(320);
        expect(gcp.components[0]).toEqual({ name: "Product 310", health: "outage", detail: "Elevated errors" });
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

      it("adds an operational component when the directory lists connection managers", async () => {
        stubFetch({ ...steamOk, [URLS.steamCm]: text(fixture("steam/cm-list.json")) });
        const steam = await collect("steam");
        expect(steam.health).toBe("operational");
        expect(steam.components).toEqual([
          { name: "Steam Web API", health: "operational" },
          { name: "Steam Store", health: "operational" },
          { name: "Steam Connection Managers", health: "operational", detail: "3 servers listed" },
        ]);
      });

      it("leaves the row out, and the card alone, for an empty list or an unexpected shape", async () => {
        for (const body of [
          json({ response: { serverlist: [], success: true } }),
          json({ response: { serverlist: [{ endpoint: "cm1:27017" }], success: false } }),
          json({ response: { serverlist: ["cm1:27017"] } }),
          json({ response: {} }),
          json({ unexpected: true }),
          json(null),
        ]) {
          stubFetch({ ...steamOk, [URLS.steamCm]: body });
          const steam = await collect("steam");
          expect(steam.failure).toBeUndefined();
          expect(steam.health).toBe("operational");
          expect(steam.components.map((c) => c.name)).toEqual(["Steam Web API", "Steam Store"]);
        }
      });

      it("leaves the row out, and the card alone, when the directory cannot be fetched", async () => {
        for (const cm of [
          undefined,
          text("Unavailable", { status: 503, statusText: "Service Unavailable" }),
          networkError("connection reset"),
        ]) {
          stubFetch({ ...steamOk, [URLS.steamCm]: cm });
          const steam = await collect("steam");
          expect(steam.failure).toBeUndefined();
          expect(steam.health).toBe("operational");
          expect(steam.components.map((c) => c.name)).toEqual(["Steam Web API", "Steam Store"]);
        }
      });

      it("times only the Web API and Store requests, not the slow connection-manager request", async () => {
        stubFetch({
          ...steamOk,
          [URLS.steamCm]: async () => {
            // Real timers, fake clock: the directory answers "late" by moving the clock.
            await new Promise((resolve) => setTimeout(resolve, 30));
            vi.setSystemTime(Date.now() + 3500);
            return text(fixture("steam/cm-list.json"))();
          },
        });
        const steam = await collect("steam");
        expect(steam.components.at(-1)?.name).toBe("Steam Connection Managers");
        expect(steam.latencyMs).toBe(0);
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
          { name: "Voice mode", health: "outage" },
          { name: "grok.com", health: "degraded" },
          { name: "Image generation", health: "maintenance", detail: "Maintenance window" },
          { name: "iOS app", health: "operational" },
          { name: "API", health: "operational" },
        ]);
      });

      it("derives components from the titles' [Service] leads when there is no component endpoint", async () => {
        stubFetch({ [URLS.grok]: text(fixture("grok/feed-prefixed.xml")) });
        const grok = await collect("grok");
        expect(grok.health).toBe("outage");
        // [API] has two active items: the worst health and the newest detail.
        // [Grok (iOS)] is resolved and the unbracketed title names no service.
        expect(grok.components).toEqual([
          { name: "API", health: "outage", detail: "Requests failing for some models" },
          { name: "Grok (Web)", health: "degraded", detail: "Slow page loads" },
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
          expect(grok.components.map((c) => c.name)).toEqual(["API", "Grok (Web)"]);
        }
      });

      it("shows no components, and invents none, when the feed titles carry no prefix", async () => {
        stubFetch({ [URLS.grok]: feed() });
        const grok = await collect("grok");
        expect(grok.health).toBe("degraded");
        expect(grok.components).toEqual([]);
        expect(grok.componentCount).toBeUndefined();
      });

      it("caps a long component list at 300 and reports the total", async () => {
        const components = Array.from({ length: 310 }, (_, i) => ({
          id: String(i),
          name: `Part ${i}`,
          status: i === 309 ? "MAJOROUTAGE" : "OPERATIONAL",
        }));
        stubFetch({ [URLS.grok]: feed(), [URLS.grokComponents]: json({ components }) });
        const grok = await collect("grok");
        expect(grok.components).toHaveLength(300);
        expect(grok.componentCount).toBe(310);
        expect(grok.components[0]).toEqual({ name: "Part 309", health: "outage" });
      });

      it("ignores a component list whose statuses are all unreadable and uses the feed's [Service] titles", async () => {
        stubFetch({
          [URLS.grok]: text(fixture("grok/feed-prefixed.xml")),
          [URLS.grokComponents]: json({
            components: [
              { name: "API", status: "SOMETHING" },
              { name: "Chat", status: "" },
            ],
          }),
        });
        const grok = await collect("grok");
        expect(grok.components.map((c) => c.name)).toEqual(["API", "Grok (Web)"]);
      });

      it("takes the card's health from every active item, not only the 8 listed as incidents", async () => {
        const item = (n: number, severity: string) =>
          `<item><title>[Service ${n}] Trouble</title><link>https://status.x.ai/svc/INC${n}</link>` +
          `<pubDate>Sun, 20 Sep 2026 09:${String(n).padStart(2, "0")}:00 GMT</pubDate>` +
          `<description><![CDATA[<h3>Status: ONGOING</h3><p>Severity: ${severity}</p>]]></description></item>`;
        const items = Array.from({ length: 9 }, (_, i) => item(i, i === 8 ? "outage" : "degraded")).join("");
        stubFetch({
          [URLS.grok]: text(
            `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items}</channel></rss>`,
          ),
        });
        const grok = await collect("grok");
        expect(grok.incidents).toHaveLength(8);
        expect(grok.health).toBe("outage");
        // The worst row is listed first, and the card is no better than it.
        expect(grok.components[0]).toMatchObject({ name: "Service 8", health: "outage" });
        expect(grok.components).toHaveLength(9);
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
      // An hour before the clock this block pins (an event dated after it would not be current).
      const at = Math.floor(Date.parse("2026-09-20T12:00:00.000Z") / 1000) - 3600;
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

      it("merges events per service: worst health wins, all regions, the newest event's summary is the detail", async () => {
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
          {
            name: "Amazon Elastic Compute Cloud",
            health: "outage",
            detail: "N. Virginia · Newest: multi-region outage",
          },
          { name: "AWS Lambda", health: "degraded", detail: "N. Virginia · Invoke latency" },
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

      it("caps at 300 services, keeping the worst, and reports the total", async () => {
        serve(
          Array.from({ length: 310 }, (_, i) =>
            awsEvent({
              service_name: `Service ${i}`,
              service: `svc-${i}`,
              region_name: "",
              summary: i === 307 ? "Outage" : "Elevated latency",
              event_log: [
                {
                  summary: i === 307 ? "Outage" : "Elevated latency",
                  message: i === 307 ? "The service is unavailable." : "Slow.",
                  status: 1,
                  timestamp: at,
                },
              ],
            }),
          ),
        );
        const aws = await collect("aws");
        expect(aws.components).toHaveLength(300);
        expect(aws.componentCount).toBe(310);
        // The outage sits past the 300th event, and still leads the list.
        expect(aws.components[0]).toEqual({ name: "Service 307", health: "outage", detail: "Outage" });
        expect(aws.components.slice(1).map((c) => c.name)).toEqual(
          Array.from({ length: 299 }, (_, i) => `Service ${i}`),
        );
      });
    });
  });
});

describe("collectors bound vendor text and counts", () => {
  const HUGE = "y".repeat(100_000);

  beforeEach(() => {
    stubFetch({});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function collect(id: ServiceId): Promise<ServiceSnapshot> {
    const snapshot = (await collectAllServices()).find((s) => s.id === id);
    if (!snapshot) throw new Error(`no snapshot for ${id}`);
    return snapshot;
  }

  it("Statuspage: clips names, details, titles and the summary to their limits", async () => {
    stubFetch({
      [URLS.claude]: json(
        statuspageSummary({
          indicator: "major",
          components: [{ id: "c", name: HUGE, status: "major_outage" }],
          incidents: [{ id: "i", name: HUGE, status: "investigating", impact: "major" }],
          scheduled_maintenances: [{ id: "m", name: HUGE, status: "scheduled", scheduled_for: "2026-09-25T02:00:00Z" }],
        }),
      ),
    });
    const claude = await collect("claude");
    expect(claude.components[0].name).toHaveLength(120);
    expect(claude.components[0].name.endsWith("…")).toBe(true);
    expect(claude.incidents[0].title).toHaveLength(300);
    expect(claude.upcomingMaintenance?.[0].title).toHaveLength(300);
    // The summary is the worst incident's title, so it is cut like the title:
    // the board prints that incident once by matching the two.
    expect(claude.summary).toBe(claude.incidents[0].title);
  });

  it("Statuspage: clips a long status description used as the summary", async () => {
    stubFetch({
      [URLS.claude]: json({
        status: { indicator: "minor", description: HUGE },
        components: [],
        incidents: [],
        scheduled_maintenances: [],
      }),
    });
    expect((await collect("claude")).summary).toHaveLength(500);
  });

  it("Google: clips long affected locations and descriptions, per string and not per count", async () => {
    stubFetch({
      [URLS.gcp]: json([
        {
          ...googleIncident({ external_desc: HUGE }),
          currently_affected_locations: [{ title: HUGE }, { title: HUGE }],
        },
      ]),
    });
    const gcp = await collect("gcp");
    expect(gcp.incidents[0].title).toHaveLength(300);
    expect(gcp.components[0].name).toBe("Compute Engine");
    expect(gcp.components[0].detail).toHaveLength(500);
    expect(gcp.summary.length).toBeLessThanOrEqual(500);
  });

  it("Statuspage: a feed of thousands of incidents lists the worst 50, outage first", async () => {
    const minor = Array.from({ length: 1500 }, (_, i) => ({
      id: `minor-${i}`,
      name: `Minor ${i}`,
      status: "investigating",
      impact: "minor",
      started_at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    }));
    const notices = Array.from({ length: 600 }, (_, i) => ({
      id: `note-${i}`,
      name: `Note ${i}`,
      status: "monitoring",
      impact: "none",
    }));
    stubFetch({
      [URLS.claude]: json(
        statuspageSummary({
          indicator: "major",
          // The outage is listed last, behind two thousand milder items.
          incidents: [
            ...notices,
            ...minor,
            { id: "outage", name: "Total outage", status: "investigating", impact: "critical" },
          ],
        }),
      ),
    });
    const claude = await collect("claude");
    expect(claude.incidents).toHaveLength(50);
    expect(claude.incidentCount).toBe(2101);
    expect(claude.incidents[0].id).toBe("outage");
    expect(claude.summary).toBe("Total outage");
    // Among equals the newest come first, and no notice outranks a problem.
    expect(claude.incidents[1].id).toBe("minor-1499");
    expect(claude.incidents.some((incident) => incident.informational)).toBe(false);
  });

  it("Statuspage: the card counts every incident, not only the 50 listed", async () => {
    stubFetch({
      [URLS.claude]: json(
        statuspageSummary({
          incidents: Array.from({ length: 60 }, (_, i) => ({
            id: `m-${i}`,
            name: `Minor ${i}`,
            status: "monitoring",
            impact: "minor",
          })),
        }),
      ),
    });
    const claude = await collect("claude");
    expect(claude.incidents).toHaveLength(50);
    expect(claude.incidentCount).toBe(60);
    // Sixty open problems are a degraded card that names one of them, never "Up".
    expect(claude.health).toBe("degraded");
    expect(claude.summary).toBe("Minor 0");
  });

  it("Statuspage: sixty notices with no impact leave the card up and say nothing is reported", async () => {
    stubFetch({
      [URLS.claude]: json(
        statuspageSummary({
          incidents: Array.from({ length: 60 }, (_, i) => ({
            id: `n-${i}`,
            name: `Notice ${i}`,
            status: "monitoring",
            impact: "none",
          })),
        }),
      ),
    });
    const claude = await collect("claude");
    expect(claude.incidents).toHaveLength(50);
    expect(claude.incidentCount).toBe(60);
    expect(claude.health).toBe("operational");
    expect(claude.summary).toBe("Nothing reported.");
  });

  it("an uncapped list carries no incidentCount", async () => {
    stubFetch({
      [URLS.claude]: json(
        statuspageSummary({ incidents: [{ id: "a", name: "A", status: "investigating", impact: "minor" }] }),
      ),
    });
    expect("incidentCount" in (await collect("claude"))).toBe(false);
  });

  it("Statuspage: keeps only the three soonest of many scheduled maintenances", async () => {
    stubFetch({
      [URLS.claude]: json(
        statuspageSummary({
          scheduled_maintenances: Array.from({ length: 2000 }, (_, i) => ({
            id: `m-${i}`,
            name: `Window ${i}`,
            status: "scheduled",
            // Listed latest first, so the soonest are last in the array.
            scheduled_for: new Date(Date.UTC(2027, 0, 1) - i * 3_600_000).toISOString(),
          })),
        }),
      ),
    });
    const claude = await collect("claude");
    expect(claude.upcomingMaintenance?.map((item) => item.id)).toEqual(["m-1999", "m-1998", "m-1997"]);
  });

  it("Google: many open incidents are capped at 50 with the outage first", async () => {
    const many = Array.from({ length: 1200 }, (_, i) =>
      googleIncident({ id: `i-${i}`, status_impact: "SERVICE_DISRUPTION", service_name: `Svc ${i}` }),
    );
    stubFetch({
      [URLS.gcp]: json([
        ...many,
        googleIncident({ id: "worst", status_impact: "SERVICE_OUTAGE", service_name: "Core" }),
      ]),
    });
    const gcp = await collect("gcp");
    expect(gcp.incidents).toHaveLength(50);
    expect(gcp.incidentCount).toBe(1201);
    expect(gcp.incidents[0].id).toBe("worst");
    expect(gcp.health).toBe("outage");
  });

  it("Apple: clips a long event message in the incident title and the component detail", async () => {
    stubFetch({
      [URLS.apple]: text(
        `jsonCallback(${JSON.stringify({
          services: [
            {
              serviceName: "iCloud",
              events: [
                { eventStatus: "ongoing", statusType: "Outage", message: HUGE, epochStartDate: 1_790_000_000_000 },
              ],
            },
          ],
        })});`,
      ),
    });
    const apple = await collect("apple");
    expect(apple.incidents[0].title).toHaveLength(300);
    expect(apple.components[0].detail).toHaveLength(500);
  });

  it("Apple OS: a runaway release title cannot reach the summary, meta or version map at length", async () => {
    const item = (title: string) =>
      `<item><title>${title}</title><link>https://developer.apple.com/news/?id=1</link><pubDate>Mon, 15 Sep 2026 17:00:00 GMT</pubDate></item>`;
    const feed = `<rss version="2.0"><channel>${item(`iOS ${"9".repeat(20_000)}`)}${item("macOS 26.1")}</channel></rss>`;
    stubFetch({ [URLS.appleOs]: text(feed) });
    const appleOs = await collect("apple-os");
    expect(appleOs.failure).toBeUndefined();
    expect(appleOs.summary.length).toBeLessThanOrEqual(500);
    expect(String(appleOs.meta?.latest).length).toBeLessThanOrEqual(300);
    expect(String(appleOs.meta?.versions).length).toBeLessThanOrEqual(500);
    expect(appleOs.components[0].detail?.length).toBeLessThanOrEqual(500);
    // The version map keeps one clipped version per family.
    expect(String(appleOs.meta?.versions)).toContain("macOS=26.1");
    expect(String(appleOs.meta?.versions)).toMatch(/^iOS=9{63}…\|/);
  });

  it("Android releases page: runaway link text or a runaway tag cannot reach the summary, names or meta", async () => {
    const page =
      `<a href="/about/versions/17">Android 17${" ".repeat(20_000)}</a>` +
      `<a href="/about/versions/15" ${'data-x="y" '.repeat(5_000)}>Android 15</a>` +
      `<a href="/about/versions/16">Android 16</a>`;
    stubFetch({ [URLS.androidOs]: text(page) });
    const android = await collect("android-os");
    expect(android.failure).toBeUndefined();
    expect(android.summary).toBe("Latest: Android 16");
    expect(android.components.map((component) => component.name)).toEqual(["Android 16"]);
    expect(String(android.meta?.versions).length).toBeLessThanOrEqual(500);
  });

  it("Apple: an event id built from a long message stays short, and the same on every sweep", async () => {
    const payload = {
      services: [
        {
          serviceName: "iCloud",
          events: [{ eventStatus: "ongoing", statusType: "Outage", message: "m".repeat(5000), epochStartDate: 1 }],
        },
      ],
    };
    stubFetch({ [URLS.apple]: text(`jsonCallback(${JSON.stringify(payload)});`) });
    const first = (await collect("apple")).incidents[0].id;
    const second = (await collect("apple")).incidents[0].id;
    expect(first.length).toBeLessThanOrEqual(200);
    expect(first).toBe(second);
  });

  it("Grok: an active item past the 200th in document order is still found", async () => {
    const item = (title: string, pubDate: string, status: string) =>
      `<item><title>${title}</title><link>https://status.x.ai/incidents/${encodeURIComponent(title)}</link>
      <pubDate>${pubDate}</pubDate><description>Status: ${status}</description></item>`;
    // Oldest first: 400 stale resolved items, then the one that is live now, last in the document.
    const stale = Array.from({ length: 400 }, (_, i) =>
      item(`Old ${i}`, new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toUTCString(), "Resolved"),
    );
    const feed = `<rss version="2.0"><channel>${stale.join("")}${item("Live outage", "Sun, 20 Sep 2026 09:30:00 GMT", "Identified")}</channel></rss>`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    try {
      stubFetch({ [URLS.grok]: text(feed) });
      const grok = await collect("grok");
      expect(grok.failure).toBeUndefined();
      expect(grok.health).toBe("degraded");
      expect(grok.incidents.map((incident) => incident.title)).toEqual(["Live outage"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Grok: clips item titles and the details cut from them, and reads at most 200 feed items", async () => {
    const item = (
      i: number,
      title: string,
    ) => `<item><title>${title}</title><link>https://status.x.ai/incidents/${i}</link>
      <pubDate>Sun, 20 Sep 2026 09:30:00 GMT</pubDate><description>Status: Identified</description></item>`;
    const feed = `<rss version="2.0"><channel>${item(0, `[Grok] ${HUGE}`)}${Array.from({ length: MAX_RSS_SCANNED - 1 }, (_, i) => item(i + 1, `[Svc ${i}] issue`)).join("")}</channel></rss>`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    try {
      stubFetch({ [URLS.grok]: text(feed) });
      const grok = await collect("grok");
      expect(grok.failure).toBeUndefined();
      expect(grok.incidents).toHaveLength(8);
      expect(grok.incidents[0].title).toHaveLength(300);
      expect(grok.components[0].name).toBe("Grok");
      expect(grok.components[0].detail).toHaveLength(500);
      // 200 items read: the first, plus 199 services. All 200 fit under MAX_COMPONENTS (300), so none is cut;
      // the 200 incidents are what the 8 listed leave out.
      expect(grok.components).toHaveLength(200);
      expect(grok.componentCount).toBeUndefined();
      expect(grok.incidentCount).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
