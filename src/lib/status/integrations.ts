import { APP_NAME } from "./catalog.ts";
import { overallHealth } from "./diff.ts";
import { healthLabel } from "./health.ts";
import { boardHeadline, incidentLink, sortIncidents } from "./layout.ts";
import type { BoardSnapshot, Health, ServiceId, ServiceSnapshot, UpcomingMaintenance } from "./types.ts";

// Everything here is a pure function of one board snapshot, so the JSON API,
// the Atom feed and the badges always agree with the page they sit beside.

/** Shared by every public endpoint: readable from any origin, cached briefly. */
export const PUBLIC_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  // The board itself refreshes every two minutes; a minute of edge cache keeps
  // a popular badge or feed from turning into a vendor sweep per request.
  "Cache-Control": "public, max-age=60, stale-while-revalidate=60",
} as const;

export type PublicService = {
  id: ServiceId;
  name: string;
  category: ServiceSnapshot["category"];
  health: Health;
  summary: string;
  source: string;
  incidents: Array<{ title: string; health: Health; url?: string; startedAt?: string; informational?: true }>;
  /** Scheduled, not yet started maintenance. Present only when the vendor lists some; never affects `health`. */
  upcomingMaintenance?: UpcomingMaintenance[];
};

export type PublicStatus = {
  generatedAt: string;
  overall: Health;
  headline: string;
  counts: Record<Health, number>;
  services: PublicService[];
};

/** The /api/status.json body: the board without collector internals. */
export function publicStatus(board: BoardSnapshot): PublicStatus {
  return {
    generatedAt: board.generatedAt,
    overall: overallHealth(board),
    headline: boardHeadline(board).title,
    counts: board.counts,
    services: board.services.map((service) => ({
      id: service.id,
      name: service.name,
      category: service.category,
      health: service.health,
      summary: service.summary,
      source: service.sourceUrl,
      incidents: service.incidents.map((incident) => ({
        title: incident.title,
        health: incident.health,
        url: incident.url,
        startedAt: incident.startedAt,
        ...(incident.informational ? { informational: true as const } : {}),
      })),
      ...(service.upcomingMaintenance?.length ? { upcomingMaintenance: service.upcomingMaintenance } : {}),
    })),
  };
}

// Shields.io named colours, so badges match the board's meaning, not its hex.
const SHIELDS_COLOR: Record<Health, string> = {
  operational: "brightgreen",
  degraded: "yellow",
  outage: "red",
  maintenance: "blue",
  unknown: "lightgrey",
};

export type ShieldsBadge = {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  isError?: boolean;
};

/**
 * A Shields.io endpoint badge (https://shields.io/badges/endpoint-badge) for
 * one service, or for the whole board when `id` is "board". Unknown ids get a
 * well-formed error badge rather than a 404, which Shields would render as
 * "invalid".
 */
export function shieldsBadge(board: BoardSnapshot, id: string): ShieldsBadge {
  if (id === "board") {
    const overall = overallHealth(board);
    return {
      schemaVersion: 1,
      label: "status",
      message: overall === "operational" ? "all operational" : boardHeadline(board).title.toLowerCase(),
      color: SHIELDS_COLOR[overall],
    };
  }
  const service = board.services.find((item) => item.id === id);
  if (!service) {
    return { schemaVersion: 1, label: "status", message: "unknown service", color: "lightgrey", isError: true };
  }
  return {
    schemaVersion: 1,
    label: service.name,
    message: healthLabel(service.health).toLowerCase(),
    color: SHIELDS_COLOR[service.health],
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The latest real vendor time among a service's incidents (last update, else start), as epoch ms, or NaN. */
function latestVendorTime(service: ServiceSnapshot): number {
  let latest = Number.NaN;
  for (const incident of service.incidents) {
    for (const text of [incident.updatedAt, incident.startedAt]) {
      // Vendor timestamps are not always parseable; toISOString would throw.
      const at = Date.parse(text ?? "");
      if (Number.isFinite(at) && (Number.isNaN(latest) || at > latest)) latest = at;
    }
  }
  return latest;
}

/**
 * An Atom feed with one entry per service that needs attention. Subscribing
 * to it is the no-code way to get alerts: Slack's `/feed subscribe`, Microsoft
 * Teams' RSS connector, Discord feed bots and any feed reader all take it.
 *
 * An entry's id is the service, its health and its worst incident's id (with
 * no incident, just the health), so it stays the same while the incident's
 * wording changes and a reader posts an incident once, but changes when the
 * service escalates or eases (degraded to outage), so that is posted again;
 * a reworded or updated incident is signalled by `<updated>` instead, which is the latest time the
 * vendor itself gave (never the time of this sweep, which would make every
 * poll look like news). A service with no vendor time at all (a card built
 * from components alone) falls back to the snapshot time.
 *
 * Unreadable (`unknown`) services are left out. A single failed sweep is
 * usually a vendor hiccup, and telling a hiccup from a real blackout needs
 * to know how many sweeps in a row have failed, which this stateless
 * function (one snapshot in, one document out) does not have. The board and
 * `/api/status.json` still show them.
 */
export function atomFeed(board: BoardSnapshot, origin: string): string {
  const base = origin.replace(/\/$/, "");
  const affected = board.services.filter((service) => service.health !== "operational" && service.health !== "unknown");
  const stamps: number[] = [];
  const entries = affected
    .map((service) => {
      const worst = sortIncidents(service.incidents).find((incident) => !incident.informational);
      const key = worst ? `${service.health}:${encodeURIComponent(worst.id)}` : service.health;
      const id = `urn:status-bar:${service.id}:${key}`;
      const link = incidentLink(service) ?? service.sourceUrl;
      const vendorTime = latestVendorTime(service);
      const stamp = Number.isFinite(vendorTime) ? vendorTime : Date.parse(board.generatedAt);
      if (Number.isFinite(stamp)) stamps.push(stamp);
      const updated = Number.isFinite(stamp) ? new Date(stamp).toISOString() : board.generatedAt;
      return [
        "  <entry>",
        `    <id>${escapeXml(id)}</id>`,
        `    <title>${escapeXml(`${service.name}: ${healthLabel(service.health)}`)}</title>`,
        `    <updated>${escapeXml(updated)}</updated>`,
        `    <link rel="alternate" href="${escapeXml(link)}"/>`,
        `    <category term="${escapeXml(service.health)}"/>`,
        `    <summary>${escapeXml(service.summary)}</summary>`,
        "  </entry>",
      ].join("\n");
    })
    .join("\n");
  const feedUpdated = stamps.length ? new Date(Math.max(...stamps)).toISOString() : board.generatedAt;

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(APP_NAME)}</title>`,
    `  <subtitle>${escapeXml(boardHeadline(board).title)}</subtitle>`,
    `  <id>${escapeXml(`${base}/`)}</id>`,
    `  <link rel="self" href="${escapeXml(`${base}/feed.xml`)}"/>`,
    `  <link rel="alternate" href="${escapeXml(`${base}/`)}"/>`,
    `  <updated>${escapeXml(feedUpdated)}</updated>`,
    `  <author><name>${escapeXml(APP_NAME)}</name></author>`,
    entries,
    "</feed>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .concat("\n");
}
