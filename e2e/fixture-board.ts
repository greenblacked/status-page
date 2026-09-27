import type { Page } from "@playwright/test";
import { toCrossJSONAsync } from "seroval";
import { CATALOG } from "../src/lib/status/catalog.ts";
import type { BoardSnapshot, Health, ServiceId, ServiceSnapshot } from "../src/lib/status/types.ts";

// A board with every state the page can show, for tests that must see
// them all whatever the vendors say today (and offline, every vendor says
// Unknown). Outage, degraded, maintenance that has not started, unknown,
// operational services and release trackers, incidents with start times.

const minute = 60_000;

type Override = Partial<Omit<ServiceSnapshot, "id">>;

function overrides(now: number, grok: Health): Partial<Record<ServiceId, Override>> {
  const at = (offset: number) => new Date(now + offset).toISOString();
  return {
    gcp: {
      health: "degraded",
      summary: "Elevated error rates for Cloud Run in europe-west1",
      components: [
        { name: "Cloud Run", health: "degraded", detail: "europe-west1" },
        { name: "Cloud Build", health: "degraded" },
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
    grok: {
      health: grok,
      summary: grok === "outage" ? "Grok is unavailable for most users" : "Slow responses on grok.com",
      components: [
        { name: "API", health: grok },
        { name: "grok.com", health: grok },
      ],
      incidents: [{ id: "grok-1", title: "Investigating failed requests", health: grok, startedAt: at(-38 * minute) }],
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

/** Every catalog service, operational unless overridden above. `grok` lets a test change one service between boards. */
export function fixtureBoard(now: number, { grok = "outage" }: { grok?: Health } = {}): BoardSnapshot {
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

/**
 * Answers the board's server functions (the Refresh POST and the
 * scheduled GET) with `board()` instead of the vendors, in the same
 * serialized form the server sends. The page's first render still comes
 * from the server; press Refresh to bring the fixture in.
 */
export async function serveBoard(page: Page, board: () => BoardSnapshot): Promise<void> {
  await page.route("**/_serverFn/**", async (route) => {
    const body = await toCrossJSONAsync({ result: board(), error: undefined, context: {} }, { refs: new Map() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-tss-serialized": "true" },
      body: JSON.stringify(body),
    });
  });
}
