import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cannedPayload } from "../../../e2e/support/canned-vendors.mjs";
import { CATALOG } from "./catalog";
import { MAX_BODY_BYTES } from "./http";
import { createSourcePolicy } from "./source-policy";
import { COLLECTORS, collectAllServices } from "./sources.server";

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

  it("logs a failed collector's bytes, and one sweep summary instead of a line per success", async () => {
    const summary = JSON.stringify({ status: { indicator: "none", description: "All Systems Operational" } });
    stubFetch((url) => {
      if (url === CLAUDE) return new Response(summary);
      if (url === CHATGPT) return new Response("x".repeat(MAX_BODY_BYTES + 1));
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const services = await collectAllServices();

    expect(services.find((service) => service.id === "claude")?.health).toBe("operational");
    const lines = logged(vi.mocked(console.log));
    expect(lines.filter((line) => line.event === "collector_completed")).toEqual([]);
    const sweeps = lines.filter((line) => line.event === "sweep_completed");
    expect(sweeps).toHaveLength(1);
    const ok = services.filter((service) => !service.failure).length;
    expect(sweeps[0]).toMatchObject({
      services: services.length,
      ok,
      unknown: services.filter((service) => service.health === "unknown").length,
      carried: 0,
      skipped: 0,
      cachedReads: 0,
    });
    expect(ok).toBeGreaterThan(0);
    // Every collector's bytes: Claude's summary and ChatGPT's oversized body among them.
    expect(Number(sweeps[0].bytes)).toBeGreaterThan(MAX_BODY_BYTES + summary.length);
    expect(Number(sweeps[0].durationMs)).toBeGreaterThanOrEqual(0);

    const chatgpt = services.find((service) => service.id === "chatgpt");
    expect(chatgpt?.failure).toMatchObject({
      kind: "parser",
      message: "Response from status.openai.com is larger than 4 MiB",
    });
    const failure = logged(vi.mocked(console.warn)).find((line) => line.service === "chatgpt");
    expect(failure).toMatchObject({ event: "collector_failed", kind: "parser" });
    // What it read before giving up: just past the cap.
    expect(Number(failure?.bytes)).toBeGreaterThan(MAX_BODY_BYTES);
  });
});

describe("collectAllServices slow collectors", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs collector_slow for a card that took three seconds or more, and not for a fast one", async () => {
    stubFetch(() => new Response("not found", { status: 404, statusText: "Not Found" }));
    const collectors = COLLECTORS as Array<(typeof COLLECTORS)[number]>;
    const replaced = (["claude", "chatgpt"] as const).map((id) => {
      const index = collectors.findIndex(([entry]) => entry === id);
      return [index, collectors[index]] as const;
    });
    const card = (id: "claude" | "chatgpt", latencyMs: number) => {
      const entry = CATALOG.find((service) => service.id === id)!;
      return {
        ...entry,
        checkedAt: new Date().toISOString(),
        latencyMs,
        health: "operational" as const,
        summary: "All good.",
        components: [],
        incidents: [],
      };
    };
    collectors[replaced[0][0]] = ["claude", async () => card("claude", 3000)];
    collectors[replaced[1][0]] = ["chatgpt", async () => card("chatgpt", 2999)];
    try {
      await collectAllServices();
    } finally {
      for (const [index, original] of replaced) collectors[index] = original;
    }

    const slow = logged(vi.mocked(console.log)).filter((line) => line.event === "collector_slow");
    expect(slow).toEqual([
      { event: "collector_slow", service: "claude", health: "operational", latencyMs: 3000, bytes: 0 },
    ]);
  });
});

describe("collectAllServices isolation", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns one card per catalog service, in catalog order", async () => {
    stubFetch(() => new Response("not found", { status: 404, statusText: "Not Found" }));

    const services = await collectAllServices();

    expect(services.map((service) => service.id)).toEqual(CATALOG.map((service) => service.id));
    expect(COLLECTORS.map(([id]) => id)).toEqual(CATALOG.map((service) => service.id));
  });

  it("contains a collector that throws synchronously to its own card", async () => {
    stubFetch(() => new Response("not found", { status: 404, statusText: "Not Found" }));
    const collectors = COLLECTORS as Array<(typeof COLLECTORS)[number]>;
    const index = collectors.findIndex(([id]) => id === "spotify");
    const original = collectors[index];
    collectors[index] = [
      "spotify",
      () => {
        throw new TypeError("collector bug");
      },
    ];
    let services: Awaited<ReturnType<typeof collectAllServices>>;
    try {
      services = await collectAllServices();
    } finally {
      collectors[index] = original;
    }

    expect(services.map((service) => service.id)).toEqual(CATALOG.map((service) => service.id));
    const spotify = services.find((service) => service.id === "spotify");
    expect(spotify).toMatchObject({ id: "spotify", health: "unknown", failure: { kind: "parser" } });
    // The other 21 cards are each their own vendor's answer (here a 404), not the bug.
    const others = services.filter((service) => service.id !== "spotify");
    expect(others).toHaveLength(21);
    for (const service of others) expect(service.failure?.message).not.toContain("collector bug");
    expect(logged(vi.mocked(console.warn)).find((line) => line.service === "spotify")).toMatchObject({
      event: "collector_failed",
      service: "spotify",
    });
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
        { id: "g1", name: "Fortnite", status: "operational", group: true },
        { id: "1", name: "Matchmaking", status: "partial_outage", group_id: "g1" },
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

describe("collectAllServices vendor timestamps", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps an active AWS event whose date is not a number, without a start time", async () => {
    const recent = Math.floor(Date.now() / 1000) - 600;
    const events = JSON.stringify([
      {
        arn: "arn:aws:health:eu-west-1::event/EC2/1",
        date: "n/a",
        region_name: "eu-west-1",
        status: "1",
        service_name: "Amazon EC2",
        summary: "Increased API error rates",
        event_log: [{ summary: "Investigating", message: "We are investigating", status: 1, timestamp: recent }],
      },
    ]);
    // AWS serves this feed as UTF-16 with a byte-order mark.
    const utf16 = new Uint8Array(Buffer.from(`﻿${events}`, "utf16le"));
    stubFetch((url) =>
      url === "https://health.aws.amazon.com/public/currentevents"
        ? new Response(utf16)
        : new Response("not found", { status: 404, statusText: "Not Found" }),
    );

    const aws = (await collectAllServices()).find((service) => service.id === "aws");

    expect(aws?.failure).toBeUndefined();
    expect(aws?.health).toBe("degraded");
    expect(aws?.incidents).toHaveLength(1);
    expect(aws?.incidents[0]?.startedAt).toBeUndefined();
    expect(aws?.incidents[0]?.updatedAt).toBe(new Date(recent * 1000).toISOString());
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
      {
        id: "a",
        begin: "2026-09-20T00:00:00Z",
        external_desc: "Errors",
        status_impact: "SERVICE_DISRUPTION",
        uri: "incidents/abc",
      },
      {
        id: "b",
        begin: "2026-09-20T00:00:00Z",
        external_desc: "Errors",
        status_impact: "SERVICE_DISRUPTION",
        uri: "https://evil.test/x",
      },
      {
        id: "c",
        begin: "2026-09-20T00:00:00Z",
        external_desc: "Errors",
        status_impact: "SERVICE_DISRUPTION",
        uri: "javascript:alert(1)",
      },
    ]);
    stubFetch((url) => {
      if (url === CLAUDE) {
        return new Response(
          statuspage([
            "https://stspg.io/abc",
            "javascript:alert(1)",
            "https://evil.test/x",
            "https://status.claude.com/incidents/9",
          ]),
        );
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

// The four side reads, which wait behind every read that decides a card.
const LOW_PRIORITY = new Set([
  "https://status.cloud.google.com/products.json",
  "https://status.play.google.com/products.json",
  "https://status.x.ai/v2/components.json",
  "https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0",
]);

/** A vendor's canned answer (e2e/support/canned-vendors.mjs) with its dates moved to now, or a 404. */
function canned(url: string): Response {
  const payload = cannedPayload(new URL(url), Date.now());
  if (!payload) return new Response("not found", { status: 404, statusText: "Not Found" });
  const body = payload.utf16 ? new Uint8Array(Buffer.from(`\uFEFF${payload.body}`, "utf16le")) : payload.body;
  return new Response(body, { headers: { "content-type": payload.type } });
}

describe("collectAllServices connections", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-10-22T12:00:00.000Z") });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * fetch as a Worker runs it: six connections at most, the rest queued inside fetch() with the caller's timer
   * already running, and every vendor answering `answerMs` after its connection opens. Records the order in
   * which connections open.
   */
  function workerFetch(answerMs: number) {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const opened: string[] = [];
    let open = 0;
    let mostOpen = 0;
    const queue: Array<() => void> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Promise<Response>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let started = false;
        const start = () => {
          started = true;
          open += 1;
          mostOpen = Math.max(mostOpen, open);
          opened.push(url);
          timer = setTimeout(() => {
            finish();
            resolve(canned(url));
          }, answerMs);
        };
        const finish = () => {
          open -= 1;
          queue.shift()?.();
        };
        init?.signal?.addEventListener("abort", () => {
          if (started) {
            clearTimeout(timer);
            finish();
          } else {
            queue.splice(queue.indexOf(start), 1);
          }
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        if (open < 6) start();
        else queue.push(start);
      });
    });
    return { opened, mostOpen: () => mostOpen };
  }

  async function sweep() {
    let services: Awaited<ReturnType<typeof collectAllServices>> | undefined;
    const run = collectAllServices().then((result) => {
      services = result;
    });
    while (!services) await vi.advanceTimersByTimeAsync(250);
    await run;
    return services;
  }

  it("times no request out while it waits for a connection, and opens the side reads last", async () => {
    // Two seconds a vendor, six at a time: the last of the sweep's 31 requests opens ten seconds in. Queued
    // inside fetch() with their timers running, as they were without the gate, the late ones time out at nine.
    const worker = workerFetch(2_000);

    const services = await sweep();

    expect(worker.mostOpen()).toBe(6);
    expect(services.filter((service) => service.failure?.kind === "timeout")).toEqual([]);
    expect(worker.opened).toHaveLength(31);
    expect(new Set(worker.opened.slice(-LOW_PRIORITY.size))).toEqual(LOW_PRIORITY);
    // The side reads answered too, so the cards that use them have their lists.
    const gcp = services.find((service) => service.id === "gcp");
    expect(gcp?.failure).toBeUndefined();
  });

  it("keeps MikroTik's breaker shut while its channel reads never get a connection", async () => {
    // Six connections and every vendor hangs: the reads late in the catalog wait out the sweep's deadline
    // without being asked. In the fourth sweep MikroTik answers and must be asked, not held back by a
    // breaker that counted three sweeps in which it was never reached.
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const mikrotikAnswers = { on: false };
    const asked: string[] = [];
    let open = 0;
    const queue: Array<() => void> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Promise<Response>((resolve, reject) => {
        let started = false;
        const start = () => {
          started = true;
          open += 1;
          asked.push(url);
          if (mikrotikAnswers.on && url.startsWith("https://upgrade.mikrotik.com/")) {
            open -= 1;
            queue.shift()?.();
            resolve(canned(url));
          }
        };
        init?.signal?.addEventListener("abort", () => {
          if (started) {
            open -= 1;
            queue.shift()?.();
          } else {
            queue.splice(queue.indexOf(start), 1);
          }
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        if (open < 6) start();
        else queue.push(start);
      });
    });
    const policy = createSourcePolicy();
    const run = async () => {
      let services: Awaited<ReturnType<typeof collectAllServices>> | undefined;
      const pending = collectAllServices({ policy }).then((result) => {
        services = result;
      });
      while (!services) await vi.advanceTimersByTimeAsync(250);
      await pending;
      return services;
    };
    const mikrotikAsked = () => asked.filter((url) => url.startsWith("https://upgrade.mikrotik.com/")).length;

    for (let sweep = 0; sweep < 3; sweep += 1) {
      const services = await run();
      // Its reads waited for a connection the whole sweep: a timeout of this sweep, not a vendor failure.
      expect(services.find((service) => service.id === "mikrotik")?.failure?.kind).toBe("timeout");
    }
    expect(mikrotikAsked()).toBe(0);

    mikrotikAnswers.on = true;
    const services = await run();
    expect(mikrotikAsked()).toBeGreaterThan(0);
    expect(services.find((service) => service.id === "mikrotik")?.failure).toBeUndefined();
  });
});

describe("collectAllServices under a source policy", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leaves a refusing source alone for as long as its Retry-After asks, beyond the breaker's own backoff", async () => {
    const now = { at: Date.parse("2026-10-22T12:00:00.000Z") };
    const policy = createSourcePolicy({ now: () => now.at, random: () => 0.5 });
    const calls = stubFetch((url) =>
      url === CLAUDE
        ? new Response("slow down", { status: 429, headers: { "retry-after": "300" } })
        : new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    // Three refusals in a row open the breaker: for the vendor's five minutes rather than its own one.
    for (let sweep = 0; sweep < 3; sweep += 1) {
      await collectAllServices({ policy });
      now.at += 1_000;
    }
    expect(calls.filter((url) => url === CLAUDE)).toHaveLength(3);

    now.at += 4 * 60_000;
    await collectAllServices({ policy });
    expect(calls.filter((url) => url === CLAUDE)).toHaveLength(3);

    now.at += 2 * 60_000;
    await collectAllServices({ policy });
    expect(calls.filter((url) => url === CLAUDE)).toHaveLength(4);
  });
});
