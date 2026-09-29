import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HistoryDay, PublicHistory } from "@/lib/status/history";
import type { ServiceSnapshot } from "@/lib/status/types";
import { service } from "../../test/fixtures";
import { BoardHistoryContext } from "./board-history-provider";
import { ServiceCard } from "./service-card-full";
import { ServiceTile } from "./service-card-tile";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const STRIP = /uptime history/;

function history(services: PublicHistory["services"]): PublicHistory {
  return { schema: 1, updatedAt: "2026-09-27T12:00:00.000Z", timezone: "UTC", retentionDays: 30, services };
}

const DAYS: HistoryDay[] = [
  { date: "2026-09-26", worst: "degraded", samples: 4, up: 0.5 },
  { date: "2026-09-27", worst: "operational", samples: 4, up: 1 },
];

const noop = () => {};

function card(
  withHistory: PublicHistory | undefined,
  id: "aws" | "gcp" = "aws",
  overrides: Partial<ServiceSnapshot> = {},
): string {
  const element: ReactElement = createElement(
    BoardHistoryContext.Provider,
    { value: withHistory },
    createElement(ServiceCard, {
      service: service(id, { health: "degraded", summary: "Elevated errors", ...overrides }),
      index: 0,
      starred: false,
      onToggleStar: noop,
      now: NOW,
    }),
  );
  return renderToStaticMarkup(element);
}

function tile(
  withHistory: PublicHistory | undefined,
  id: "aws" | "gcp" = "aws",
  overrides: Partial<ServiceSnapshot> = {},
): string {
  const element: ReactElement = createElement(
    BoardHistoryContext.Provider,
    { value: withHistory },
    createElement(ServiceTile, {
      service: service(id, overrides),
      index: 0,
      starred: false,
      onToggleStar: noop,
      now: NOW,
    }),
  );
  return renderToStaticMarkup(element);
}

describe("cards without history", () => {
  it("are byte-for-byte the same whether history never loaded, came back empty or omits the service", () => {
    const baselineCard = card(undefined);
    const baselineTile = tile(undefined);
    expect(baselineCard).not.toMatch(STRIP);
    expect(baselineTile).not.toMatch(STRIP);

    expect(card(history({}))).toBe(baselineCard);
    expect(tile(history({}))).toBe(baselineTile);
    // A service the document leaves out, or lists with no days, gets no strip.
    expect(card(history({ gcp: { days: DAYS } }))).toBe(baselineCard);
    expect(tile(history({ aws: { days: [] } }))).toBe(baselineTile);
  });

  it("add no caption, placeholder or empty strip element", () => {
    const html = card(history({ aws: { days: [] } }));
    expect(html).not.toMatch(/uptime|no data|30d/i);
    expect(html).not.toContain('role="img"');
  });
});

describe("cards with history", () => {
  it("show the strip on the full card", () => {
    const html = card(history({ aws: { days: DAYS } }));
    expect(html).toMatch(STRIP);
    expect(html).toContain("30d");
    expect(html).not.toBe(card(undefined));
  });

  it("show the compact strip on the operational tile", () => {
    const html = tile(history({ aws: { days: DAYS } }));
    expect(html).toMatch(STRIP);
    expect(html).toContain("h-3");
    expect(html).not.toBe(tile(undefined));
  });

  it("show it only on the service the history is for", () => {
    const document = history({ aws: { days: DAYS } });
    expect(card(document, "aws")).toMatch(STRIP);
    expect(card(document, "gcp")).not.toMatch(STRIP);
  });

  it("leave the strip off changelog-category cards and tiles", () => {
    const document = history({ aws: { days: DAYS } });
    expect(card(document, "aws", { category: "updates" })).not.toMatch(STRIP);
    expect(tile(document, "aws", { category: "updates" })).not.toMatch(STRIP);
    expect(card(document, "aws", { category: "updates" })).toBe(card(undefined, "aws", { category: "updates" }));
  });

  it("expose one accessible summary and hide the caption and per-day bars", () => {
    const html = card(history({ aws: { days: DAYS } }));
    expect(html.match(/role="img"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="2-day uptime history');
    // Every per-day bar is hidden from assistive tech; the caption is too.
    expect(html.match(/<span aria-hidden="true" title="2026-\d\d-\d\d: /g)).toHaveLength(30);
    expect(html).toMatch(/<div aria-hidden="true" class="flex items-end justify-between[^>]*><p[^>]*>.*uptime/);
  });
});
