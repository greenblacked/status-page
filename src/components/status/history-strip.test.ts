import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryDay } from "@/lib/status/history";
import { HistoryStrip } from "./history-strip";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");

function day(date: string, worst: HistoryDay["worst"], up: number): HistoryDay {
  return { date, worst, samples: 4, up };
}

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

function slotTitles(html: string): string[] {
  return [...html.matchAll(/title="([^"]*)"/g)].map((match) => match[1]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HistoryStrip", () => {
  it("renders nothing without days", () => {
    expect(render(createElement(HistoryStrip, { days: [], nowMs: NOW }))).toBe("");
  });

  it("windows on the current day while the client clock is not set yet", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const html = render(createElement(HistoryStrip, { days: [day("2026-09-27", "operational", 1)], nowMs: 0 }));
    const titles = slotTitles(html);
    expect(titles).toHaveLength(30);
    expect(titles[0]).toBe("2026-08-29: no samples");
    expect(titles[29]).toBe("2026-09-27: Operational");
  });

  it("windows on the explicit clock when one is passed", () => {
    const html = render(createElement(HistoryStrip, { days: [day("2026-09-01", "operational", 1)], nowMs: NOW }));
    const titles = slotTitles(html);
    expect(titles[0]).toBe("2026-08-29: no samples");
    expect(titles[29]).toBe("2026-09-27: no samples");
  });

  it("renders nothing when every record is older than the window", () => {
    const html = render(createElement(HistoryStrip, { days: [day("2026-07-01", "outage", 0)], nowMs: NOW }));
    expect(html).toBe("");
  });

  it("describes only the days inside the window", () => {
    const html = render(
      createElement(HistoryStrip, {
        days: [day("2026-07-01", "outage", 0), day("2026-09-26", "degraded", 0.5), day("2026-09-27", "operational", 1)],
        nowMs: NOW,
      }),
    );
    expect(html).toContain("30-day uptime history");
    expect(html).toContain("75.0%");
    expect(html).toContain("worst day 2026-09-26: Degraded");
    expect(html).not.toContain("07-01");
    expect(html).not.toContain("bg-down");
    expect(slotTitles(html)).toHaveLength(30);
  });

  it("draws quiet days as neutral ticks and only a bad day in colour", () => {
    const html = render(
      createElement(HistoryStrip, {
        days: [day("2026-09-25", "operational", 1), day("2026-09-26", "degraded", 0.5), day("2026-09-27", "outage", 0)],
        nowMs: NOW,
      }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain("uptime history");
    expect(html).toContain("bg-tick");
    expect(html).toContain("bg-warn");
    expect(html).toContain("bg-down");
    // One slot per UTC day of the 30-day window, days without a record included.
    expect(html.match(/title="/g)?.length).toBe(30);
  });

  it("names the worst day for readers who cannot see the colours", () => {
    const html = render(
      createElement(HistoryStrip, {
        days: [day("2026-09-26", "degraded", 0.5), day("2026-09-27", "operational", 1)],
        nowMs: NOW,
      }),
    );
    expect(html).toContain("worst day 2026-09-26: Degraded");
    expect(html).toContain("09-26 degraded");
  });
});
