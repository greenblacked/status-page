import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDockStore } from "@/lib/status/dock";
import type { LiveState } from "@/lib/status/schedule";
import type { Health } from "@/lib/status/types";
import { CompactHeader } from "./compact-header";

const CHECKED = Date.parse("2026-09-27T12:00:00.000Z");

function render(
  options: {
    live?: LiveState;
    tone?: Health;
    short?: string;
    checkedAt?: number | null;
    store?: ReturnType<typeof createDockStore>;
  } = {},
): string {
  // The controls go in as the third argument, the canonical way to pass children.
  const props: Omit<ComponentProps<typeof CompactHeader>, "children"> = {
    store: options.store ?? createDockStore(),
    barRef: { current: null },
    slotRef: { current: null },
    live: options.live ?? "live",
    verdict: { tone: options.tone ?? "operational", short: options.short ?? "Everything is up" },
    checkedAt: options.checkedAt === undefined ? CHECKED : options.checkedAt,
    nextIn: "1:52",
  };
  return renderToStaticMarkup(
    createElement(
      CompactHeader,
      props as ComponentProps<typeof CompactHeader>,
      createElement("button", { type: "button" }, "Refresh"),
    ),
  );
}

describe("CompactHeader", () => {
  it("is a labelled region that starts hidden and inert, so Tab never lands on it", () => {
    const html = render();
    expect(html).toContain('aria-label="Board controls"');
    expect(html).toContain('data-shown="false"');
    expect(html).toContain("inert");
  });

  it("is the one translucent element: a float with the bar's radius, not a pill", () => {
    const html = render();
    expect(html).toContain("compact-header float");
    expect(html).not.toContain("rounded-full");
  });

  it("leads with the verdict's glyph and its short form, shown on a phone too, where the check time is for a screen reader only", () => {
    const html = render({ tone: "outage", short: "2 need a look" });
    expect(html).toMatch(/^<section[^>]*><p data-bar-lead/);
    expect(html).toContain('data-health="outage"');
    expect(html).toContain("text-down");
    expect(html).toContain("data-bar-verdict");
    expect(html).not.toMatch(/data-bar-verdict[^>]*max-sm:sr-only/);
    expect(html).toContain(">2 need a look</span>");
    expect(html).toMatch(/max-sm:sr-only">Checked /);
  });

  it("says when the board was checked and when the next check is, in the viewer's zone once hydrated", () => {
    const html = render();
    expect(html).toContain("Checked <time");
    expect(html).toContain(">12:00 UTC</time> · next in 1:52");
  });

  it("says Checking while a check runs, and Stale when the board has stopped", () => {
    expect(render({ live: "checking" })).toContain("Checking…");
    const stale = render({ live: "stale" });
    expect(stale).toContain("Stale · checked <time");
    expect(stale).not.toContain("next in");
  });

  it("renders the board's controls after the slot the search field merges into", () => {
    const html = render();
    expect(html).toContain("<button");
    expect(html).toContain(">Refresh</button>");
    expect(html.indexOf("max-w-[26rem]")).toBeLessThan(html.indexOf(">Refresh</button>"));
  });

  it("reads the server snapshot on the server: a store that says the bar is up still renders it hidden", () => {
    const store = createDockStore();
    store.set({ barShown: true, docked: true });
    expect(render({ store })).toContain('data-shown="false"');
  });
});
