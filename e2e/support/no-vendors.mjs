// Preloaded into the preview server the browser tests start (playwright.config.ts passes it through
// NODE_OPTIONS, so only that one process tree loads it). It replaces the server's global `fetch`, so the
// page's first render never depends on what a vendor says today or on whether the runner can reach one:
//   - a request to this machine goes through;
//   - a request to a vendor URL that has a canned payload in src/lib/status/__fixtures__ (the files the
//     collector unit tests read, the same table as src/test/stub-fetch.ts routes) is answered from that file,
//     with its dates moved to the present so the collectors' windows (14 days and the like) see it as current
//     (the routes, the dates moved and the anchor of each fixture group are in canned-vendors.mjs);
//   - any other host or URL is refused at once, as a network that is down would refuse it.
// The first render, and the hydration that follows it, is the same board in a sandbox, on a laptop and in CI,
// with outages, degraded and maintenance cards, incidents with times, component lists and release lines on it
// (the services without a canned payload read Unknown). Every request is written to E2E_VENDOR_LOG, one JSON
// line each, for the report of e2e/support/global-setup.ts. No request leaves the machine: a vendor URL is
// answered from a file or refused, and this file has no other route to the network.
//
// Nothing in src/ reads this file or any flag for it, and a deployed Worker (workerd) has no Node
// preload, so there is nothing a production deploy could switch on.
import { appendFileSync } from "node:fs";
import { cannedPayload } from "./canned-vendors.mjs";

const log = process.env.E2E_VENDOR_LOG;
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;

/** The canned answer to a vendor URL, as the vendor would put it on the wire, or undefined. */
function canned(url) {
  const payload = cannedPayload(url, Date.now());
  if (!payload) return undefined;
  if (payload.utf16) return new Response(Buffer.from(`\uFEFF${payload.body}`, "utf16le"), { status: 200 });
  return new Response(payload.body, { status: 200, headers: { "content-type": payload.type } });
}

const record = (entry) => {
  if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
};

record({ kind: "active" });

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (loopback.has(url.hostname)) return realFetch(input, init);
  const response = canned(url);
  if (response) {
    record({ kind: "served", host: url.host, path: url.pathname });
    return response;
  }
  record({ kind: "refused", host: url.host, path: url.pathname });
  throw new TypeError("fetch failed", { cause: new Error(`e2e: ${url.host} is not reachable from the browser tests`) });
};
