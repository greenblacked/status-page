import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES } from "./http";
import { collectAllServices } from "./sources.server";

// Whole-sweep behaviour of collectAllServices(): what one call logs and
// fetches. Payload parsing per vendor lives in collectors.test.ts.

type Route = (url: string) => Response;

function stubFetch(route: Route) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return route(url);
    }),
  );
  return calls;
}

function logged(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

const CLAUDE = "https://status.claude.com/api/v2/summary.json";
const CHATGPT = "https://status.openai.com/api/v2/summary.json";

describe("collectAllServices logging", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs each collector's downloaded bytes, on success and on failure", async () => {
    const summary = JSON.stringify({ status: { indicator: "none", description: "All Systems Operational" } });
    stubFetch((url) => {
      if (url === CLAUDE) return new Response(summary);
      if (url === CHATGPT) return new Response("x".repeat(MAX_BODY_BYTES + 1));
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const services = await collectAllServices();

    expect(services.find((service) => service.id === "claude")?.health).toBe("operational");
    expect(logged(vi.mocked(console.log)).find((line) => line.service === "claude")).toMatchObject({
      event: "collector_completed",
      service: "claude",
      health: "operational",
      bytes: summary.length,
    });

    const chatgpt = services.find((service) => service.id === "chatgpt");
    expect(chatgpt?.failure).toMatchObject({ kind: "parser", message: "Response from status.openai.com is larger than 4 MiB" });
    const failure = logged(vi.mocked(console.warn)).find((line) => line.service === "chatgpt");
    expect(failure).toMatchObject({ event: "collector_failed", kind: "parser" });
    // What it read before giving up: just past the cap.
    expect(Number(failure?.bytes)).toBeGreaterThan(MAX_BODY_BYTES);
  });
});

const EPIC = "https://status.epicgames.com/api/v2/summary.json";

describe("collectAllServices shared fetches", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches Epic's summary once per sweep for both the Epic and the Fortnite card", async () => {
    const summary = JSON.stringify({
      status: { indicator: "minor", description: "Minor Service Outage" },
      components: [
        { id: "1", name: "Fortnite", status: "partial_outage" },
        { id: "2", name: "Epic Games Store", status: "operational" },
      ],
    });
    const calls = stubFetch((url) =>
      url === EPIC ? new Response(summary) : new Response("not found", { status: 404, statusText: "Not Found" }),
    );

    const services = await collectAllServices();

    expect(calls.filter((url) => url === EPIC)).toHaveLength(1);
    expect(services.find((service) => service.id === "epic")?.health).toBe("operational");
    expect(services.find((service) => service.id === "fortnite")?.health).toBe("degraded");
  });

  it("does not carry the shared fetch over to the next sweep", async () => {
    const calls = stubFetch(() => new Response("not found", { status: 404, statusText: "Not Found" }));

    await collectAllServices();
    await collectAllServices();

    expect(calls.filter((url) => url === EPIC)).toHaveLength(2);
  });

  it("fails both cards with the same reason when the shared fetch fails", async () => {
    stubFetch(() => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }));

    const services = await collectAllServices();

    const epic = services.find((service) => service.id === "epic");
    const fortnite = services.find((service) => service.id === "fortnite");
    expect(epic?.failure).toMatchObject({ kind: "http", status: 503 });
    expect(fortnite?.failure).toEqual(epic?.failure);
  });
});

describe("collectAllServices vendor links", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function incidentUrls(services: Awaited<ReturnType<typeof collectAllServices>>, id: string) {
    return services.find((service) => service.id === id)?.incidents.map((incident) => incident.url);
  }

  it("keeps vendor links on the vendor's hosts and replaces anything else with the catalog page", async () => {
    const statuspage = (shortlinks: string[]) =>
      JSON.stringify({
        status: { indicator: "minor", description: "Minor" },
        incidents: shortlinks.map((shortlink, index) => ({
          id: `i${index}`,
          name: `Incident ${index}`,
          status: "investigating",
          impact: "minor",
          shortlink,
        })),
      });
    const recent = new Date(Date.now() - 60_000).toUTCString();
    const grokFeed = [
      "<rss><channel>",
      `<item><title>Good</title><description>Degraded API</description><pubDate>${recent}</pubDate><link>https://status.x.ai/incidents/1</link></item>`,
      `<item><title>Offsite</title><description>Degraded API</description><pubDate>${recent}</pubDate><link>https://evil.test/phish</link></item>`,
      `<item><title>Script</title><description>Degraded API</description><pubDate>${recent}</pubDate><link>javascript:alert(1)</link></item>`,
      "</channel></rss>",
    ].join("");
    const google = JSON.stringify([
      { id: "a", begin: "2026-09-20T00:00:00Z", external_desc: "Errors", status_impact: "SERVICE_DISRUPTION", uri: "incidents/abc" },
      { id: "b", begin: "2026-09-20T00:00:00Z", external_desc: "Errors", status_impact: "SERVICE_DISRUPTION", uri: "https://evil.test/x" },
      { id: "c", begin: "2026-09-20T00:00:00Z", external_desc: "Errors", status_impact: "SERVICE_DISRUPTION", uri: "javascript:alert(1)" },
    ]);
    stubFetch((url) => {
      if (url === CLAUDE) {
        return new Response(statuspage(["https://stspg.io/abc", "javascript:alert(1)", "https://evil.test/x", "https://status.claude.com/incidents/9"]));
      }
      if (url === "https://status.x.ai/feed.xml") return new Response(grokFeed);
      if (url === "https://status.cloud.google.com/incidents.json") return new Response(google);
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const services = await collectAllServices();

    expect(incidentUrls(services, "claude")).toEqual([
      "https://stspg.io/abc",
      "https://status.claude.com/",
      "https://status.claude.com/",
      "https://status.claude.com/incidents/9",
    ]);
    expect(incidentUrls(services, "grok")).toEqual([
      "https://status.x.ai/incidents/1",
      "https://status.x.ai/",
      "https://status.x.ai/",
    ]);
    expect(incidentUrls(services, "gcp")).toEqual([
      "https://status.cloud.google.com/incidents/abc",
      "https://status.cloud.google.com/",
      "https://status.cloud.google.com/",
    ]);
  });
});
