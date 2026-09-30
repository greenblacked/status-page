import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryDay, PublicHistory } from "@/lib/status/history";
import type { ServiceSnapshot } from "@/lib/status/types";
import { service } from "../../test/fixtures";
import { BoardHistoryContext } from "./board-history-provider";
import { ServiceCard } from "./service-card";

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

afterEach(() => {
  vi.unstubAllEnvs();
});

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

/** A card rendered with no history provider in the tree at all. */
function bareCard(): ReactElement {
  return createElement(ServiceCard, {
    service: service("aws", { health: "degraded", summary: "Elevated errors" }),
    index: 0,
    starred: false,
    onToggleStar: noop,
    now: NOW,
  });
}

describe("cards without history", () => {
  it("render identical markup whether history never loaded, came back empty or omits the service", () => {
    // With the flag on, so a strip would show if there were days to draw.
    vi.stubEnv("VITE_STATUS_HISTORY", "1");
    const plainCard = renderToStaticMarkup(bareCard());
    expect(plainCard).not.toMatch(STRIP);
    expect(plainCard).not.toContain('role="img"');

    const variants: Array<[string, PublicHistory | undefined]> = [
      ["never loaded", undefined],
      ["empty document", history({})],
      ["service omitted", history({ gcp: { days: DAYS } })],
      ["service with no days", history({ aws: { days: [] } })],
    ];
    for (const [name, variant] of variants) {
      expect(card(variant), `card, ${name}`).toBe(plainCard);
    }
  });

  it("add no caption, placeholder or empty strip element", () => {
    vi.stubEnv("VITE_STATUS_HISTORY", "1");
    const html = card(history({ aws: { days: [] } }));
    expect(html).not.toMatch(/uptime|no data|30d/i);
    expect(html).not.toContain('role="img"');
  });
});

describe("cards with the flag off", () => {
  it("draw no strip even when history is in context", () => {
    const document = history({ aws: { days: DAYS } });
    for (const flag of [undefined, "", "0"]) {
      vi.stubEnv("VITE_STATUS_HISTORY", flag as string);
      const html = card(document);
      expect(html).not.toMatch(STRIP);
      expect(html).not.toContain('role="img"');
      expect(html).toBe(card(undefined));
    }
  });
});

describe("cards with history", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_STATUS_HISTORY", "1");
  });

  it("show the strip on the full card", () => {
    const html = card(history({ aws: { days: DAYS } }));
    expect(html).toMatch(STRIP);
    expect(html).toContain("30d");
    expect(html).not.toBe(card(undefined));
  });

  it("show it only on the service the history is for", () => {
    const document = history({ aws: { days: DAYS } });
    expect(card(document, "aws")).toMatch(STRIP);
    expect(card(document, "gcp")).not.toMatch(STRIP);
  });

  it("leave the strip off changelog-category cards", () => {
    const document = history({ aws: { days: DAYS } });
    expect(card(document, "aws", { category: "updates" })).not.toMatch(STRIP);
    expect(card(document, "aws", { category: "updates" })).toBe(card(undefined, "aws", { category: "updates" }));
  });

  it("expose one accessible summary and hide the caption and per-day bars", () => {
    const html = card(history({ aws: { days: DAYS } }));
    expect(html.match(/role="img"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="30-day uptime history');
    // Every per-day bar is hidden from assistive tech; the caption is too.
    expect(html.match(/<span aria-hidden="true" title="2026-\d\d-\d\d: /g)).toHaveLength(30);
    expect(html).toMatch(/<div aria-hidden="true" class="flex items-end justify-between[^>]*><p[^>]*>.*uptime/);
  });
});

describe("rows with history", () => {
  const document = history({ aws: { days: DAYS } });
  const row = (
    withHistory: PublicHistory | undefined,
    overrides: Partial<ServiceSnapshot> = {},
    id: "aws" | "gcp" = "aws",
  ) => card(withHistory, id, { health: "operational", summary: "All systems normal", ...overrides });

  beforeEach(() => {
    vi.stubEnv("VITE_STATUS_HISTORY", "1");
  });

  it("show the strip on a healthy row, and on one that could not be read", () => {
    for (const health of ["operational", "unknown"] as const) {
      const html = row(document, { health });
      expect(html, health).toMatch(STRIP);
      expect(html.match(/role="img"/g), health).toHaveLength(1);
      expect(html, health).toContain("30d");
    }
  });

  it("keep the strip outside the summary of a row that opens", () => {
    const html = row(document, { components: [{ name: "Console", health: "operational" }] });
    expect(html).toContain("<details");
    expect(html.indexOf('role="img"')).toBeGreaterThan(html.indexOf("</details>"));
  });

  it("show it only on the service the history is for, and never on a release tracker", () => {
    expect(row(document, {}, "gcp")).not.toMatch(STRIP);
    expect(row(document, { category: "updates", health: "unknown" })).not.toMatch(STRIP);
  });

  it("render the row as it was with no days, or the flag off", () => {
    expect(row(history({ aws: { days: [] } }))).toBe(row(undefined));
    vi.stubEnv("VITE_STATUS_HISTORY", "0");
    expect(row(document)).toBe(row(undefined));
  });
});
