import type { Page, Route } from "@playwright/test";
import { toCrossJSONAsync } from "seroval";
import { CATALOG } from "../src/lib/status/catalog.ts";
import type { BoardSnapshot, Health, ServiceId, ServiceSnapshot } from "../src/lib/status/types.ts";

// A board with every state the page can show, for tests that must see
// them all whatever the vendors say today (and offline, every vendor says
// Unknown). Outage, degraded, maintenance that has not started, unknown,
// operational services and release trackers, incidents with start times.
// Two attention services differ in severity (AWS down, Google Cloud
// degraded), so the most urgent one leads the board. Healthy ChatGPT and
// Claude list several operational components, and healthy Grok lists none
// (its feed names no components), so every card layout a healthy service
// can take is on screen. Google Cloud, AWS and Steam carry the component
// lists their collectors build from products.json, the services in current
// events and the connection-manager directory.

const minute = 60_000;

/** A long, all-operational component list, the shape a big vendor (Google Cloud lists over two hundred) gives. */
const longList = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `${prefix} ${index + 1}`, health: "operational" as const }));

type Override = Partial<Omit<ServiceSnapshot, "id">>;

function overrides(now: number, grok: Health): Partial<Record<ServiceId, Override>> {
  const at = (offset: number) => new Date(now + offset).toISOString();
  return {
    aws: {
      health: "outage",
      summary: "Increased error rates in us-east-1",
      // Only the services the current events name, merged per service.
      components: [
        {
          name: "Amazon Elastic Compute Cloud",
          health: "outage",
          detail: "N. Virginia · Increased error rates",
        },
        { name: "AWS Lambda", health: "degraded", detail: "N. Virginia · Increased invoke latencies" },
      ],
      incidents: [
        {
          id: "aws-1",
          title: "Increased error rates in us-east-1",
          health: "outage",
          startedAt: at(-52 * minute),
        },
      ],
    },
    gcp: {
      health: "degraded",
      summary: "Elevated error rates for Cloud Run in europe-west1",
      // Products from products.json: the ones an open incident names lead,
      // the worst first.
      components: [
        { name: "Cloud Run", health: "degraded", detail: "europe-west1" },
        { name: "Cloud Build", health: "degraded" },
        { name: "Google Compute Engine", health: "operational" },
        { name: "BigQuery", health: "operational" },
        ...longList("Cloud product", 36),
      ],
      incidents: [
        {
          id: "gcp-1",
          title: "Elevated error rates for Cloud Run in europe-west1",
          health: "degraded",
          startedAt: at(-130 * minute),
        },
      ],
    },
    // Healthy Grok is the bare one: no components at all.
    ...(grok === "operational"
      ? {}
      : {
          grok: {
            health: grok,
            summary: grok === "outage" ? "Grok is unavailable for most users" : "Slow responses on grok.com",
            components: [
              { name: "API", health: grok },
              { name: "grok.com", health: grok },
            ],
            incidents: [
              { id: "grok-1", title: "Investigating failed requests", health: grok, startedAt: at(-38 * minute) },
            ],
          },
        }),
    chatgpt: {
      components: [
        { name: "Conversations", health: "operational" },
        { name: "Login", health: "operational" },
        { name: "Voice mode", health: "operational" },
        { name: "Image generation", health: "operational" },
        { name: "API", health: "operational" },
      ],
    },
    // A healthy row with a long list: six shown, the rest behind "Show all".
    spotify: { components: longList("Spotify part", 32) },
    claude: {
      components: [
        { name: "claude.ai", health: "operational" },
        { name: "Claude API", health: "operational" },
        { name: "Claude Code", health: "operational" },
        { name: "Claude Console", health: "operational" },
      ],
    },
    epic: {
      health: "maintenance",
      summary: "Scheduled maintenance for the Epic Games Store",
      components: [{ name: "Epic Games Store", health: "maintenance" }],
      incidents: [
        { id: "epic-1", title: "Store maintenance window", health: "maintenance", startedAt: at(5 * 60 * minute) },
      ],
    },
    android: {
      health: "unknown",
      summary: "The official source did not answer in time",
      failure: { kind: "timeout", message: "timed out" },
    },
    steam: {
      components: [
        { name: "Steam Web API", health: "operational" },
        { name: "Steam Store", health: "operational" },
        { name: "Steam Connection Managers", health: "operational", detail: "41 servers listed" },
      ],
    },
    "cs2-europe": {
      components: [
        { name: "Frankfurt", health: "operational", detail: "38 relays" },
        { name: "Stockholm", health: "operational", detail: "24 relays" },
        { name: "Vienna", health: "operational", detail: "12 relays" },
      ],
    },
    mikrotik: {
      summary: "RouterOS 7.21 stable",
      components: [
        { name: "Stable", health: "maintenance", detail: "7.21 · Sep 24" },
        { name: "Long-term", health: "operational", detail: "7.18.2" },
        { name: "Testing", health: "operational", detail: "7.22beta3" },
      ],
    },
    "apple-os": {
      summary: "Latest: iOS 27.2 beta 2",
      components: [
        { name: "iOS", health: "maintenance", detail: "27.2 beta 2 · Sep 21" },
        { name: "macOS", health: "operational", detail: "27.1" },
      ],
    },
  };
}

/** Every catalog service, operational unless overridden above. `grok` lets a test turn the otherwise healthy, component-less Grok into an incident between boards. */
export function fixtureBoard(now: number, { grok = "operational" }: { grok?: Health } = {}): BoardSnapshot {
  const patch = overrides(now, grok);
  const services: ServiceSnapshot[] = CATALOG.map((entry, index) => ({
    ...entry,
    health: "operational",
    summary: "All systems operational",
    checkedAt: new Date(now).toISOString(),
    latencyMs: 120 + index * 23,
    components: [],
    incidents: [],
    ...patch[entry.id],
  }));
  const counts: Record<Health, number> = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const service of services) counts[service.health] += 1;
  return { generatedAt: new Date(now).toISOString(), durationMs: 480, services, counts };
}

/** The same twenty services with nothing wrong anywhere: every one operational, no incident, no failure. */
export function calmBoard(now: number): BoardSnapshot {
  const board = fixtureBoard(now);
  const services = board.services.map((service) => ({
    ...service,
    health: "operational" as const,
    summary: "All systems operational",
    incidents: [],
    upcomingMaintenance: [],
    failure: undefined,
    components: service.components.map((component) => ({ ...component, health: "operational" as const })),
  }));
  return {
    ...board,
    services,
    counts: { operational: services.length, degraded: 0, outage: 0, maintenance: 0, unknown: 0 },
  };
}

const SERVER_FN = "**/_serverFn/**";
const served = new WeakMap<Page, (route: Route) => Promise<void>>();

/**
 * Answers the board's server functions (the Refresh POST and the
 * scheduled GET) with `board()` instead of the vendors, in the same
 * serialized form the server sends. The page's first render still comes
 * from the server; press Refresh to bring the fixture in.
 *
 * `pressed`, when given, answers the Refresh POST alone, while the scheduled
 * GET keeps answering with `board()`: a test that needs a change to arrive
 * with its press, and not with a poll that happens to land first on a slow
 * machine, serves the change there.
 */
export async function serveBoard(page: Page, board: () => BoardSnapshot, pressed?: () => BoardSnapshot): Promise<void> {
  // One answer at a time: the newest replaces the one before, so a test that opens many boards on one page does
  // not stack a handler for each.
  const before = served.get(page);
  if (before) await page.unroute(SERVER_FN, before);
  const handler = async (route: Route) => {
    const answer = pressed && route.request().method() === "POST" ? pressed() : board();
    const body = await toCrossJSONAsync({ result: answer, error: undefined, context: {} }, { refs: new Map() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-tss-serialized": "true" },
      body: JSON.stringify(body),
    });
  };
  served.set(page, handler);
  await page.route(SERVER_FN, handler);
}

/**
 * The longest hero the page can have: fifteen services need a look, so the headline is "Fifteen things need a look."
 * and the line under it names three of them, "and 12 more", says the other three are running normally, and that two
 * could not be read (named, each a link). On a phone the headline and that line wrap to the most lines they can, and the live line
 * sits under them.
 */
export function longHeroBoard(now: number): BoardSnapshot {
  const board = fixtureBoard(now);
  const unread = new Set<ServiceId>(["android", "grok"]);
  const calm = new Set<ServiceId>(["apple-os", "windows", "android-os"]);
  const services = board.services.map((service, index): ServiceSnapshot => {
    if (unread.has(service.id)) {
      return { ...service, health: "unknown", summary: "The official source did not answer in time" };
    }
    if (calm.has(service.id)) return service;
    const health: Health = index % 2 ? "outage" : "degraded";
    return {
      ...service,
      health,
      summary: service.summary === "All systems operational" ? "Elevated error rates" : service.summary,
    };
  });
  const counts: Record<Health, number> = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const service of services) counts[service.health] += 1;
  return { ...board, services, counts };
}
