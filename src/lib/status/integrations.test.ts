import { describe, expect, it } from "vitest";
import { board, service } from "../../test/fixtures.ts";
import { atomFeed, publicStatus, shieldsBadge } from "./integrations";
import type { ServiceSnapshot } from "./types";

// Badges and feed titles read the display name, so Google Cloud carries its
// real one; every other card keeps the fixture's id-as-name default.
const gcp = (overrides: Partial<ServiceSnapshot>) => service("gcp", { name: "Google Cloud", ...overrides });

describe("publicStatus", () => {
  it("publishes health, headline and incidents, but not collector internals", () => {
    const status = publicStatus(
      board([
        gcp({
          health: "degraded",
          summary: "Elevated errors",
          incidents: [{ id: "1", title: "Elevated errors", health: "degraded", url: "https://x/1" }],
          // Collector internals that must stay off the public API.
          components: [{ name: "internal", health: "degraded" }],
          meta: { secret: "collector detail" },
        }),
        service("aws", { health: "operational" }),
      ]),
    );
    expect(status.overall).toBe("degraded");
    expect(status.headline).toBe("Degraded: Google Cloud");
    expect(status.services[0]).toEqual({
      id: "gcp",
      name: "Google Cloud",
      category: "cloud",
      health: "degraded",
      summary: "Elevated errors",
      source: "https://status.example.com/gcp",
      incidents: [{ title: "Elevated errors", health: "degraded", url: "https://x/1", startedAt: undefined }],
    });
    expect(JSON.stringify(status)).not.toMatch(/latencyMs|components|collector detail/);
  });
});

describe("overall health across the public endpoints", () => {
  const mixed = board([service("aws", { health: "unknown" }), gcp({ health: "degraded" })]);

  it("reports the degradation, not the unreadable source, as overall and as the headline", () => {
    expect(publicStatus(mixed).overall).toBe("degraded");
    expect(publicStatus(mixed).headline).toBe("Degraded: Google Cloud");
  });

  it("colours the board badge by the same overall health", () => {
    expect(shieldsBadge(mixed, "board")).toMatchObject({ message: "degraded: google cloud", color: "yellow" });
  });
});

describe("shieldsBadge", () => {
  const snapshot = board([gcp({ health: "outage" }), service("aws", { health: "operational" })]);

  it("describes one service in Shields endpoint format", () => {
    expect(shieldsBadge(snapshot, "aws")).toEqual({
      schemaVersion: 1,
      label: "aws",
      message: "operational",
      color: "brightgreen",
    });
    expect(shieldsBadge(snapshot, "gcp")).toMatchObject({ message: "outage", color: "red" });
  });

  it("summarises the whole board under the id 'board'", () => {
    expect(shieldsBadge(snapshot, "board")).toMatchObject({
      label: "status",
      message: "outage: google cloud",
      color: "red",
    });
    expect(shieldsBadge(board([service("aws", { health: "operational" })]), "board")).toMatchObject({
      message: "all operational",
      color: "brightgreen",
    });
  });

  it("returns a well-formed error badge for an unknown id", () => {
    expect(shieldsBadge(snapshot, "nope")).toMatchObject({ isError: true, message: "unknown service" });
  });
});

describe("atomFeed", () => {
  it("has one entry per service that needs attention, with escaped text and absolute links", () => {
    const xml = atomFeed(
      board([
        gcp({
          health: "degraded",
          summary: 'Errors & "timeouts" <eu>',
          incidents: [
            { id: "1", title: "t", health: "degraded", url: "https://x/1?a=1&b=2", updatedAt: "2026-09-24T23:00:00Z" },
          ],
        }),
        service("aws", { health: "operational" }),
      ]),
      "https://status.example.org/",
    );
    expect(xml).toContain('<link rel="self" href="https://status.example.org/feed.xml"/>');
    expect(xml.match(/<entry>/g)).toHaveLength(1);
    expect(xml).toContain("<title>Google Cloud: Degraded</title>");
    expect(xml).toContain("<summary>Errors &amp; &quot;timeouts&quot; &lt;eu&gt;</summary>");
    expect(xml).toContain('href="https://x/1?a=1&amp;b=2"');
    expect(xml).toContain("<updated>2026-09-24T23:00:00.000Z</updated>");
  });

  const ids = (xml: string) => [...xml.matchAll(/<entry>\s*<id>([^<]+)<\/id>/g)].map((match) => match[1]);

  it("keeps an entry's id when its message changes, and changes it for a different incident", () => {
    const feed = (summary: string, incidentId: string) =>
      atomFeed(
        board([gcp({ health: "degraded", summary, incidents: [{ id: incidentId, title: "t", health: "degraded" }] })]),
        "https://s",
      );
    expect(ids(feed("Investigating", "inc-1"))).toEqual(["urn:status-bar:gcp:degraded:inc-1"]);
    // A reworded summary is the same incident: same id, so no repost.
    expect(ids(feed("Mitigated", "inc-1"))).toEqual(["urn:status-bar:gcp:degraded:inc-1"]);
    // A new incident is a new entry.
    expect(ids(feed("Investigating", "inc-2"))).toEqual(["urn:status-bar:gcp:degraded:inc-2"]);
  });

  it("gives the same incident a new id when the service escalates, so a feed reader posts it again", () => {
    const feed = (health: "degraded" | "outage") =>
      atomFeed(board([gcp({ health, incidents: [{ id: "inc-1", title: "t", health }] })]), "https://s");
    const before = ids(feed("degraded"));
    const after = ids(feed("outage"));
    expect(before).toEqual(["urn:status-bar:gcp:degraded:inc-1"]);
    expect(after).toEqual(["urn:status-bar:gcp:outage:inc-1"]);
    expect(after).not.toEqual(before);
  });

  it("keys the entry on the worst incident, whatever order the incidents arrive in", () => {
    const xml = atomFeed(
      board([
        gcp({
          health: "outage",
          incidents: [
            { id: "note", title: "FYI", health: "operational", informational: true },
            { id: "minor", title: "Minor", health: "degraded" },
            { id: "major", title: "Major", health: "outage" },
          ],
        }),
      ]),
      "https://s",
    );
    expect(ids(xml)).toEqual(["urn:status-bar:gcp:outage:major"]);
  });

  it("keys an entry with no incident on its health, and escapes an id with special characters", () => {
    expect(ids(atomFeed(board([gcp({ health: "maintenance" })]), "https://s"))).toEqual([
      "urn:status-bar:gcp:maintenance",
    ]);
    const arn = "arn:aws:health:us-east-1::event/EC2/X 1";
    expect(
      ids(
        atomFeed(
          board([gcp({ health: "degraded", incidents: [{ id: arn, title: "t", health: "degraded" }] })]),
          "https://s",
        ),
      ),
    ).toEqual(["urn:status-bar:gcp:degraded:arn%3Aaws%3Ahealth%3Aus-east-1%3A%3Aevent%2FEC2%2FX%201"]);
  });

  it("dates an entry by the latest real vendor time across its incidents, not the sweep time", () => {
    const xml = atomFeed(
      board([
        gcp({
          health: "degraded",
          incidents: [
            { id: "a", title: "a", health: "degraded", startedAt: "2026-09-24T08:00:00Z" },
            {
              id: "b",
              title: "b",
              health: "degraded",
              startedAt: "2026-09-24T06:00:00Z",
              updatedAt: "2026-09-24T09:30:00Z",
            },
          ],
        }),
        service("aws", {
          health: "outage",
          name: "AWS",
          incidents: [{ id: "c", title: "c", health: "outage", startedAt: "2026-09-23T01:00:00Z" }],
        }),
      ]),
      "https://s",
    );
    expect(xml.match(/<updated>([^<]+)<\/updated>/g)).toEqual([
      // the feed: the latest entry time
      "<updated>2026-09-24T09:30:00.000Z</updated>",
      "<updated>2026-09-24T09:30:00.000Z</updated>",
      "<updated>2026-09-23T01:00:00.000Z</updated>",
    ]);
  });

  it("titles the feed with the app name", () => {
    const xml = atomFeed(board([gcp({ health: "degraded" })]), "https://s");
    expect(xml).toContain("  <title>Status Page</title>");
    expect(xml).toContain("<author><name>Status Page</name></author>");
  });

  it("leaves unreadable services out: one failed sweep cannot be told from a blackout without history", () => {
    const xml = atomFeed(
      board([
        gcp({ health: "unknown", summary: "Status could not be confirmed from the official source." }),
        service("aws", { health: "degraded", name: "AWS" }),
      ]),
      "https://s",
    );
    expect(ids(xml)).toEqual(["urn:status-bar:aws:degraded"]);
    expect(xml).not.toContain("Google Cloud");
  });

  it("links an entry to the worst incident page, and to the source when that is only a dashboard", () => {
    const linked = atomFeed(
      board([
        gcp({
          health: "outage",
          incidents: [
            { id: "minor", title: "Minor", health: "degraded", url: "https://x/minor" },
            { id: "major", title: "Major", health: "outage", url: "https://x/major" },
          ],
        }),
      ]),
      "https://s",
    );
    expect(linked).toContain('<link rel="alternate" href="https://x/major"/>');
    const dashboard = atomFeed(
      board([
        gcp({
          health: "outage",
          sourceUrl: "https://health.example.com/status/",
          incidents: [{ id: "a", title: "A", health: "outage", url: "https://health.example.com/status#x" }],
        }),
      ]),
      "https://s",
    );
    expect(dashboard).toContain('<link rel="alternate" href="https://health.example.com/status/"/>');
    expect(dashboard).not.toContain("status#x");
  });

  it("falls back to the board time when a vendor timestamp does not parse", () => {
    const xml = atomFeed(
      board([
        gcp({ health: "outage", incidents: [{ id: "1", title: "t", health: "outage", updatedAt: "yesterday-ish" }] }),
      ]),
      "https://s",
    );
    expect(xml).toContain("<updated>2026-09-25T00:00:00.000Z</updated>");
  });

  it("dates an empty feed by the board time", () => {
    const xml = atomFeed(board([service("aws", { health: "operational" })]), "https://s");
    expect(xml).toContain("<updated>2026-09-25T00:00:00.000Z</updated>");
  });

  it("is a valid empty feed when everything is operational", () => {
    const xml = atomFeed(board([service("aws", { health: "operational" })]), "https://s");
    expect(xml).not.toContain("<entry>");
    expect(xml.trim().endsWith("</feed>")).toBe(true);
  });
});
