import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComponentHealth, ServiceSnapshot } from "@/lib/status/types";
import { service } from "../../test/fixtures";
import { ServiceCard } from "./service-card";

const noop = () => {};
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

function render(
  id: ServiceSnapshot["id"],
  overrides: Partial<ServiceSnapshot> = {},
  props: { highlight?: boolean; emphasized?: boolean; released?: boolean; starred?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(ServiceCard, {
      service: service(id, overrides),
      index: 0,
      starred: false,
      onToggleStar: noop,
      now: NOW,
      ...props,
    }),
  );
}

const up = (count: number): ComponentHealth[] =>
  Array.from({ length: count }, (_, index) => ({ name: `Part ${index + 1}`, health: "operational" }));

const LIST = 'aria-label="Components"';
const rows = (html: string) => html.match(/data-component-row/g) ?? [];
/** The header of a card or row: from the marker to the end of the name and its line. */
const header = (html: string) =>
  html.slice(html.indexOf("data-card-header"), html.indexOf("</p>", html.indexOf("data-card-header")));

describe("healthy service row", () => {
  it("is one article with a glyph, the name, the word and the latency, and no summary line", () => {
    const html = render("aws", { name: "Amazon Web Services", summary: "All systems operational", latencyMs: 142 });
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html).toContain('id="service-aws"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('data-health="operational"');
    expect(html).toContain("<h3");
    expect(header(html)).toContain(">Operational</span>");
    expect(header(html)).toContain("142 ms");
    expect(html).not.toContain("All systems operational");
    expect(html).not.toContain("Nothing reported");
    // The glyph is decoration: the word beside it is the status.
    expect(html).toMatch(/<svg aria-hidden="true"[^>]*data-health="operational"/);
  });

  it("has the Star button and the status-page link, each a 44px target", () => {
    const html = render("aws", { name: "Amazon Web Services", sourceUrl: "https://health.aws.amazon.com/" });
    expect(html).toContain('aria-label="Star Amazon Web Services"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('title="Pin Amazon Web Services to the top"');
    expect(html).toContain('aria-label="Amazon Web Services status page"');
    expect(html).toContain('href="https://health.aws.amazon.com/"');
    expect(html).toContain('rel="noreferrer"');
    expect(html.match(/size-11/g)).toHaveLength(2);
  });

  it("says Unpin for a starred service", () => {
    const html = render("aws", { name: "AWS" }, { starred: true });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('title="Unpin AWS"');
    expect(html).toContain('aria-label="Star AWS"');
  });

  it("names the first components in a disclosure, marks each up in words, and counts the rest", () => {
    const html = render("chatgpt", { summary: "All systems operational", components: up(24) });
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain(LIST);
    expect(html.match(/<li/g)).toHaveLength(6);
    for (let n = 1; n <= 6; n++) expect(html).toContain(`>Part ${n}</span>`);
    expect(html).not.toContain(">Part 7<");
    // The rest is behind a real button, collapsed until it is pressed.
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*>Show all 24/,
    );
    expect(html).toContain("data-more-components");
    expect(html.match(/<span class="sr-only">Operational<\/span>/g)).toHaveLength(6);
    // The row keeps its name, word and latency in the summary; no per-component rows.
    expect(header(html)).toContain(">Operational</span>");
    expect(html).toContain("1 ms");
    expect(html).not.toContain("data-component-row");
  });

  it("promises only the components it holds, and says so when the vendor lists more", () => {
    const html = render("chatgpt", { components: up(24), componentCount: 40 });
    expect(html.match(/<li/g)).toHaveLength(6);
    expect(html).toContain("Show all 24");
    expect(html).not.toContain("Show all 40");
    // The cut is named once the list is open, with a way to the vendor's full list.
    const short = render("chatgpt", { components: up(4), componentCount: 40 });
    expect(short).toContain("4 of 40");
    expect(short).toContain("full list on the status page");
  });

  it("falls back to the components it has when the total is absent or smaller", () => {
    expect(render("chatgpt", { components: up(24) })).toContain("Show all 24");
    expect(render("chatgpt", { components: up(24), componentCount: 3 })).toContain("Show all 24");
  });

  it("adds no count when every component fits", () => {
    const html = render("chatgpt", { components: up(3) });
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).not.toContain("data-more-components");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("Show all");
  });

  it("puts a stray non-operational component first with its status in words", () => {
    const components: ComponentHealth[] = [...up(2), { name: "Files", health: "degraded" }];
    const html = render("chatgpt", { components });
    expect(html.indexOf(">Files<")).toBeLessThan(html.indexOf(">Part 1<"));
    expect(html).toContain('<span class="sr-only">Degraded</span>');
  });

  it("is not a disclosure at all without components", () => {
    const html = render("grok", { summary: "All systems operational" });
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).not.toContain("Components");
    expect(html).not.toContain("<ul");
    expect(header(html)).toContain(">Operational</span>");
  });

  it("opens to a notice or planned maintenance, and flags them under the name", () => {
    const notice = render("claude", {
      summary: "All reported systems operational.",
      incidents: [{ id: "n", title: "Database upgrade", health: "operational", informational: true }],
    });
    expect(notice).toContain("<details");
    expect(notice).toContain(">Notice</span>");
    expect(notice).toContain("Database upgrade");
    expect(header(notice)).toContain(" · Notice");
    expect(header(notice)).toContain(">Operational</span>");

    const planned = render("claude", {
      upcomingMaintenance: [{ id: "m", title: "Database upgrade", scheduledFor: "2026-09-28T02:00:00.000Z" }],
    });
    expect(header(planned)).toContain(" · Maintenance planned");
    expect(planned).toContain("data-upcoming-maintenance");
  });
});

describe("row that could not be read", () => {
  it("wears the unknown glyph and the word No data, with the reason as its line and no latency", () => {
    const html = render("grok", { health: "unknown", summary: "Didn't answer in time.", latencyMs: 4000 });
    expect(html).toContain('data-health="unknown"');
    expect(header(html)).toContain(">No data</span>");
    expect(header(html)).toContain("Didn&#x27;t answer in time.");
    expect(html).not.toContain("Unknown");
    expect(html).not.toContain("4000");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("data-highlight");
  });

  it("keeps a release tracker that could not be read a plain row, not a release row", () => {
    const html = render("mikrotik", { category: "updates", health: "unknown" });
    expect(header(html)).toContain(">No data</span>");
    expect(html).not.toContain("New release");
    expect(html).not.toContain("No new release");
  });
});

describe("degraded service card", () => {
  const components: ComponentHealth[] = [
    ...up(3),
    { name: "Codex", health: "outage", detail: "Elevated errors on Codex" },
    { name: "Login", health: "degraded" },
  ];

  it("keeps rows for broken components only, in the Components list", () => {
    const html = render("chatgpt", { health: "degraded", summary: "Partial outage", components });
    expect(html).toContain(LIST);
    expect(rows(html)).toHaveLength(2);
    expect(html).toContain(">Codex</span>");
    expect(html).toContain(">Login</span>");
    expect(html).toContain("Elevated errors on Codex");
    expect(html).toContain(">Outage</span>");
    expect(html).toContain(">Degraded</span>");
    // The working components sit in the same dropdown a healthy row has, not among the broken rows.
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain("Working components · 3");
    expect(html.indexOf("Part 1")).toBeGreaterThan(html.indexOf("<details"));
  });

  it("has no dropdown when every component is broken, and one when any is working", () => {
    const allBroken = render("chatgpt", {
      health: "degraded",
      components: [{ name: "Codex", health: "outage" }],
    });
    expect(allBroken).not.toContain("<details");
    const some = render("chatgpt", { health: "outage", components: [{ name: "A", health: "outage" }, ...up(1)] });
    expect(some).toContain("<details");
  });

  it("counts the working components from the vendor's total when the snapshot is cut", () => {
    const html = render("gcp", {
      health: "degraded",
      components: [{ name: "Cloud Run", health: "degraded" }, ...up(23)],
      componentCount: 215,
    });
    expect(html).toContain("Working components · 214");
    // The button promises what it will open: the 23 working components the snapshot holds.
    expect(html).toContain("Show all 23");
    expect(html).not.toContain("Show all 214");
  });

  it("caps rows at six", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      name: `Broken ${index}`,
      health: "degraded" as const,
    }));
    const html = render("chatgpt", { health: "degraded", components: many });
    expect(rows(html)).toHaveLength(6);
  });

  it("puts the glyph, name, coloured word and since-time in the header, and the summary under it", () => {
    const html = render("chatgpt", {
      name: "ChatGPT",
      health: "degraded",
      summary: "Partial outage",
      incidents: [{ id: "a", title: "Partial outage", health: "degraded", startedAt: "2026-09-27T10:00:00.000Z" }],
    });
    expect(html).toContain('data-health="degraded"');
    expect(header(html)).toContain(">ChatGPT</h3>");
    expect(header(html)).toContain("font-semibold");
    expect(header(html)).toContain(">Degraded</span>");
    expect(header(html)).toContain("since <time");
    expect(header(html)).toContain("10:00\u202fUTC");
    // Its title is the summary, so the incident has no line of its own and the time is not printed twice.
    expect(html.match(/10:00[ \u202f]UTC/g)).toHaveLength(2);
    expect(html).toContain("Partial outage</p>");
    expect(html).not.toContain("Most urgent");
    expect(html.match(/<h3/g)).toHaveLength(1);
  });

  it("draws the pen loop round an outage only", () => {
    expect(render("aws", { health: "outage" })).toContain("pen-loop");
    expect(render("aws", { health: "degraded" })).not.toContain("pen-loop");
    expect(render("aws", { health: "maintenance" })).not.toContain("pen-loop");
  });

  it("says Changed when the service changed, with the context for a screen reader", () => {
    const changed = render("aws", { health: "degraded" }, { emphasized: true });
    expect(changed).toContain('data-changed="true"');
    expect(changed).toContain('Changed<span class="sr-only"> since the last check</span>');
    const quiet = render("aws", { health: "degraded" });
    expect(quiet).not.toContain("data-changed");
    expect(quiet).not.toContain("Changed");
  });
});

describe("the Changed bar", () => {
  const BARS = {
    outage: "bg-down",
    degraded: "bg-warn",
    maintenance: "bg-muted",
    operational: "bg-ok",
    unknown: "bg-accent",
  } as const;

  // A card for what needs a look, a row for the rest: the bar is an element in the first and the row's ::after in the second.
  it("takes the colour of the state on a card", () => {
    for (const health of ["outage", "degraded", "maintenance"] as const) {
      const html = render("aws", { health }, { emphasized: true });
      const bar = html.slice(
        html.indexOf("<span aria-hidden"),
        html.indexOf("</span>", html.indexOf("<span aria-hidden")),
      );
      expect(bar).toMatch(new RegExp(`class="[^"]* ${BARS[health]}( |")`));
      expect(bar).not.toContain("bg-accent");
      expect(bar).toContain("forced-colors:bg-[CanvasText]");
      expect(bar).toContain("starting:opacity-0");
      expect(bar).toContain("motion-reduce:transition-none");
    }
  });

  it("takes the colour of the state on a row, green for a recovery and the accent for unknown", () => {
    for (const health of ["operational", "unknown"] as const) {
      const html = render("aws", { health }, { emphasized: true });
      const article = html.slice(0, html.indexOf(">"));
      expect(article).toContain(`after:${BARS[health]}`);
      expect(article).toContain("forced-colors:after:bg-[CanvasText]");
      expect(article).toContain("after:starting:opacity-0");
      expect(article).toContain("motion-reduce:after:transition-none");
      for (const other of Object.values(BARS)) {
        if (other !== BARS[health]) expect(article).not.toContain(`after:${other}`);
      }
    }
  });

  it("keeps the neutral accent on a release tracker whose change is a new release", () => {
    const html = render("aws", { category: "updates", health: "operational" }, { emphasized: true, released: true });
    const article = html.slice(0, html.indexOf(">"));
    expect(article).toContain("after:bg-accent");
    expect(article).not.toContain("after:bg-ok");
    expect(article).toContain("forced-colors:after:bg-[CanvasText]");
  });

  it("turns a release tracker green when its source recovered with the same versions", () => {
    const html = render("aws", { category: "updates", health: "operational" }, { emphasized: true });
    const article = html.slice(0, html.indexOf(">"));
    expect(article).toContain("after:bg-ok");
    expect(article).not.toContain("after:bg-accent");
    expect(article).toContain("forced-colors:after:bg-[CanvasText]");
  });

  it("draws no bar, in any colour, on a service that did not change", () => {
    for (const health of Object.keys(BARS) as (keyof typeof BARS)[]) {
      const html = render("aws", { health });
      for (const bar of Object.values(BARS)) expect(html).not.toContain(`after:${bar}`);
      expect(html).not.toContain("inset-y-4 left-0 w-0.5");
    }
  });
});

describe("release trackers and CS2 relays", () => {
  it("keep every component as a row on a card that needs a look, up or not", () => {
    const changelog = render("aws", { category: "updates", health: "maintenance", components: up(3) });
    expect(rows(changelog)).toHaveLength(3);

    const relays = render("cs2-europe", { health: "degraded", components: up(3) });
    expect(rows(relays)).toHaveLength(3);
  });

  it("list a healthy relay set in the disclosure like any other components", () => {
    const html = render("cs2-europe", { components: up(3) });
    expect(html).toContain("<details");
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).not.toContain("data-component-row");
  });
});

describe("release row", () => {
  const fresh: ComponentHealth[] = [
    { name: "Stable", health: "maintenance", detail: "7.21 · Sep 24" },
    { name: "Long-term", health: "operational", detail: "7.18.2" },
    { name: "Testing", health: "operational", detail: "7.22beta3" },
  ];

  it("has a tag icon and no status word or glyph", () => {
    const html = render("mikrotik", { category: "updates", components: fresh });
    expect(html).not.toContain("data-health");
    expect(html).not.toContain("Operational");
    expect(html).not.toContain("Maintenance");
    expect(html).toContain("lucide-tag");
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Star mikrotik"');
    expect(html).toContain('aria-label="mikrotik status page"');
  });

  it("says New release when a channel is fresh, and names the newest two versions", () => {
    const html = render("apple-os", { category: "updates", components: fresh });
    expect(header(html)).toContain("New release");
    expect(header(html)).toContain("Stable 7.21 · Sep 24 · Long-term 7.18.2");
    expect(header(html)).not.toContain("Testing");
  });

  it("says nothing of a release while none is new, and puts the newest versions under the name", () => {
    const html = render("mikrotik", {
      category: "updates",
      components: fresh.map((c) => ({ ...c, health: "operational" })),
    });
    expect(html).not.toContain("New release");
    expect(header(html)).toContain("Stable 7.21 · Sep 24 · Long-term 7.18.2");
  });

  it("says No new release when the tracker lists no versions", () => {
    const html = render("mikrotik", { category: "updates", components: up(2) });
    expect(header(html)).toContain("No new release");
  });
});

describe("highlighted service card", () => {
  const renderCard = (highlight: boolean, health: ServiceSnapshot["health"] = "outage") =>
    render("aws", { health, summary: "Increased error rates" }, { highlight });

  it("marks the one article and nothing else: no caption, no wider card", () => {
    const html = renderCard(true);
    expect(html.startsWith("<article")).toBe(true);
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html).toContain('data-highlight="true"');
    expect(html).not.toContain("Most urgent");
    expect(html).not.toContain("col-span");
    expect(renderCard(true, "degraded")).toContain('data-highlight="true"');
  });

  it("carries no mark otherwise", () => {
    expect(renderCard(false)).not.toContain("data-highlight");
  });

  it("is never set on maintenance, a healthy row or one that could not be read", () => {
    expect(renderCard(true, "maintenance")).not.toContain("data-highlight");
    expect(renderCard(true, "operational")).not.toContain("data-highlight");
    expect(renderCard(true, "unknown")).not.toContain("data-highlight");
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
    expect(html).toMatch(/aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*>Show all 9/);
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
    expect(html).toContain("Incident 1");
    expect(html).toContain("Incident 2");
    expect(html).not.toContain("Incident 3");
    expect(html).toContain("data-more-incidents");
    expect(html).toContain("+3 more");
    expect(html).toContain("3 more incidents");
  });

  it("counts the incidents the collector cut as well as the ones the card cut", () => {
    const html = render("chatgpt", {
      health: "degraded",
      summary: "Partial outage",
      incidents: [incident(1), incident(2), incident(3), incident(4), incident(5)],
      incidentCount: 40,
    });
    expect(html).toContain("+38 more");
    expect(html).toContain("38 more incidents");
  });

  it("adds no count for two incidents", () => {
    const html = render("chatgpt", { health: "degraded", incidents: [incident(1), incident(2)] });
    expect(html).not.toContain("data-more-incidents");
  });
});

describe("service card incident labels and links", () => {
  /** The card's closing link: where it goes and what it says. */
  const link = (html: string) => /<a href="([^"]+)"[^>]*><span class="min-w-0[^"]*">([^<]+)</.exec(html)?.slice(1);

  it("links to the worst incident, not the first listed, as Incident details", () => {
    const html = render("chatgpt", {
      health: "outage",
      sourceUrl: "https://status.example.com/",
      incidents: [
        { id: "minor", title: "Minor", health: "degraded", url: "https://status.example.com/minor" },
        { id: "major", title: "Major", health: "outage", url: "https://status.example.com/major" },
      ],
    });
    expect(link(html)).toEqual(["https://status.example.com/major", "Incident details"]);
    // Many cards share one link label, so the name follows for a screen reader.
    expect(html).toContain('<span class="sr-only"> for chatgpt</span>');
  });

  it("does not call the vendor's generic dashboard an incident: it says the host", () => {
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
    expect(link(html)).toEqual(["https://health.aws.amazon.com/health/status", "health.aws.amazon.com"]);
    expect(html).not.toContain("Incident details");
  });

  it("gives the latency to sight and to a screen reader", () => {
    const html = render("aws", { health: "degraded", latencyMs: 312 });
    expect(html).toContain("312 ms");
    expect(html).toContain("answered in 312 ms");
    expect(html).toContain('title="How long the vendor took to answer"');
  });

  it("labels an informational notice a Notice, never a health", () => {
    const html = render("claude", {
      health: "degraded",
      summary: "Partial outage",
      incidents: [{ id: "n", title: "Database upgrade", health: "operational", informational: true }],
    });
    expect(html).toContain(">Notice</span>");
    expect(html).toContain("Database upgrade");
  });

  it("shows upcoming maintenance as Upcoming, apart from the health", () => {
    const html = render("claude", {
      health: "degraded",
      summary: "Partial outage",
      upcomingMaintenance: [{ id: "m", title: "Database upgrade", scheduledFor: "2026-09-28T02:00:00.000Z" }],
    });
    expect(html).toContain("data-upcoming-maintenance");
    expect(html).toContain(">Upcoming</span>");
    expect(html).toContain("Database upgrade");
    expect(html).toContain("Scheduled for ");
    expect(html).toContain(">Degraded</span>");
  });

  it("never says an upcoming maintenance began: once its time has passed it was due, with no duration", () => {
    const html = render("claude", {
      health: "degraded",
      checkedAt: "2026-09-27T11:59:00.000Z",
      upcomingMaintenance: [{ id: "m", title: "Database upgrade", scheduledFor: "2026-09-27T10:00:00.000Z" }],
    });
    expect(html).toContain(">Upcoming</span>");
    expect(html).toContain("Was due ");
    expect(html).not.toContain("since ");
    expect(html).not.toContain("Since ");
    expect(html).not.toContain("Scheduled for ");
    expect(html).not.toMatch(/<time dateTime="PT/);
  });

  it("keeps two upcoming events with the same id as separate rows", () => {
    const html = render("claude", {
      health: "degraded",
      upcomingMaintenance: [
        { id: "same", title: "First window", scheduledFor: "2026-09-28T02:00:00.000Z" },
        { id: "same", title: "Second window", scheduledFor: "2026-09-28T02:00:00.000Z" },
      ],
    });
    expect(html).toContain("First window");
    expect(html).toContain("Second window");
  });

  it("titles every time with the whole moment in UTC, and prints UTC before hydration", () => {
    const html = render("claude", {
      health: "degraded",
      checkedAt: "2026-09-27T11:59:00.000Z",
      summary: "Partial outage",
      incidents: [{ id: "a", title: "Other", health: "degraded", startedAt: "2026-09-27T10:04:00.000Z" }],
    });
    expect(html).toContain('title="27 Sep 2026 10:04 UTC"');
    expect(html).toContain(">10:04\u202fUTC</time>");
  });
});
