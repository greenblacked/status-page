import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Health } from "@/lib/status/types";
import { PeriodDial } from "./period-dial";

// 12:00:30 UTC with 20 s of jitter: the period ends at 12:02:20, so it is 10 s in.
const NOW = Date.parse("2026-09-27T12:00:30.000Z");

function render(now: number, tone: Health = "operational", className?: string): string {
  return renderToStaticMarkup(createElement(PeriodDial, { now, jitterMs: 20_000, tone, className }));
}

describe("PeriodDial", () => {
  it("is decorative and carries the period length and where the still dial stands", () => {
    const html = render(NOW);
    expect(html).toContain("aria-hidden");
    expect(html).toContain("--period-length:120000ms");
    // 10 s in, already a multiple of the 5 s step: 10000 / 120000.
    expect(html).toContain("--period-at:0.08333333333333333");
  });

  it("starts the motion part way in, by a negative delay", () => {
    const html = render(NOW);
    expect(html).toContain('data-running="true"');
    expect(html).toContain("--period-delay:-10000ms");
  });

  it("moves the still dial on in 5 s steps", () => {
    // 14 s into the period rounds down to 10 s; 15 s reaches the next step.
    expect(render(NOW + 4_000)).toContain("--period-at:0.08333333333333333");
    expect(render(NOW + 5_000)).toContain("--period-at:0.125");
  });

  it("stands at the start, with nothing running, before the client clock is mounted", () => {
    const html = render(0);
    expect(html).toContain("--period-at:0");
    expect(html).not.toContain("data-running");
    expect(html).not.toContain("--period-delay");
  });

  it("draws the tick ring twice (dark and lit), a hand and a dot toned by the headline", () => {
    const html = render(NOW, "outage", "size-8");
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html.match(/data-lit="true"/g)).toHaveLength(1);
    expect(html).toContain("period-hand");
    expect(html).toContain("text-down");
    expect(html).toContain("size-8");
  });
});
