// Preloaded into the preview server the browser tests start (playwright.config.ts passes it through
// NODE_OPTIONS, so only that one process tree loads it). It replaces the server's global `fetch`, so the
// page's first render never depends on what a vendor says today or on whether the runner can reach one:
//   - a request to this machine goes through;
//   - a request to a vendor URL that has a canned payload in src/lib/status/__fixtures__ (the files the
//     collector unit tests read, the same table as src/test/stub-fetch.ts routes) is answered from that file,
//     with its dates moved to the present so the collectors' windows (14 days and the like) see it as current;
//   - any other host or URL is refused at once, as a network that is down would refuse it.
// The first render, and the hydration that follows it, is the same board in a sandbox, on a laptop and in CI,
// with outages, degraded and maintenance cards, incidents with times, component lists and release lines on it
// (the services without a canned payload read Unknown). Every request is written to E2E_VENDOR_LOG, one JSON
// line each, for the report of e2e/support/global-setup.ts. No request leaves the machine: a vendor URL is
// answered from a file or refused, and this file has no other route to the network.
//
// Nothing in src/ reads this file or any flag for it, and a deployed Worker (workerd) has no Node
// preload, so there is nothing a production deploy could switch on.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const log = process.env.E2E_VENDOR_LOG;
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;
const FIXTURES = new URL("../../src/lib/status/__fixtures__/", import.meta.url);

// The day the hand-built fixtures sit around (see the fixtures' README): their dates move by the distance
// from this moment to now.
const ANCHOR = Date.parse("2026-09-20T12:00:00.000Z");

// Vendor URL -> fixture file. `utf16` is the AWS Health feed, which is UTF-16 on the wire.
const ROUTES = {
  "https://status.cloud.google.com/incidents.json": { file: "gcp/incidents.json" },
  "https://status.cloud.google.com/products.json": { file: "gcp/products.json" },
  "https://status.play.google.com/incidents.json": { file: "play/incidents.json" },
  "https://status.play.google.com/products.json": { file: "play/products.json" },
  "https://health.aws.amazon.com/public/currentevents": { file: "aws/currentevents.json", utf16: true },
  "https://rssfeed.azure.status.microsoft/en-us/status/feed/": { file: "azure/feed.xml" },
  "https://www.githubstatus.com/api/v2/summary.json": { file: "github/summary.json" },
  "https://confluence.status.atlassian.com/api/v2/summary.json": { file: "confluence/summary.json" },
  "https://api.status.io/1.0/status/5b36dc6502d06804c08349f7": { file: "gitlab/status.json" },
  "https://status.x.ai/feed.xml": { file: "grok/feed.xml" },
  "https://status.x.ai/v2/components.json": { file: "grok/components.json" },
  "https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0": { file: "steam/cm-list.json" },
  "https://developer.apple.com/news/releases/rss/releases.rss": { file: "apple-os/releases.rss" },
  "https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information": {
    file: "windows/windows11-release-information.html",
  },
  "https://developer.android.com/about/versions": { file: "android-os/versions.html" },
  "https://aws.amazon.com/about-aws/whats-new/recent/feed/": { file: "aws/whats-new.xml" },
  "https://cloud.google.com/feeds/gcp-release-notes.xml": { file: "gcp/release-notes.xml" },
  "https://www.microsoft.com/releasecommunications/api/v2/azure/rss": { file: "azure/updates.xml" },
  "https://github.blog/changelog/feed/": { file: "github/changelog.xml" },
  "https://docs.gitlab.com/releases/all-releases.xml": { file: "gitlab/releases.xml" },
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=300&feeds=steam_community_announcements":
    { file: "steam/cs2-news.json" },
};

/** RouterOS: the channel files (upgrade.mikrotik.com/routeros/NEWESTa7.stable) and one CHANGELOG per version. */
function mikrotik(url) {
  const channel = /^https:\/\/upgrade\.mikrotik\.com\/routeros\/(NEWESTa\d\.[a-z-]+)$/.exec(url.href);
  if (channel) return { file: `mikrotik/${channel[1]}` };
  const notes = /^https:\/\/download\.mikrotik\.com\/routeros\/([0-9a-z.]+)\/CHANGELOG$/.exec(url.href);
  return notes ? { file: `mikrotik/${notes[1]}/CHANGELOG` } : undefined;
}

const pad = (value, width = 2) => String(value).padStart(width, "0");

/** An ISO timestamp moved by `delta` ms, spelled the way it was: its fraction (or none) and its UTC offset. */
function shiftIso(stamp, delta) {
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|([+-])(\d\d):(\d\d))$/.exec(stamp);
  if (!parts) return stamp;
  // The wall clock moves by `delta` and the offset stays, so the stamp is read as if it were UTC and spelled back.
  const moved = new Date(Date.parse(`${parts[1]}${parts[2] ?? ""}Z`) + delta);
  const wall = `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}T${pad(moved.getUTCHours())}:${pad(moved.getUTCMinutes())}:${pad(moved.getUTCSeconds())}`;
  return `${wall}${parts[2] ? `.${pad(moved.getUTCMilliseconds(), 3)}` : ""}${parts[3]}`;
}

/** `text` with every full timestamp in it (ISO, RFC 822 in a feed, Unix seconds) moved by `delta` ms. */
function shiftDates(text, delta) {
  return text
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g, (stamp) => shiftIso(stamp, delta))
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d GMT/g, (stamp) =>
      new Date(Date.parse(stamp) + delta).toUTCString(),
    )
    .replace(/\b17[89]\d{8}\b/g, (seconds) => String(Math.round(Number(seconds) + delta / 1000)));
}

function canned(url) {
  const route = ROUTES[url.href] ?? mikrotik(url);
  if (!route) return undefined;
  const path = new URL(route.file, FIXTURES);
  if (!existsSync(path)) return undefined;
  const body = shiftDates(readFileSync(path, "utf8"), Date.now() - ANCHOR);
  if (route.utf16) return new Response(Buffer.from(`\uFEFF${body}`, "utf16le"), { status: 200 });
  const type = route.file.endsWith(".json") ? "application/json" : "text/xml";
  return new Response(body, { status: 200, headers: { "content-type": type } });
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
