import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComponentHealth, ReleaseFeed, ServiceSnapshot } from "@/lib/status/types";
import { service } from "../../test/fixtures";
import { ServiceCard } from "./service-card";

const noop = () => {};
const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function render(id: ServiceSnapshot["id"], overrides: Partial<ServiceSnapshot> = {}, emphasized = false): string {
  return renderToStaticMarkup(
    createElement(ServiceCard, {
      service: service(id, overrides),
      index: 0,
      starred: false,
      onToggleStar: noop,
      now: NOW,
      emphasized,
    }),
  );
}

const feed = (title: string, releasedAt: string | null = "2026-09-18T00:00:00.000Z"): ReleaseFeed => ({
  sourceName: "GitLab releases",
  sourceUrl: "https://about.gitlab.com/releases/",
  entries: [
    { title, release: { version: "18.4", ...(releasedAt ? { releasedAt } : {}) } },
    { title: "GitLab 18.3.2", release: { version: "18.3.2", releasedAt: "2026-09-10T00:00:00.000Z" } },
  ],
});

const text = (html: string) => html.replace(/<[^>]*>/g, "");
const triggers = (html: string) => html.match(/data-release-details-trigger/g) ?? [];
const lineOf = (html: string) => {
  const start = html.indexOf("data-release-line");
  return html.slice(start, html.indexOf("</p>", start));
};

describe("the release line of a status card", () => {
  it("sits under the health line of a healthy row with the title, the day and one Details button", () => {
    const html = render("gitlab", { name: "GitLab", latencyMs: 142, releaseFeed: feed("GitLab 18.4") });
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(text(lineOf(html))).toContain("GitLab 18.4 · Sep 18");
    expect(text(lineOf(html))).toContain("Details");
    expect(triggers(html)).toHaveLength(1);
    expect(html).toContain('aria-haspopup="dialog"');
    // The health line is untouched and comes first.
    expect(html.indexOf("Operational")).toBeGreaterThan(-1);
    expect(html.indexOf("Operational")).toBeLessThan(html.indexOf("data-release-line"));
    expect(html).toContain("142");
    expect(html).not.toContain("New release");
    expect(html).toContain('aria-label="GitLab status page"');
    expect(html).toContain('aria-label="Star GitLab"');
  });

  it("keeps the title and the day as one item that does not break inside, and leaves the day whole", () => {
    const line = lineOf(render("gitlab", { releaseFeed: feed("GitLab 18.4") }));
    expect(line).toMatch(/data-release-item="true" class="[^"]*inline-flex/);
    expect(line).toContain("line-clamp-1");
    // Only the day is held together; the title may wrap (its one clamped line never widens the card).
    expect(line).toMatch(/<span class="shrink-0 whitespace-pre"> · <time/);
    expect(line).not.toContain("whitespace-nowrap");
    expect(line).toMatch(/<time dateTime="2026-09-18T00:00:00.000Z"[^>]*>Sep 18<\/time>/);
    expect(line).not.toContain("overflow-wrap");
  });

  it("shows only the title when the entry has no readable day", () => {
    const line = lineOf(render("gitlab", { releaseFeed: feed("Some news", null) }));
    expect(text(line)).toContain("Some news");
    expect(text(line)).not.toContain("·");
    expect(line).not.toContain("<time");
  });

  it("shows no line, no button and no markup at all for a card without a feed", () => {
    for (const html of [
      render("gitlab"),
      render("gitlab", { releaseFeed: { ...feed("x"), entries: [] } }),
      render("gitlab", { health: "outage", summary: "Down" }),
      render("gitlab", { health: "unknown", summary: "Official source did not respond." }),
    ]) {
      expect(html).not.toContain("data-release-line");
      expect(triggers(html)).toHaveLength(0);
    }
  });

  it("also sits on a card that needs a look, once, without the footer button a tracker has", () => {
    const html = render("gitlab", {
      health: "outage",
      summary: "Pipelines are failing",
      releaseFeed: feed("GitLab 18.4"),
    });
    expect(html).toContain("Outage");
    expect(triggers(html)).toHaveLength(1);
    expect(text(lineOf(html))).toContain("GitLab 18.4 · Sep 18");
    expect(html.indexOf("Pipelines are failing")).toBeGreaterThan(html.indexOf("data-release-line"));
  });

  it("is there on a row whose reading failed: the feed is not the card's health", () => {
    const html = render("gitlab", {
      health: "unknown",
      summary: "Official source did not respond.",
      releaseFeed: feed("GitLab 18.4"),
    });
    expect(html).toContain("No data");
    expect(html).toContain("Official source did not respond.");
    expect(text(lineOf(html))).toContain("GitLab 18.4");
  });

  it("is under the list's summary, not in it: a button may not sit inside a summary", () => {
    const components: ComponentHealth[] = [{ name: "Git operations", health: "operational" }];
    const html = render("gitlab", { components, releaseFeed: feed("GitLab 18.4") });
    expect(html).toContain("<details");
    expect(html.indexOf("</summary>")).toBeLessThan(html.indexOf("data-release-line"));
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("data-release-line"));
    expect(html.match(/<summary/g)).toHaveLength(1);
    expect(html.slice(html.indexOf("<summary"), html.indexOf("</summary>"))).not.toContain("<button");
  });

  it("is in the header of a row that has no list to open", () => {
    const html = render("gitlab", { releaseFeed: feed("GitLab 18.4") });
    expect(html).not.toContain("<details");
    expect(html.indexOf("data-card-header")).toBeLessThan(html.indexOf("data-release-line"));
  });

  it("never marks a release tracker's row, whatever a snapshot carries", () => {
    const html = render("mikrotik", {
      category: "updates",
      components: [{ name: "Stable", health: "operational", detail: "7.21 · Sep 24" }],
      releaseFeed: feed("GitLab 18.4"),
    });
    expect(html).not.toContain("data-release-line");
    expect(triggers(html)).toHaveLength(1);
  });
});

describe("a release tracker's line", () => {
  const components: ComponentHealth[] = [
    { name: "Stable", health: "operational", detail: "7.21 · Sep 24" },
    { name: "Long-term", health: "operational", detail: "7.18.2 · Sep 1" },
  ];

  it("is made of items that do not break inside, so a date cannot lose its month", () => {
    const html = render("mikrotik", { category: "updates", components });
    expect(html).not.toContain("overflow-wrap:anywhere");
    expect(html.match(/data-release-item/g)).toHaveLength(2);
    const items = [...html.matchAll(/<span data-release-item="true" class="whitespace-nowrap">([^<]*)<\/span>/g)].map(
      (match) => match[1],
    );
    expect(items).toEqual(["Stable 7.21 · Sep 24 ·", "Long-term 7.18.2 · Sep 1"]);
  });

  it("keeps Details with the last item, in one unit", () => {
    const html = render("mikrotik", { category: "updates", components });
    const tail = html.slice(html.indexOf("data-release-tail"), html.indexOf("</button>"));
    expect(tail).toContain("Long-term 7.18.2 · Sep 1");
    expect(tail).toContain("data-release-details-trigger");
    expect(tail).not.toContain("Stable");
  });

  it("keeps the Changed tag and Details with the last item too", () => {
    const html = render("mikrotik", { category: "updates", components }, true);
    const tail = html.slice(html.indexOf("data-release-tail"), html.indexOf("</button>"));
    expect(tail).toContain("Changed");
    expect(tail).toContain("data-release-details-trigger");
  });

  it("is one item with a unit of its own when it lists no versions", () => {
    const html = render("mikrotik", { category: "updates", components: [{ name: "x", health: "operational" }] });
    expect(text(html.slice(html.indexOf("data-release-item")))).toContain("No new release");
  });
});
