import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Freshness } from "@/lib/status/schedule";
import { LiveBar } from "./live-bar";

// 12:00:30 UTC. With 20 s of jitter the slot's refetch (12:00:20) has passed, so the next is 12:02:20: 1:50 away.
const NOW = Date.parse("2026-09-27T12:00:30.000Z");
const JITTER_MS = 20_000;

function render(freshness: Freshness, options: { isFetching?: boolean; now?: number } = {}): string {
  return renderToStaticMarkup(
    createElement(LiveBar, {
      freshness,
      isFetching: options.isFetching ?? false,
      now: options.now ?? NOW,
      refetchJitterMs: JITTER_MS,
    }),
  );
}

const live: Freshness = { ageMs: 45_000, stale: false, state: "live" };

describe("LiveBar", () => {
  it("says Live, the age of the last check and the countdown to the next update", () => {
    const html = render(live);
    expect(html).toContain('data-testid="live-bar"');
    expect(html).toContain('aria-live="polite">Live</span>');
    expect(html).toContain("· last check 45s ago");
    expect(html).toContain('Next update <span class="text-fg">1:50</span>');
  });

  it("calls a very recent check just now", () => {
    expect(render({ ...live, ageMs: 3_000 })).toContain("· last check just now");
  });

  it("says a check is running, and not Live, while it runs", () => {
    const html = render({ ageMs: 45_000, stale: false, state: "checking" }, { isFetching: true });
    expect(html).toContain("Checking official sources");
    expect(html).not.toContain(">Live<");
  });

  it("marks a stale board with a badge and an age in words", () => {
    const html = render({ ageMs: 7 * 60_000, stale: true, state: "stale" });
    expect(html).toContain("Stale");
    expect(html).toContain("<span>last check 7 min ago</span>");
    expect(html).not.toContain("· last check");
    expect(html).not.toContain(">Live<");
  });

  it("holds placeholders until the client clock is mounted", () => {
    const html = render(live, { now: 0 });
    expect(html).toContain("· last check …");
    expect(html).toContain('Next update <span class="text-fg">—</span>');
  });

  it("counts down to the next slot's refetch when the slot's has not come yet", () => {
    const early = Date.parse("2026-09-27T12:00:05.000Z");
    expect(render(live, { now: early })).toContain('<span class="text-fg">0:15</span>');
  });
});
