import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDockStore } from "@/lib/status/dock";
import type { LiveState } from "@/lib/status/schedule";
import type { Health } from "@/lib/status/types";
import { CompactHeader } from "./compact-header";

function render(
  options: {
    live?: LiveState;
    tone?: Health;
    title?: string;
    name?: string;
    store?: ReturnType<typeof createDockStore>;
  } = {},
): string {
  // The controls go in as the third argument, the canonical way to pass children.
  const props: Omit<ComponentProps<typeof CompactHeader>, "children"> = {
    store: options.store ?? createDockStore(),
    barRef: { current: null },
    slotRef: { current: null },
    name: options.name ?? "Status Board",
    live: options.live ?? "live",
    headline: { tone: options.tone ?? "operational", title: options.title ?? "All systems operational" },
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

  it("shows the board's name (screen readers only on a phone), its live state and the headline", () => {
    const html = render({ name: "Acme Board", live: "stale", tone: "outage", title: "Outage: ChatGPT" });
    expect(html).toContain('<span class="max-sm:sr-only">Acme Board</span>');
    expect(html).toContain('data-state="stale"');
    expect(html).toContain('<span class="truncate">Outage: ChatGPT</span>');
    expect(html).toContain("bg-down");
  });

  it("tones the headline's dot by its health", () => {
    expect(render({ tone: "degraded" })).toContain("bg-warn");
    expect(render({ tone: "operational" })).toContain("bg-ok");
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
