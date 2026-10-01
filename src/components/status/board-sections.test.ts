import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CATALOG } from "@/lib/status/catalog";
import { groupServices } from "@/lib/status/layout";
import type { Health, ServiceId, ServiceSnapshot } from "@/lib/status/types";
import { service } from "../../test/fixtures";
import { BoardSections, upByCategory } from "./board-sections";

const noop = () => {};
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

/** Every catalog service, operational unless told otherwise. */
function all(health: Partial<Record<ServiceId, Health>> = {}): ServiceSnapshot[] {
  return CATALOG.map((entry) => service(entry.id, { ...entry, health: health[entry.id] ?? "operational" }));
}

function render(
  services: ServiceSnapshot[],
  {
    mostUrgentId,
    changed = [],
    feed,
    placeholder,
  }: { mostUrgentId?: ServiceId; changed?: ServiceId[]; feed?: ReactNode; placeholder?: ReactNode } = {},
): string {
  return renderToStaticMarkup(
    createElement(BoardSections, {
      groups: groupServices(services),
      mostUrgentId,
      changedIds: new Set(changed),
      starred: new Set<ServiceId>(),
      onToggleStar: noop,
      now: NOW,
      feed,
      placeholder,
    }),
  );
}

const sections = (html: string) =>
  [...html.matchAll(/<section data-group="(\w+)" aria-labelledby="([\w-]+)"/g)].map((m) => [m[1], m[2]]);
const headings = (html: string) =>
  [...html.matchAll(/<h2 id="([\w-]+)"[^>]*>([^<]*)<span[^>]*>(\d+)<\/span>/g)].map((m) => `${m[2].trim()} ${m[3]}`);

describe("BoardSections", () => {
  it("draws every group in reading order, each with its heading and count", () => {
    const html = render(all({ aws: "outage", epic: "maintenance", android: "unknown" }));
    expect(sections(html)).toEqual([
      ["attention", "attention-heading"],
      ["unread", "unread-heading"],
      ["up", "up-cloud-heading"],
      ["up", "up-gaming-heading"],
      ["up", "up-platforms-heading"],
      ["up", "up-ai-heading"],
      ["releases", "releases-heading"],
    ]);
    expect(headings(html)).toEqual([
      "Needs a look 2",
      "Couldn&#x27;t read 1",
      "Cloud 1",
      "Gaming 3",
      "Platforms 2",
      "AI 3",
      "Releases 3",
    ]);
  });

  it("puts a service that could not be read under Couldn't read, never under Needs a look", () => {
    const html = render(all({ android: "unknown" }));
    expect(sections(html).map(([group]) => group)).not.toContain("attention");
    const unread = html.slice(html.indexOf('data-group="unread"'), html.indexOf('data-group="up"'));
    expect(unread).toContain("I couldn&#x27;t reach these. That says nothing about whether they&#x27;re up.");
    expect(unread).toContain('id="service-android"');
    expect(unread).toContain(">No data</span>");
    expect(html.slice(0, html.indexOf('data-group="unread"'))).not.toContain("service-android");
  });

  it("lists exactly the groups' unread bucket under Couldn't read, and its attention list under Needs a look", () => {
    const groups = groupServices(all({ android: "unknown", aws: "outage" }));
    const html = renderToStaticMarkup(
      createElement(BoardSections, {
        groups: { ...groups, unread: [service("grok", { health: "unknown" })] },
        changedIds: new Set<ServiceId>(),
        starred: new Set<ServiceId>(),
        onToggleStar: noop,
        now: NOW,
      }),
    );
    const unread = html.slice(html.indexOf('data-group="unread"'), html.indexOf('data-group="up"'));
    expect(unread).toContain('id="service-grok"');
    expect(unread).not.toContain('id="service-android"');
    const attention = html.slice(html.indexOf('data-group="attention"'), html.indexOf('data-group="unread"'));
    expect(attention).toContain('id="service-aws"');
    expect(attention).not.toContain("service-grok");
  });

  it("groups the healthy services by category in catalog order and leaves empty ones out", () => {
    const groups = upByCategory(all().filter((s) => s.category !== "gaming" && s.category !== "updates"));
    expect(groups.map((g) => g.id)).toEqual(["cloud", "platforms", "ai"]);
    expect(groups[0].label).toBe("Cloud");
    expect(groups.flatMap((g) => g.services.map((s) => s.id))).toEqual(
      CATALOG.filter((e) => e.category === "cloud" || e.category === "platforms" || e.category === "ai").map(
        (e) => e.id,
      ),
    );
  });

  it("lists every row in a card list with one article per service", () => {
    const html = render(all({ aws: "outage" }));
    expect(html.match(/<article/g)).toHaveLength(CATALOG.length);
    for (const entry of CATALOG) expect(html.match(new RegExp(`id="service-${entry.id}"`, "g"))).toHaveLength(1);
    // Healthy and release rows sit in list items of a card list; attention cards do not.
    expect(
      html.match(
        /<ul aria-describedby="[^"]*" class="surface spotlight card-list">|<ul class="surface spotlight card-list">/g,
      ),
    ).toHaveLength(5);
    expect(html.match(/<li><article/g)).toHaveLength(CATALOG.length - 1);
  });

  it("puts attention cards first in the DOM, and marks only the most urgent", () => {
    const html = render(all({ aws: "outage", gcp: "degraded" }), { mostUrgentId: "aws" });
    expect(html.indexOf("service-aws")).toBeLessThan(html.indexOf("service-gcp"));
    expect(html.match(/data-highlight="true"/g)).toHaveLength(1);
    expect(html.slice(html.indexOf('data-highlight="true"') - 60, html.indexOf('data-highlight="true"'))).toContain(
      "service-aws",
    );
  });

  it("sets no highlight when nothing is in outage or degraded", () => {
    expect(render(all({ epic: "maintenance", android: "unknown" }), { mostUrgentId: "epic" })).not.toContain(
      "data-highlight",
    );
    expect(render(all())).not.toContain("data-highlight");
  });

  it("marks a service that changed, in a card or a row", () => {
    const html = render(all({ aws: "outage" }), { changed: ["aws", "steam"] });
    expect(html.match(/data-changed="true"/g)).toHaveLength(2);
  });

  it("puts the feed right after Needs a look, before Couldn't read, the categories and Releases", () => {
    const feed = createElement("section", { "data-feed": "" }, "Recent changes");
    const html = render(all({ aws: "outage", epic: "maintenance", android: "unknown" }), { feed });
    const at = (needle: string) => html.indexOf(needle);
    expect(html.match(/data-feed/g)).toHaveLength(1);
    expect(at('data-group="attention"')).toBeLessThan(at("data-feed"));
    expect(at("data-feed")).toBeLessThan(at('data-group="unread"'));
    expect(at('data-group="unread"')).toBeLessThan(at('data-group="up"'));
    expect(at('data-group="up"')).toBeLessThan(at('data-group="releases"'));
    // The feed shares the sections' column, so it keeps their gap-8.
    expect(html.startsWith('<div class="flex flex-col gap-8"><section data-group="attention"')).toBe(true);
  });

  it("leads the board with the feed when nothing needs a look", () => {
    const feed = createElement("section", { "data-feed": "" }, "Recent changes");
    const html = render(all({ android: "unknown" }), { feed });
    expect(sections(html).map(([group]) => group)).not.toContain("attention");
    expect(html.startsWith('<div class="flex flex-col gap-8"><section data-feed="">')).toBe(true);
    expect(html.indexOf("data-feed")).toBeLessThan(html.indexOf('data-group="unread"'));
    const calm = render(all(), { feed });
    expect(calm.indexOf("data-feed")).toBeLessThan(calm.indexOf('data-group="up"'));
  });

  it("draws the placeholder, then the feed, when there are no groups", () => {
    const feed = createElement("section", { "data-feed": "" }, "Recent changes");
    const placeholder = createElement("p", { "data-placeholder": "" }, "Nothing matches");
    expect(render([], { feed, placeholder })).toBe(
      '<div class="flex flex-col gap-8"><p data-placeholder="">Nothing matches</p><section data-feed="">Recent changes</section></div>',
    );
  });

  it("draws nothing for an empty board", () => {
    expect(render([])).toBe('<div class="flex flex-col gap-8"></div>');
  });
});
