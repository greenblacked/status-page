// Preloaded into the preview server the browser tests start (playwright.config.ts passes it through
// NODE_OPTIONS, so only that one process tree loads it). It replaces the server's global `fetch`:
// a request to this machine goes through, and any other host is refused at once, as a network that is
// down would refuse it, and written to E2E_VENDOR_LOG for global-teardown.ts to report. So the page's
// first render never depends on what a vendor says today or on whether the runner can reach it: every
// card is Unknown, the same board on a laptop, in a sandbox and in CI, and no request leaves the machine.
//
// Nothing in src/ reads this file or any flag for it, and a deployed Worker (workerd) has no Node
// preload, so there is nothing a production deploy could switch on.
import { appendFileSync } from "node:fs";

const log = process.env.E2E_VENDOR_LOG;
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;

const record = (entry) => {
  if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
};

record({ kind: "active" });

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (loopback.has(url.hostname)) return realFetch(input, init);
  record({ kind: "refused", host: url.host, path: url.pathname });
  throw new TypeError("fetch failed", { cause: new Error(`e2e: ${url.host} is not reachable from the browser tests`) });
};
