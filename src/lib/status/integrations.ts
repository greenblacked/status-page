import { overallHealth } from "./diff.ts";
import { healthLabel } from "./health.ts";
import { boardHeadline } from "./layout.ts";
import type { BoardSnapshot, Health, ServiceId, ServiceSnapshot } from "./types.ts";

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
  incidents: Array<{ title: string; health: Health; url?: string; startedAt?: string }>;
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
      })),
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

// FNV-1a: a short, stable fingerprint. An entry's id changes when what it
// says changes, so feed readers (Slack, Feedly, Discord bots) post it again.
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * An Atom feed with one entry per service that needs attention. Subscribing
 * to it is the no-code way to get alerts: Slack's `/feed subscribe`, Microsoft
 * Teams' RSS connector, Discord feed bots and any feed reader all take it.
 */
export function atomFeed(board: BoardSnapshot, origin: string): string {
  const base = origin.replace(/\/$/, "");
  const affected = board.services.filter((service) => service.health !== "operational");
  const entries = affected
    .map((service) => {
      const incident = service.incidents.find((item) => item.url);
      const link = incident?.url ?? service.sourceUrl;
      const id = `urn:status-bar:${service.id}:${service.health}:${fingerprint(service.summary)}`;
      // Vendor timestamps are not always parseable; toISOString would throw.
      const stamp = Date.parse(service.incidents[0]?.updatedAt ?? service.incidents[0]?.startedAt ?? "");
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

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <title>Status Page</title>",
    `  <subtitle>${escapeXml(boardHeadline(board).title)}</subtitle>`,
    `  <id>${escapeXml(`${base}/`)}</id>`,
    `  <link rel="self" href="${escapeXml(`${base}/feed.xml`)}"/>`,
    `  <link rel="alternate" href="${escapeXml(`${base}/`)}"/>`,
    `  <updated>${escapeXml(board.generatedAt)}</updated>`,
    "  <author><name>Status Page</name></author>",
    entries,
    "</feed>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .concat("\n");
}
