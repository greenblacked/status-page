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
const ROW = "data-component-row";
const rows = (html: string) => html.match(/data-component-row/g) ?? [];

describe("healthy service card", () => {
  it("names the first components, marks each up in words, and counts the rest", () => {
    const html = render("chatgpt", { summary: "All systems operational", components: up(24) });
    expect(html).toContain(LIST);
    expect(html.match(/<li/g)).toHaveLength(7);
    for (let n = 1; n <= 6; n++) expect(html).toContain(`>Part ${n}</span>`);
    expect(html).not.toContain(">Part 7<");
    expect(html).toContain("+18 more");
    expect(html).toContain("18 more components");
    expect(html.match(/<span class="sr-only">Operational<\/span>/g)).toHaveLength(6);
    // The summary, latency and source footer stay.
    expect(html).toContain("All systems operational");
    expect(html).toContain("1 ms");
    expect(html).toContain("Source");
    // No per-component rows.
    expect(html).not.toContain(ROW);
  });

  it("counts the vendor's true total when the snapshot kept fewer components", () => {
    const html = render("chatgpt", { components: up(24), componentCount: 40 });
    expect(html.match(/<li/g)).toHaveLength(7);
    expect(html).toContain("+34 more");
    expect(html).toContain("34 more components");
    expect(html).not.toContain("+18 more");
  });

  it("falls back to the components it has when the total is absent or smaller", () => {
    expect(render("chatgpt", { components: up(24) })).toContain("+18 more");
    expect(render("chatgpt", { components: up(24), componentCount: 3 })).toContain("+18 more");
  });

  it("adds no count when every component fits", () => {
    const html = render("chatgpt", { components: up(3) });
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).not.toContain("data-more-components");
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
    expect(rows(html)).toHaveLength(2);
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
    expect(rows(html)).toHaveLength(6);
  });
});

describe("release trackers and CS2 pops", () => {
  it("keep every component as a row, up or not", () => {
    const changelog = render("aws", { category: "updates", components: up(3) });
    expect(changelog).not.toContain(LIST);
    expect(rows(changelog)).toHaveLength(3);

    const pops = render("cs2-europe", { components: up(3) });
    expect(pops).not.toContain(LIST);
    expect(rows(pops)).toHaveLength(3);
  });
});

describe("release tracker header badge", () => {
  const header = (html: string) => html.slice(html.indexOf("data-card-header"), html.indexOf("</h3>"));
  const badge = (html: string) => html.slice(html.indexOf("</h3>"), html.indexOf("Star "));
  const fresh: ComponentHealth[] = [{ name: "Stable", health: "maintenance" }, ...up(1)];

  it("says nothing while no release is new", () => {
    const html = render("mikrotik", { category: "updates", components: up(2) });
    expect(header(html)).toBeTruthy();
    expect(badge(html)).not.toContain("Operational");
    expect(badge(html)).not.toContain('<span class="inline-flex');
  });

  it("says New release when a channel is fresh", () => {
    const html = render("apple-os", { category: "updates", components: fresh });
    expect(badge(html)).toContain(">New release</span>");
    expect(badge(html)).not.toContain("Operational");
  });

  it("keeps the ordinary badge for a source that could not be read", () => {
    const html = render("mikrotik", { category: "updates", health: "unknown" });
    expect(badge(html)).toContain(">Unknown</span>");
  });

  it("still labels a status service Operational", () => {
    expect(badge(render("aws"))).toContain(">Operational</span>");
  });
});

describe("highlighted service card", () => {
  const renderCard = (highlight: boolean) =>
    renderToStaticMarkup(
      createElement(ServiceCard, {
        service: service("aws", { health: "outage", summary: "Increased error rates" }),
        index: 0,
        highlight,
        starred: false,
        onToggleStar: noop,
        now: Date.parse("2026-09-27T12:00:00.000Z"),
      }),
    );

  it("marks the one article, with the caption as its first child and the wide-screen span", () => {
    const html = renderCard(true);
    expect(html.startsWith("<article")).toBe(true);
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html).toContain('data-highlight="true"');
    expect(html).toContain("@xl:col-span-2");
    const opening = html.indexOf(">") + 1;
    expect(html.slice(opening).startsWith("<p")).toBe(true);
    expect(html.slice(opening, html.indexOf("</p>"))).toContain("Most urgent");
  });

  it("carries no mark, caption or span otherwise", () => {
    const html = renderCard(false);
    expect(html).not.toContain("data-highlight");
    expect(html).not.toContain("Most urgent");
    expect(html).not.toContain("col-span-2");
  });
});

describe("service card truncation", () => {
  const broken = (count: number): ComponentHealth[] =>
    Array.from({ length: count }, (_, index) => ({ name: `Broken ${index + 1}`, health: "degraded" }));
  const incident = (n: number) => ({
    id: `i${n}`,
    title: `Incident ${n}`,
    health: "degraded" as const,
    url: `https://status.example.com/i${n}`,
  });

  it("says how many broken rows it cut", () => {
    const html = render("chatgpt", { health: "degraded", summary: "Partial outage", components: broken(9) });
    expect(rows(html)).toHaveLength(6);
    expect(html).toContain("data-more-rows");
    expect(html).toContain("+3 more");
    expect(html).toContain("3 more components");
  });

  it("says nothing when every row fits", () => {
    const html = render("chatgpt", { health: "degraded", components: broken(6) });
    expect(rows(html)).toHaveLength(6);
    expect(html).not.toContain("data-more-rows");
  });

  it("says how many incidents it cut", () => {
    const html = render("chatgpt", {
      health: "degraded",
      summary: "Partial outage",
      incidents: [incident(1), incident(2), incident(3), incident(4), incident(5)],
    });
    expect(html).toContain(">Incident 1<");
    expect(html).toContain(">Incident 2<");
    expect(html).not.toContain(">Incident 3<");
    expect(html).toContain("data-more-incidents");
    expect(html).toContain("+3 more");
    expect(html).toContain("3 more incidents");
  });

  it("adds no count for two incidents", () => {
    const html = render("chatgpt", { health: "degraded", incidents: [incident(1), incident(2)] });
    expect(html).not.toContain("data-more-incidents");
  });
});

describe("service card incident labels and links", () => {
  const link = (html: string) => /href="([^"]+)"[^>]*>\s*<span class="min-w-0">([^<]+)</.exec(html)?.slice(1);

  it("labels an informational notice a Notice, never Operational", () => {
    const html = render("claude", {
      summary: "All reported systems operational.",
      incidents: [{ id: "n", title: "Database upgrade", health: "operational", informational: true }],
    });
    expect(html).toContain(">Notice</span>");
    expect(html).toContain("Database upgrade");
  });

  it("links to the worst incident, not the first listed", () => {
    const html = render("chatgpt", {
      health: "outage",
      sourceUrl: "https://status.example.com/",
      incidents: [
        { id: "minor", title: "Minor", health: "degraded", url: "https://status.example.com/minor" },
        { id: "major", title: "Major", health: "outage", url: "https://status.example.com/major" },
      ],
    });
    expect(link(html)).toEqual(["https://status.example.com/major", "View incident"]);
  });

  it("does not call the vendor's generic dashboard an incident", () => {
    const html = render("aws", {
      health: "degraded",
      sourceName: "AWS Health Dashboard",
      sourceUrl: "https://health.aws.amazon.com/health/status",
      incidents: [
        {
          id: "a",
          title: "S3 (Ohio) - Errors",
          health: "degraded",
          url: "https://health.aws.amazon.com/health/status",
        },
      ],
    });
    expect(link(html)).toEqual(["https://health.aws.amazon.com/health/status", "AWS Health Dashboard"]);
    expect(html).not.toContain("View incident");
  });

  it("shows upcoming maintenance as Upcoming, apart from the health", () => {
    const html = render("claude", {
      summary: "All reported systems operational.",
      upcomingMaintenance: [{ id: "m", title: "Database upgrade", scheduledFor: "2026-09-28T02:00:00.000Z" }],
    });
    expect(html).toContain("data-upcoming-maintenance");
    expect(html).toContain(">Upcoming</span>");
    expect(html).toContain("Database upgrade");
    expect(html).toContain("scheduled for ");
    expect(html).toContain(">Operational</span>");
  });
});
