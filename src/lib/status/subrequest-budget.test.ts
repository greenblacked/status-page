import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cannedPayload } from "../../../e2e/support/canned-vendors.mjs";
import type { CloudflareRequestContext } from "./cloudflare-context";

// What one board costs a Worker invocation in subrequests: every vendor fetch
// (redirect hops and retries included) and every Cache API call. The Free plan
// allows a Workers request 50, so a cold board must stay well under that with
// its release feeds and MikroTik notes, and a warm one, whose slow sources are
// read on their own cadence, far under it. The numbers measured here are the
// ones SECURITY.md gives.

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const COLD_BUDGET = 46;
const WARM_BUDGET = 25;

/** Counts every subrequest: the vendor fetches by URL, and the Cache API calls. */
function workerSubrequests(answer: (url: string) => Response) {
  vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    return answer(url);
  });
  const stored = new Map<string, Response>();
  let cacheCalls = 0;
  vi.stubGlobal("caches", {
    default: {
      match: async (request: Request) => {
        cacheCalls += 1;
        return stored.get(request.url)?.clone();
      },
      put: async (request: Request, response: Response) => {
        cacheCalls += 1;
        stored.set(request.url, response.clone());
      },
    },
  });
  return {
    fetched,
    cacheCalls: () => cacheCalls,
    /** Forgets what was counted so far. */
    restart() {
      fetched.length = 0;
      cacheCalls = 0;
    },
  };
}

/** Every vendor's canned answer (e2e/support/canned-vendors.mjs), dated now; a 404 for a vendor with none. */
function canned(url: string): Response {
  const payload = cannedPayload(new URL(url), Date.now());
  if (!payload) return new Response("not found", { status: 404, statusText: "Not Found" });
  const body = payload.utf16 ? new Uint8Array(Buffer.from(`﻿${payload.body}`, "utf16le")) : payload.body;
  return new Response(body, { headers: { "content-type": payload.type } });
}

/** One Worker request for the board, with everything it handed to waitUntil (and they to it) settled. */
async function boardRequest(getStatusBoard: () => Promise<unknown>) {
  // Imported after vi.resetModules(), so it is the same module the board cache reads its context from.
  const { runWithCloudflareContext } = await import("./cloudflare-context");
  const waiting: Promise<unknown>[] = [];
  const context: CloudflareRequestContext = {
    env: { CF_VERSION_METADATA: { id: "0f6b5b4e-2d0c-4d38-9a6b-3c4f1e2a7b90" } },
    waitUntil: (promise) => waiting.push(promise),
    origin: "https://status.example.com",
  };
  await runWithCloudflareContext(context, getStatusBoard);
  while (waiting.length > 0) await waiting.shift();
}

describe("the subrequests of a board on a Worker", () => {
  beforeEach(() => {
    // A fresh board cache, source policy and validator cache for each test, as in a new isolate.
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(`keeps a cold board, its release feeds and its MikroTik notes at or under ${COLD_BUDGET}`, async () => {
    const counted = workerSubrequests(canned);
    const { getStatusBoard } = await import("./board-cache.server");
    const { RELEASE_SOURCES } = await import("./release-feeds.server");

    await boardRequest(getStatusBoard);

    const feeds = new Set(RELEASE_SOURCES.map((source) => source.url));
    const notes = counted.fetched.filter((url) => url.endsWith("/CHANGELOG"));
    const sweep = counted.fetched.filter((url) => !feeds.has(url) && !notes.includes(url));
    // Measured 2026-10-22: 31 sweep requests, the 6 feeds, 5 changelogs, and 3 Cache API calls (45).
    expect(sweep).toHaveLength(31);
    expect(counted.fetched.filter((url) => feeds.has(url))).toHaveLength(RELEASE_SOURCES.length);
    expect(notes.length).toBeGreaterThan(0);
    expect(counted.cacheCalls()).toBeLessThanOrEqual(3);
    expect(counted.fetched.length + counted.cacheCalls()).toBeLessThanOrEqual(COLD_BUDGET);
  });

  it(`keeps the next board, a minute later under the shared policy, at or under ${WARM_BUDGET}`, async () => {
    const counted = workerSubrequests(canned);
    const { getStatusBoard } = await import("./board-cache.server");
    await boardRequest(getStatusBoard);
    counted.restart();

    // Past the cache's lifetime: served at once, and refreshed behind it in the same invocation.
    vi.setSystemTime(NOW + 60_000);
    await boardRequest(getStatusBoard);

    // Measured 2026-10-22: 20 sweep requests (the slow sources, the catalogues and the server list are not
    // due, nor are the feeds or the notes) and 2 Cache API calls.
    expect(counted.fetched.length).toBeGreaterThan(0);
    expect(counted.fetched.some((url) => url.startsWith("https://upgrade.mikrotik.com/"))).toBe(false);
    expect(counted.fetched.some((url) => url.endsWith("/products.json"))).toBe(false);
    expect(counted.fetched.length + counted.cacheCalls()).toBeLessThanOrEqual(WARM_BUDGET);
  });

  it("never lets a sweep in which every vendor fails grow past SWEEP_MAX_REQUESTS with its retries", async () => {
    const { collectAllServices, SWEEP_MAX_REQUESTS } = await import("./sources.server");
    const { createSourcePolicy } = await import("./source-policy");
    // Six connections on a Worker, sixteen on Node: either way the first answers land while requests still wait.
    for (const userAgent of ["Cloudflare-Workers", "Node.js"]) {
      const counted = workerSubrequests(
        () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }),
      );
      vi.stubGlobal("navigator", { userAgent });

      const services = await collectAllServices({ policy: createSourcePolicy() });

      expect(
        services.every((service) => service.failure),
        userAgent,
      ).toBe(true);
      expect(counted.fetched.length, userAgent).toBeLessThanOrEqual(SWEEP_MAX_REQUESTS);
      // The budget is a limit, not a ban: the one retry that fits was made.
      expect(counted.fetched.length, userAgent).toBeGreaterThan(new Set(counted.fetched).size);
    }
  });
});
