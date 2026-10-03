import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Health } from "@/lib/status/types";
import { CHANGED_BAR, GLYPH_DETAIL_MIN, STATUS_TEXT, StatusGlyph } from "./status-glyph";

const HEALTHS: Health[] = ["operational", "degraded", "outage", "unknown", "maintenance"];

const render = (health: Health, size?: number, extra: { className?: string; cut?: "card" | "bg" | "inset" } = {}) =>
  renderToStaticMarkup(createElement(StatusGlyph, { health, size, ...extra }));

describe("StatusGlyph", () => {
  it("is decorative: the word beside it is the status", () => {
    for (const health of HEALTHS) {
      const html = render(health);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('focusable="false"');
      expect(html).toContain(`data-health="${health}"`);
    }
  }, 10_000);

  it("draws all five in currentColor, so the text class colours it", () => {
    for (const health of HEALTHS) expect(render(health)).toContain("currentColor");
    expect(STATUS_TEXT).toEqual({
      operational: "text-ok",
      degraded: "text-warn",
      outage: "text-down",
      unknown: "text-unknown",
      maintenance: "text-muted",
    });
  });

  it("colours the Changed bar with the glyph's token, the accent for unknown", () => {
    for (const health of HEALTHS) {
      const token = health === "unknown" ? "accent" : STATUS_TEXT[health].replace("text-", "");
      expect(CHANGED_BAR.card[health]).toBe(`bg-${token}`);
      expect(CHANGED_BAR.row[health]).toBe(`after:bg-${token}`);
    }
  });

  it("gives each state its own silhouette", () => {
    const shapes = new Set(HEALTHS.map((health) => render(health, 20).replace(/data-health="[a-z]+"/, "")));
    expect(shapes.size).toBe(5);
    // Solid for what needs a person, outline for the calm: weight as severity.
    expect(render("operational")).toContain('fill="none"');
    expect(render("degraded")).toContain('fill="currentColor"');
    expect(render("outage")).toContain('fill="currentColor"');
    expect(render("unknown")).toContain("stroke-dasharray");
  });

  it("cuts the detail only from 18px up, and the silhouette below", () => {
    expect(GLYPH_DETAIL_MIN).toBe(18);
    // The check, the exclamation, the cross and the question mark are the detail.
    expect(render("operational", 18)).toContain("M7.7 12.5l3 2.9 5.7-6.4");
    expect(render("operational", 17)).not.toContain("M7.7 12.5l3 2.9 5.7-6.4");
    expect(render("degraded", 18)).toContain("M12 9.6v4.4");
    expect(render("degraded", 17)).not.toContain("M12 9.6v4.4");
    expect(render("outage", 18)).toContain("M8.9 8.9l6.2 6.2");
    expect(render("outage", 17)).not.toContain("M8.9 8.9l6.2 6.2");
    expect(render("unknown", 18)).toContain("M9.7 9.7c0-1.4");
    expect(render("unknown", 17)).not.toContain("M9.7 9.7c0-1.4");
    // The small cut is sturdier: 2.2 against 1.7.
    expect(render("operational", 17)).toContain('stroke-width="2.2"');
    expect(render("operational", 18)).toContain('stroke-width="1.7"');
  });

  it("is the size it is asked to be, 20px by default", () => {
    expect(render("operational")).toContain('width="20" height="20"');
    expect(render("operational", 14)).toContain('width="14" height="14"');
    expect(render("operational", 22)).toContain('width="22" height="22"');
  });

  it("cuts its marks out of the ground it sits on", () => {
    // The card by default (the :root value); the page or an inset when it sits there.
    expect(render("degraded")).not.toContain("--glyph-cut:");
    expect(render("degraded", 20, { cut: "bg" })).toContain("--glyph-cut:var(--color-bg)");
    expect(render("degraded", 20, { cut: "inset" })).toContain("--glyph-cut:var(--color-inset)");
    expect(render("degraded", 20, { cut: "card" })).toContain("--glyph-cut:var(--color-card)");
    expect(render("degraded")).toContain('stroke="var(--glyph-cut)"');
  });

  it("passes a class through", () => {
    expect(render("outage", 20, { className: "text-down mt-4" })).toContain('class="shrink-0 text-down mt-4"');
  });
});
