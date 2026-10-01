import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Pulse } from "@/lib/status/pulse";
import { UpdateFeed } from "./update-feed";

const T0 = Date.parse("2026-09-30T10:04:00.000Z");
const MINUTE = 60_000;

function pulse(n: number, over: Partial<Pulse> = {}): Pulse {
  const slot = T0 + n * 2 * MINUTE;
  return {
    slot,
    at: new Date(slot).toISOString(),
    overall: "operational",
    counts: { operational: 14, degraded: 0, outage: 0, maintenance: 0, unknown: 0 },
    changes: [],
    opening: false,
    ...over,
  };
}

const render = (pulses: Pulse[]) => renderToStaticMarkup(createElement(UpdateFeed, { pulses }));

describe("UpdateFeed", () => {
  it("is a labelled section that says it is about this device, with no eyebrow", () => {
    const html = render([pulse(0, { opening: true })]);
    expect(html).toContain('<section aria-labelledby="recent-heading"');
    expect(html).toContain('id="recent-heading"');
    expect(html).toContain(">Recent changes</h2>");
    expect(html).toContain("On this device");
    expect(html).not.toContain("Board log");
    expect(html).not.toContain("Checks and new releases");
  });

  it("waits for the first check", () => {
    const html = render([]);
    expect(html).toContain("Waiting for the first check.");
    expect(html).not.toContain("<ol");
  });

  it("draws the same surface, a spotlight card list, whether or not there are checks yet", () => {
    const surface = /<div class="surface spotlight card-list[^"]*">/;
    expect(render([])).toMatch(surface);
    expect(render([pulse(0, { opening: true })])).toMatch(surface);
  });

  it("holds the height of the saved checks only while it waits for them", () => {
    expect(render([])).toContain("min-h-[var(--feed-reserve,0px)]");
    expect(render([pulse(0, { opening: true })])).not.toContain("min-h-");
  });

  it("lists checks newest first, each time titled in UTC and printed in UTC before hydration", () => {
    const html = render([
      pulse(1, {
        counts: { operational: 13, degraded: 1, outage: 0, maintenance: 0, unknown: 0 },
        changes: [{ id: "steam", name: "Steam", from: "operational", to: "degraded", summary: "Slow" }],
      }),
      pulse(0, { opening: true }),
    ]);
    expect(html).toContain("Steam is now degraded");
    expect(html).toContain("13 of 14 up · Slow");
    expect(html).toContain("First check");
    expect(html.indexOf("Steam is now degraded")).toBeLessThan(html.indexOf("First check"));
    expect(html).toContain('title="30 Sep 2026 10:06 UTC"');
    expect(html).toContain(">10:06\u202fUTC</time>");
    // Rows sit in list items of a card list, which draws the hairline between them.
    expect(html.match(/<li><div class="row /g)).toHaveLength(2);
  });

  it("folds a run of quiet checks into one row", () => {
    const html = render([pulse(3), pulse(2), pulse(1), pulse(0, { opening: true })]);
    expect(html).toContain("Nothing changed · 3 checks");
    expect(html.match(/<li>/g)).toHaveLength(2);
  });
});
