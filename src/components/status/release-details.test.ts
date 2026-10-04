import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ServiceSnapshot } from "@/lib/status/types";
import { service } from "../../test/fixtures";
import { ReleaseDetails, ReleaseDetailsDialog } from "./release-details";
import { ServiceCard } from "./service-card";

const noop = () => {};
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

const tracker = (overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot =>
  service("mikrotik", {
    name: "MikroTik RouterOS",
    category: "updates",
    sourceName: "MikroTik changelogs",
    sourceUrl: "https://mikrotik.com/download/changelogs",
    checkedAt: "2026-09-30T12:00:00.000Z",
    components: [
      {
        name: "RouterOS 7 stable",
        health: "maintenance",
        detail: "7.20.2 · Sep 29",
        release: {
          version: "7.20.2",
          releasedAt: "2026-09-29T12:00:00.000Z",
          url: "https://download.mikrotik.com/routeros/7.20.2/CHANGELOG",
          linkLabel: "Release notes",
          notes: ["bridge - fixed VLAN filtering", "ipsec - improved rekeying"],
        },
      },
      {
        name: "RouterOS 7 long-term",
        health: "operational",
        detail: "7.18.4 · Jul 22",
        release: { version: "7.18.4", releasedAt: "2026-07-22T10:00:00.000Z" },
      },
    ],
    ...overrides,
  });

const dialog = (item = tracker()) =>
  renderToStaticMarkup(createElement(ReleaseDetailsDialog, { service: item, onClose: noop }));

describe("ReleaseDetailsDialog", () => {
  const html = dialog();

  it("is a modal dialog named Details and the service, with a close button that says what it closes", () => {
    const id = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(new RegExp(`<h2 id="${id}"[^>]*>Details<span[^>]*> · MikroTik RouterOS</span></h2>`));
    expect(html).toContain('aria-label="Close details for MikroTik RouterOS"');
    // The settings dialog's material, so it follows the background and Reduce glass the same way.
    expect(html).toContain("sheet");
    expect(html).toContain("details-dialog");
  });

  it("lists every component, not only the first two a row's line shows", () => {
    const many = tracker({
      components: Array.from({ length: 5 }, (_, at) => ({
        name: `Channel ${at}`,
        health: "operational" as const,
        release: { version: `7.${at}` },
      })),
    });
    const text = dialog(many);
    expect(text.match(/data-release-entry/g)).toHaveLength(5);
    for (let at = 0; at < 5; at += 1) expect(text).toContain(`>Channel ${at}</h3>`);
  });

  it("gives each entry its version, its day, the New release tag only while fresh, its notes and its link", () => {
    const [stable, longTerm] = html.split("data-release-entry").slice(1);
    expect(stable).toContain(">RouterOS 7 stable</h3>");
    expect(stable).toContain("New release");
    expect(stable).toContain(">7.20.2</span>");
    // Before hydration a moment is a UTC day.
    expect(stable).toContain('<time dateTime="2026-09-29T12:00:00.000Z"');
    expect(stable).toContain(">Sep 29</time>");
    expect(stable).toContain('aria-label="Changes"');
    expect(stable).toContain('<li class="[overflow-wrap:anywhere]">bridge - fixed VLAN filtering</li>');
    expect(stable).toContain('href="https://download.mikrotik.com/routeros/7.20.2/CHANGELOG"');
    expect(stable).toContain('target="_blank"');
    expect(stable).toContain('rel="noreferrer"');
    expect(stable).toContain("Release notes");
    expect(longTerm).not.toContain("New release");
  });

  it("names a release's link as the collector does, and as a page, not as notes, when it does not say", () => {
    const text = dialog(
      tracker({
        components: [
          {
            name: "iOS",
            health: "operational",
            release: {
              version: "27.1",
              url: "https://developer.apple.com/news/releases/?id=1",
              linkLabel: "Apple Developer post",
            },
          },
          { name: "Other", health: "operational", release: { version: "1", url: "https://example.com/r/1" } },
        ],
      }),
    );
    expect(text).toContain("Apple Developer post");
    expect(text).not.toContain("Release notes");
    expect(text).toContain("Release page");
  });

  it("scrolls its list under a header that stays, and is not the scroller itself", () => {
    expect(html).toMatch(/<dialog[^>]*class="details-dialog [^"]*"/);
    expect(html).not.toMatch(/<dialog[^>]*overflow-y-auto/);
    expect(html).toMatch(/<ul aria-label="Releases"[^>]*overflow-y-auto/);
  });

  it("says plainly when the source has no notes text, and links the tracker's page when the release has none", () => {
    const [, longTerm] = html.split("data-release-entry").slice(1);
    expect(longTerm).not.toContain('aria-label="Changes"');
    expect(longTerm).toContain("No notes text from MikroTik changelogs.");
    expect(longTerm).toContain('href="https://mikrotik.com/download/changelogs"');
    expect(longTerm).toContain(">MikroTik changelogs<");
  });

  it("shows a bare day as a UTC day, with the build, and the update when it is another day", () => {
    const windows = dialog(
      tracker({
        name: "Windows 11",
        components: [
          {
            name: "26H1",
            health: "operational",
            release: { version: "26H1", build: "28000.1575", releasedAt: "2026-02-10", updatedAt: "2026-09-22" },
          },
        ],
      }),
    );
    expect(windows).toContain("build 28000.1575");
    expect(windows).toContain('<time dateTime="2026-02-10">Feb 10</time>');
    expect(windows).toContain('updated <time dateTime="2026-09-22">Sep 22</time>');
    // The name is the version here, so it is not printed twice.
    expect(windows.match(/26H1/g)).toHaveLength(2);
  });

  it("prints vendor text as text: markup in a note is escaped", () => {
    const hostile = dialog(
      tracker({
        components: [
          { name: "a", health: "operational", release: { version: "1", notes: ["<img src=x onerror=alert(1)>"] } },
        ],
      }),
    );
    expect(hostile).not.toContain("<img");
    expect(hostile).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("ReleaseDetails", () => {
  it("is a button that opens a dialog, named by the service, and renders no dialog while closed", () => {
    const html = renderToStaticMarkup(createElement(ReleaseDetails, { service: tracker(), variant: "inline" }));
    expect(html).toMatch(/^<button[^>]*type="button"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("data-release-details-trigger");
    expect(html).toContain('Details<span class="sr-only"> for MikroTik RouterOS</span>');
    expect(html).not.toContain("<dialog");
  });

  it("stretches over the row only inline, and is a plain 44px button in a card", () => {
    const inline = renderToStaticMarkup(createElement(ReleaseDetails, { service: tracker(), variant: "inline" }));
    const button = renderToStaticMarkup(createElement(ReleaseDetails, { service: tracker(), variant: "button" }));
    expect(inline).toContain("after:absolute");
    expect(inline).not.toContain("pressable");
    expect(button).toContain("min-h-11");
    expect(button).not.toContain("after:absolute");
  });

  it("renders nothing for a service that is not a tracker, or lists nothing", () => {
    for (const item of [tracker({ category: "cloud" }), tracker({ components: [] })]) {
      expect(renderToStaticMarkup(createElement(ReleaseDetails, { service: item, variant: "inline" }))).toBe("");
    }
  });
});

describe("a card that needs a look", () => {
  const card = (item: ServiceSnapshot) =>
    renderToStaticMarkup(
      createElement(ServiceCard, {
        service: item,
        starred: false,
        onToggleStar: noop,
        now: NOW,
      }),
    );

  it("has the Details button in its footer, and a name that clicks through to it", () => {
    const html = card(tracker({ health: "maintenance" }));
    expect(html).toContain("data-release-details-trigger");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain('Details<span class="sr-only"> for MikroTik RouterOS</span>');
  });

  it("has neither for a service that is not a tracker", () => {
    const html = card(service("aws", { health: "degraded", components: [{ name: "EC2", health: "degraded" }] }));
    expect(html).not.toContain("data-release-details-trigger");
    expect(html).not.toContain("cursor-pointer");
  });
});

describe("a release row", () => {
  const row = (item: ServiceSnapshot) =>
    renderToStaticMarkup(createElement(ServiceCard, { service: item, starred: false, onToggleStar: noop, now: NOW }));

  it("carries the Details button in its header, beside the star and the status page link", () => {
    const html = row(tracker());
    expect(html).toContain('id="service-mikrotik"');
    const header = html.slice(html.indexOf("data-card-header"), html.indexOf("</p>", html.indexOf("data-card-header")));
    expect(header).toContain("data-release-details-trigger");
    expect(header).toContain("RouterOS 7 stable 7.20.2 · Sep 29");
    // The header is what the button covers.
    expect(html).toMatch(/data-card-header="true" class="[^"]*\brelative\b/);
    expect(html).toContain('aria-label="Star MikroTik RouterOS"');
    expect(html).toContain('aria-label="MikroTik RouterOS status page"');
  });

  it("has no Details button on an ordinary service row", () => {
    expect(row(service("aws", { components: [{ name: "EC2", health: "operational" }] }))).not.toContain(
      "data-release-details-trigger",
    );
  });
});

describe("ReleaseDetailsDialog: the release note", () => {
  const noted = tracker({
    components: [
      {
        name: "RouterOS 7 stable",
        health: "maintenance",
        detail: "7.20.2 · Sep 29",
        release: {
          version: "7.20.2",
          releasedAt: "2026-09-29T12:00:00.000Z",
          notes: ["lte - fixed a crash", "bridge - fixed VLAN filtering"],
          note: {
            text: "6 changes: lte, bridge, ipsec +3 more · 1 important",
            detail: "6 changes in 6 areas: lte, bridge, ipsec, ospf, wifi, bgp.",
            important: ["lte - fixed a crash"],
          },
        },
      },
      {
        name: "26H2",
        health: "operational",
        detail: "26300.1000 · Sep 29",
        release: {
          version: "26H2",
          note: {
            text: "Security update",
            detail: "2026-09 B: the monthly security update.",
            reference: { label: "KB5000000", url: "https://support.microsoft.com/help/5000000" },
          },
        },
      },
      {
        name: "25H2",
        health: "operational",
        release: { version: "25H2", note: { text: "Out-of-band fix", reference: { label: "KB5000060" } } },
      },
      { name: "24H2", health: "operational", release: { version: "24H2" } },
    ],
  });
  const html = dialog(noted);
  const entry = (name: string) => {
    const at = html.indexOf(`>${name}</h3>`);
    return html.slice(
      html.lastIndexOf("<li", at),
      html.indexOf("</li><li", at) === -1 ? undefined : html.indexOf("</li><li", at),
    );
  };

  it("shows the important lines first, then the full sentence, then the first changes without a repeat", () => {
    const first = entry("RouterOS 7 stable");
    expect(first).toContain("data-release-note-details");
    expect(first).toContain('aria-label="Marked important"');
    expect(first).toContain("Important</span> · lte - fixed a crash");
    expect(first).toContain("6 changes in 6 areas: lte, bridge, ipsec, ospf, wifi, bgp.");
    expect(first.indexOf("Marked important")).toBeLessThan(first.indexOf("6 changes in 6 areas"));
    expect(first.indexOf("6 changes in 6 areas")).toBeLessThan(first.indexOf('aria-label="Changes"'));
    // "lte - fixed a crash" is listed once, among the important lines.
    expect(first.match(/lte - fixed a crash/g)).toHaveLength(1);
    expect(first).toContain("bridge - fixed VLAN filtering");
  });

  it("links the KB article when the table did, names it in text when it did not, and says nothing is missing", () => {
    const linked = entry("26H2");
    expect(linked).toContain("2026-09 B: the monthly security update.");
    expect(linked).toMatch(/<a href="https:\/\/support\.microsoft\.com\/help\/5000000"[^>]*>KB5000000/);
    expect(linked).not.toContain("No notes text");
    const plain = entry("25H2");
    expect(plain).toContain("Out-of-band fix");
    expect(plain).toContain(">KB5000060</p>");
    expect(plain).not.toContain("support.microsoft.com");
    expect(plain).not.toContain("No notes text");
  });

  it("a release with no note keeps its old text", () => {
    expect(entry("24H2")).toContain("No notes text from MikroTik changelogs.");
    expect(entry("24H2")).not.toContain("data-release-note-details");
  });
});
