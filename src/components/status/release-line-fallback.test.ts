import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentHealth, ReleaseFeed } from "@/lib/status/types";
import { service } from "../../test/fixtures";
import { ServiceCard } from "./service-card";

// A browser without ::details-content (Safari before 18.4, Chrome before 131, Firefox before 143).
vi.mock("./details-content", () => ({ useDetailsContent: () => false }));

const feed: ReleaseFeed = {
  sourceName: "GitLab releases",
  sourceUrl: "https://about.gitlab.com/releases/",
  entries: [{ title: "GitLab 18.4", release: { version: "18.4", releasedAt: "2026-09-18T00:00:00.000Z" } }],
};
const components: ComponentHealth[] = [{ name: "Git operations", health: "operational" }];

function render(overrides: Parameters<typeof service>[1]): string {
  return renderToStaticMarkup(
    createElement(ServiceCard, {
      service: service("gitlab", overrides),
      index: 0,
      starred: false,
      onToggleStar: () => {},
      now: Date.parse("2026-10-02T12:00:00.000Z"),
      emphasized: false,
    }),
  );
}

describe("the release line where ::details-content is unknown", () => {
  it("follows the <details>, so a shut row still shows it, and the row never takes the ::details-content path", () => {
    const html = render({ components, releaseFeed: feed });
    expect(html.match(/data-release-line/g)).toHaveLength(1);
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("data-release-line"));
    expect(html).not.toContain("row-details-feed");
    expect(html).not.toContain("[details:not([open])");
    // The summary is the whole row again, as before the line existed, and the chevron is at its middle.
    const open = html.slice(html.indexOf("<summary"), html.indexOf(">", html.indexOf("<summary")));
    expect(open).toContain("min-h-(--row-h)");
    expect(html).toContain("after:top-[calc(50%-0.25rem)]");
    expect(html).not.toContain("after:top-1/2");
  });

  it("leaves a row with no list as it is: the line is in the header", () => {
    const html = render({ releaseFeed: feed });
    expect(html).not.toContain("<details");
    expect(html.indexOf("data-card-header")).toBeLessThan(html.indexOf("data-release-line"));
  });
});
