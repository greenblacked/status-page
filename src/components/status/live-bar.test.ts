import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Freshness } from "@/lib/status/schedule";
import { LiveBar, nextInText } from "./live-bar";

// 12:00:30 UTC. With 20 s of jitter the slot's refetch (12:00:20) has passed, so the next is 12:02:20: 1:50 away.
const NOW = Date.parse("2026-09-27T12:00:30.000Z");
const CHECKED = Date.parse("2026-09-27T12:00:00.000Z");
const JITTER_MS = 20_000;

function render(freshness: Freshness, options: { now?: number; checkedAt?: number | null } = {}): string {
  return renderToStaticMarkup(
    createElement(LiveBar, {
      freshness,
      now: options.now ?? NOW,
      refetchJitterMs: JITTER_MS,
      checkedAt: options.checkedAt === undefined ? CHECKED : options.checkedAt,
    }),
  );
}

const live: Freshness = { ageMs: 45_000, stale: false, state: "live" };

describe("LiveBar", () => {
  it("tells a screen reader Live, and shows when it was checked and the countdown to the next check", () => {
    const html = render(live);
    expect(html).toContain('data-testid="live-bar"');
    expect(html).toContain('aria-live="polite"><span class="sr-only">Live</span></span>');
    expect(html).toContain("Checked <time");
    expect(html).toContain(">12:00 UTC</time>");
    expect(html).toContain('next in <span class="text-fg">1:50</span>');
  });

  it("keeps the live region to the state word: the clock and the countdown sit outside it", () => {
    const html = render(live);
    const region = /aria-live="polite">(.*?)<\/span><\/span>/.exec(html)?.[1] ?? "";
    expect(region).not.toContain("Checked");
    expect(region).not.toContain("1:50");
  });

  it("says a check is running, and not Live, while it runs", () => {
    const html = render({ ageMs: 45_000, stale: false, state: "checking" });
    expect(html).toContain('aria-live="polite">Checking…</span>');
    expect(html).toContain("live-checking");
    expect(html).not.toContain("Live");
    expect(html).not.toContain("next in");
  });

  it("marks a stale board and gives the age of its last check in words", () => {
    const html = render({ ageMs: 7 * 60_000, stale: true, state: "stale" });
    expect(html).toContain("Stale</span>.");
    expect(html).toContain("Last checked 7 min ago.");
    expect(html).not.toContain("next in");
    expect(html).not.toContain(">Live<");
  });

  it("holds placeholders until the client clock is mounted", () => {
    const html = render(live, { now: 0 });
    expect(html).toContain('next in <span class="text-fg">—</span>');
  });

  it("counts down to the next slot's refetch when the slot's has not come yet", () => {
    const early = Date.parse("2026-09-27T12:00:05.000Z");
    expect(nextInText(early, JITTER_MS)).toBe("0:15");
    expect(nextInText(0, JITTER_MS)).toBe("—");
  });

  it("draws the period dial only when it is handed one", () => {
    const html = renderToStaticMarkup(
      createElement(LiveBar, {
        freshness: live,
        now: NOW,
        refetchJitterMs: JITTER_MS,
        checkedAt: CHECKED,
        dial: createElement("i", { className: "the-dial" }),
      }),
    );
    expect(html).toContain('<i class="the-dial"></i>');
    expect(render(live)).not.toContain("the-dial");
  });
});
