import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "./site-footer";

const render = (singleKey: boolean) =>
  renderToStaticMarkup(createElement(SiteFooter, { onOpenSettings: () => {}, singleKey }));

describe("SiteFooter", () => {
  const html = render(true);

  it("is a footer landmark that says what the page is and is not, in the owner's voice", () => {
    expect(html).toMatch(/^<footer /);
    expect(html).toContain("Not affiliated with any of these vendors. I only read their public status pages.");
    expect(html).not.toContain("TanStack");
    expect(html).not.toContain("Cloudflare Workers");
  });

  it("is signed in plain words, not initials", () => {
    expect(html).toMatch(
      /Made by <a [^>]*href="https:\/\/github\.com\/greenblacked"[^>]*>greenblacked<svg[\s\S]*?<\/svg><\/a>\./,
    );
    expect(html).not.toContain("Serhii");
    expect(html).not.toMatch(/s\.z\./i);
    expect(html).not.toContain("font-hand");
  });

  it("links the source and the licence out, and the board's own feeds in", () => {
    expect(html).toContain('href="https://github.com/greenblacked/status-page"');
    expect(html).toContain('href="https://github.com/greenblacked/status-page/blob/main/LICENSE"');
    expect(html).toContain('rel="noopener noreferrer license"');
    expect(html).toMatch(/<a [^>]*href="\/api\/status\.json"[^>]*>JSON<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/feed\.xml"[^>]*>Atom feed<\/a>/);
    expect(html).not.toMatch(/\/api\/badge\//);
    expect(html).not.toContain("Badges");
    expect(html).toMatch(/<button [^>]*type="button"[^>]*>Settings<\/button>/);
  });

  it("no longer explains how the machinery works", () => {
    expect(html).not.toContain("every two minutes");
    expect(html).not.toContain("keeps them for");
    expect(html).not.toContain("free to use, copy, modify");
    expect(html).not.toContain("Slack, Teams");
  });

  it("names the key that opens settings only while the single-key shortcuts are on", () => {
    expect(html).toContain("(press ");
    expect(render(false)).not.toContain("(press ");
  });
});
