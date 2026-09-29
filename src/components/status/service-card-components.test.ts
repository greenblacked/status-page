import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComponentHealth, ServiceSnapshot } from "@/lib/status/types";
import { service } from "../../test/fixtures";
import { ServiceCard } from "./service-card-full";

const noop = () => {};

function render(id: ServiceSnapshot["id"], overrides: Partial<ServiceSnapshot> = {}): string {
  return renderToStaticMarkup(
    createElement(ServiceCard, {
      service: service(id, overrides),
      index: 0,
      starred: false,
      onToggleStar: noop,
      now: Date.parse("2026-09-27T12:00:00.000Z"),
    }),
  );
}

const up = (count: number): ComponentHealth[] =>
  Array.from({ length: count }, (_, index) => ({ name: `Part ${index + 1}`, health: "operational" }));

const LIST = '<ul aria-label="Components"';
const ROW = "glass-inset px-3 py-2";

describe("healthy service card", () => {
  it("names the first components, marks each up in words, and counts the rest", () => {
    const html = render("chatgpt", { summary: "All systems operational", components: up(24) });
    expect(html).toContain(LIST);
    expect(html.match(/<li/g)).toHaveLength(7);
    for (let n = 1; n <= 6; n++) expect(html).toContain(`>Part ${n}</span>`);
    expect(html).not.toContain(">Part 7<");
    expect(html).toContain("+18 more");
    expect(html.match(/<span class="sr-only">Operational<\/span>/g)).toHaveLength(6);
    // The summary, latency and source footer stay.
    expect(html).toContain("All systems operational");
    expect(html).toContain("1 ms");
    expect(html).toContain("Source");
    // No per-component rows.
    expect(html).not.toContain(ROW);
  });

  it("adds no count when every component fits", () => {
    const html = render("chatgpt", { components: up(3) });
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).not.toContain("more");
  });

  it("puts a stray non-operational component first with its status in words", () => {
    const components: ComponentHealth[] = [...up(2), { name: "Files", health: "degraded" }];
    const html = render("chatgpt", { components });
    expect(html.indexOf(">Files<")).toBeLessThan(html.indexOf(">Part 1<"));
    expect(html).toContain('<span class="sr-only">Degraded</span>');
  });

  it("renders no list at all without components", () => {
    const html = render("grok", { summary: "All systems operational" });
    expect(html).not.toContain("Components");
    expect(html).not.toContain("<ul");
    expect(html).toContain("All systems operational");
    expect(html).toContain("1 ms");
  });
});

describe("degraded service card", () => {
  const components: ComponentHealth[] = [
    ...up(3),
    { name: "Codex", health: "outage", detail: "Elevated errors on Codex" },
    { name: "Login", health: "degraded" },
  ];

  it("keeps rows for broken components only, without the healthy list", () => {
    const html = render("chatgpt", { health: "degraded", summary: "Partial outage", components });
    expect(html).not.toContain(LIST);
    expect(html.match(/glass-inset px-3 py-2/g)).toHaveLength(2);
    expect(html).toContain(">Codex</span>");
    expect(html).toContain(">Login</span>");
    expect(html).not.toContain("Part 1");
    expect(html).toContain("Elevated errors on Codex");
    expect(html).toContain("Outage");
    expect(html).toContain("Degraded");
  });

  it("caps rows at six", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      name: `Broken ${index}`,
      health: "degraded" as const,
    }));
    const html = render("chatgpt", { health: "degraded", components: many });
    expect(html.match(/glass-inset px-3 py-2/g)).toHaveLength(6);
  });
});

describe("release trackers and CS2 pops", () => {
  it("keep every component as a row, up or not", () => {
    const changelog = render("aws", { category: "updates", components: up(3) });
    expect(changelog).not.toContain(LIST);
    expect(changelog.match(/glass-inset px-3 py-2/g)).toHaveLength(3);

    const pops = render("cs2-europe", { components: up(3) });
    expect(pops).not.toContain(LIST);
    expect(pops.match(/glass-inset px-3 py-2/g)).toHaveLength(3);
  });
});
