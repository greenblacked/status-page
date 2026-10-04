import type { Page, Route } from "@playwright/test";
import { toCrossJSONAsync } from "seroval";
import { CATALOG } from "../src/lib/status/catalog.ts";
import { formatReleaseAge } from "../src/lib/status/changelog.ts";
import type {
  BoardSnapshot,
  ComponentHealth,
  Health,
  ReleaseFeed,
  ServiceId,
  ServiceSnapshot,
} from "../src/lib/status/types.ts";

// A board with every state the page can show, for tests that must see
// them all whatever the vendors say today (and offline, every vendor says
// Unknown). Outage, degraded, maintenance that has not started, unknown,
// operational services and release trackers, incidents with start times.
// Two attention services differ in severity (AWS down, Google Cloud
// degraded), so the most urgent one leads the board. Healthy ChatGPT and
// Claude list several operational components, and healthy Grok lists none
// (its feed names no components), so every card layout a healthy service
// can take is on screen. Google Cloud, AWS and Steam carry the component
// lists their collectors build from products.json, the services in current
// events and the connection-manager directory.

const minute = 60_000;
const day = 24 * 60 * minute;

/** A long, all-operational component list, the shape a big vendor (Google Cloud lists over two hundred) gives. */
const longList = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `${prefix} ${index + 1}`, health: "operational" as const }));

type Override = Partial<Omit<ServiceSnapshot, "id">>;

const WINDOWS_PAGE = "https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information";

/** A channel or OS of a release tracker, its row line and its Details built from one date, as the collectors do. */
function release(
  name: string,
  health: Health,
  releasedAt: string,
  version: string,
  more: Omit<NonNullable<ComponentHealth["release"]>, "version" | "releasedAt">,
): ComponentHealth {
  return {
    name,
    health,
    detail: [version, formatReleaseAge(releasedAt)].join(" · "),
    release: { version, releasedAt, ...more },
  };
}

function overrides(now: number, grok: Health): Partial<Record<ServiceId, Override>> {
  const at = (offset: number) => new Date(now + offset).toISOString();
  return {
    aws: {
      health: "outage",
      summary: "Increased error rates in us-east-1",
      // Only the services the current events name, merged per service.
      components: [
        {
          name: "Amazon Elastic Compute Cloud",
          health: "outage",
          detail: "N. Virginia · Increased error rates",
        },
        { name: "AWS Lambda", health: "degraded", detail: "N. Virginia · Increased invoke latencies" },
      ],
      incidents: [
        {
          id: "aws-1",
          title: "Increased error rates in us-east-1",
          health: "outage",
          startedAt: at(-52 * minute),
        },
      ],
    },
    gcp: {
      health: "degraded",
      summary: "Elevated error rates for Cloud Run in europe-west1",
      // Products from products.json: the ones an open incident names lead,
      // the worst first.
      components: [
        { name: "Cloud Run", health: "degraded", detail: "europe-west1" },
        { name: "Cloud Build", health: "degraded" },
        { name: "Google Compute Engine", health: "operational" },
        { name: "BigQuery", health: "operational" },
        ...longList("Cloud product", 36),
      ],
      incidents: [
        {
          id: "gcp-1",
          title: "Elevated error rates for Cloud Run in europe-west1",
          health: "degraded",
          startedAt: at(-130 * minute),
        },
      ],
    },
    // Healthy Grok is the bare one: no components at all.
    ...(grok === "operational"
      ? {}
      : {
          grok: {
            health: grok,
            summary: grok === "outage" ? "Grok is unavailable for most users" : "Slow responses on grok.com",
            components: [
              { name: "API", health: grok },
              { name: "grok.com", health: grok },
            ],
            incidents: [
              { id: "grok-1", title: "Investigating failed requests", health: grok, startedAt: at(-38 * minute) },
            ],
          },
        }),
    chatgpt: {
      components: [
        { name: "Conversations", health: "operational" },
        { name: "Login", health: "operational" },
        { name: "Voice mode", health: "operational" },
        { name: "Image generation", health: "operational" },
        { name: "API", health: "operational" },
      ],
    },
    // A healthy row with a long list: six shown, the rest behind "Show all".
    spotify: { components: longList("Spotify part", 32) },
    claude: {
      components: [
        { name: "claude.ai", health: "operational" },
        { name: "Claude API", health: "operational" },
        { name: "Claude Code", health: "operational" },
        { name: "Claude Console", health: "operational" },
      ],
    },
    epic: {
      health: "maintenance",
      summary: "Scheduled maintenance for the Epic Games Store",
      components: [{ name: "Epic Games Store", health: "maintenance" }],
      incidents: [
        { id: "epic-1", title: "Store maintenance window", health: "maintenance", startedAt: at(5 * 60 * minute) },
      ],
    },
    android: {
      health: "unknown",
      summary: "The official source did not answer in time",
      failure: { kind: "timeout", message: "timed out" },
    },
    steam: {
      components: [
        { name: "Steam Web API", health: "operational" },
        { name: "Steam Store", health: "operational" },
        { name: "Steam Connection Managers", health: "operational", detail: "41 servers listed" },
      ],
    },
    "cs2-europe": {
      components: [
        { name: "Frankfurt", health: "operational", detail: "38 relays" },
        { name: "Stockholm", health: "operational", detail: "24 relays" },
        { name: "Vienna", health: "operational", detail: "12 relays" },
      ],
    },
    // The release trackers carry the Details their collectors build: RouterOS has the first lines of each
    // version's changelog, Apple's feed has none, Windows' table gives bare days and a build, and Android's page
    // gives only a link. The row's line is built from the same date as the Details, as the collectors do.
    mikrotik: {
      summary: "RouterOS 7.21 stable",
      components: [
        release("Stable", "maintenance", at(-6 * day), "7.21", {
          url: "https://download.mikrotik.com/routeros/7.21/CHANGELOG",
          linkLabel: "Release notes",
          notes: [
            "bgp - fixed route refresh handling when the peer restarts",
            "bridge - improved MAC learning performance on CRS3xx series devices",
            "wifi - fixed station roaming between access points on the same channel",
          ],
          // The note the collector derives from the same changelog: 23 changes, two of them flagged important.
          note: {
            text: "23 changes: bgp, bridge, wifi +9 more · 2 important",
            detail:
              "23 changes in 12 areas: bgp, bridge, wifi, lte, ipsec, ospf, container, dhcpv4-server, console, system, ppp, routing.",
            important: [
              "lte - fixed a crash when a modem is removed during a firmware update",
              "system - changed the default firewall policy",
            ],
          },
        }),
        release("Long-term", "operational", at(-70 * day), "7.18.2", {
          url: "https://download.mikrotik.com/routeros/7.18.2/CHANGELOG",
          linkLabel: "Release notes",
          notes: ["dhcpv4-server - fixed lease expiry reported in the wrong unit"],
          note: {
            text: "1 change: dhcpv4-server",
            detail: "1 change in 1 area: dhcpv4-server.",
          },
        }),
        release("Testing", "operational", at(-20 * day), "7.22beta3", {
          url: "https://download.mikrotik.com/routeros/7.22beta3/CHANGELOG",
          linkLabel: "Release notes",
        }),
      ],
    },
    "apple-os": {
      summary: "Latest: iOS 27.2 beta 2",
      components: [
        release("iOS", "maintenance", at(-9 * day), "27.2 beta 2", {
          build: "24B5089g",
          url: "https://developer.apple.com/news/releases/?id=09212026a",
          linkLabel: "Apple Developer post",
        }),
        release("macOS", "operational", at(-40 * day), "27.1", {
          build: "26B5042",
          url: "https://developer.apple.com/news/releases/?id=08202026b",
          linkLabel: "Apple Developer post",
        }),
      ],
    },
    windows: {
      summary: `Latest: Windows 11 26H2 (build 26300.1000) · ${formatReleaseAge(at(-2 * day).slice(0, 10))}`,
      components: [
        {
          name: "26H2",
          health: "maintenance",
          detail: `26300.1000 · ${formatReleaseAge(at(-2 * day).slice(0, 10))}`,
          release: {
            version: "26H2",
            build: "26300.1000",
            releasedAt: at(-2 * day).slice(0, 10),
            url: WINDOWS_PAGE,
            // The update type of its latest build from the page's history table, with the article the table links.
            note: {
              text: "Security update",
              detail: "2026-09 B: the monthly security update.",
              reference: { label: "KB5000000", url: "https://support.microsoft.com/help/5000000" },
            },
          },
        },
        {
          name: "26H1",
          health: "operational",
          detail: `28000.1575 · ${formatReleaseAge(at(-9 * day).slice(0, 10))}`,
          release: {
            version: "26H1",
            build: "28000.1575",
            releasedAt: "2026-02-10",
            updatedAt: at(-9 * day).slice(0, 10),
            url: WINDOWS_PAGE,
            // Its table names the article in text only: the number is shown, with no link.
            note: {
              text: "Optional preview",
              detail: "2026-09 D: an optional, non-security preview of the next monthly update.",
              reference: { label: "KB5000050" },
            },
          },
        },
      ],
    },
    "android-os": {
      summary: "Latest: Android 17",
      components: [17, 16, 15, 14].map((version) => ({
        name: `Android ${version}`,
        health: "operational" as const,
        detail: "released",
        release: {
          version: `Android ${version}`,
          url: `https://developer.android.com/about/versions/${version}`,
          linkLabel: `Android ${version} page`,
        },
      })),
    },
  };
}

/** Every catalog service, operational unless overridden above. `grok` lets a test turn the otherwise healthy, component-less Grok into an incident between boards. */
export function fixtureBoard(now: number, { grok = "operational" }: { grok?: Health } = {}): BoardSnapshot {
  const patch = overrides(now, grok);
  const services: ServiceSnapshot[] = CATALOG.map((entry, index) => ({
    ...entry,
    health: "operational",
    summary: "All systems operational",
    checkedAt: new Date(now).toISOString(),
    latencyMs: 120 + index * 23,
    components: [],
    incidents: [],
    ...patch[entry.id],
  }));
  const counts: Record<Health, number> = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const service of services) counts[service.health] += 1;
  return { generatedAt: new Date(now).toISOString(), durationMs: 480, services, counts };
}

/** The same twenty services with nothing wrong anywhere: every one operational, no incident, no failure. */
export function calmBoard(now: number): BoardSnapshot {
  const board = fixtureBoard(now);
  const services = board.services.map((service) => ({
    ...service,
    health: "operational" as const,
    summary: "All systems operational",
    incidents: [],
    upcomingMaintenance: [],
    failure: undefined,
    components: service.components.map((component) => ({ ...component, health: "operational" as const })),
  }));
  return {
    ...board,
    services,
    counts: { operational: services.length, degraded: 0, outage: 0, maintenance: 0, unknown: 0 },
  };
}

/**
 * The release feeds a board attaches to the status cards whose vendors publish one, as the collectors build them:
 * a version where the vendor numbers its releases (GitLab), the entry's headline where it does not, a day, a few
 * plain notes and a link on the vendor's own host. Advisory, so they sit beside the cards' health and change none
 * of it: `feedBoard` is `fixtureBoard` with these added, and a test that wants none uses `fixtureBoard`.
 */
function releaseFeeds(now: number): Partial<Record<ServiceId, ReleaseFeed>> {
  const at = (days: number) => new Date(now - days * day).toISOString();
  const entry = (title: string, days: number, url: string, linkLabel: string, notes: string[], version = "") => ({
    title,
    release: { version, releasedAt: at(days), url, linkLabel, ...(notes.length > 0 ? { notes } : {}) },
  });
  return {
    gitlab: {
      sourceName: "GitLab releases",
      sourceUrl: "https://docs.gitlab.com/releases/",
      entries: [
        entry(
          "GitLab 19.4.1",
          9,
          "https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-4-1-released/",
          "Release post",
          [
            "GitLab Critical Patch Release: 19.4.1, 19.3.3, 19.2.7",
            "On September 23, 2026, we released versions 19.4.1, 19.3.3, 19.2.7.",
          ],
          "19.4.1",
        ),
        entry(
          "GitLab 19.4",
          15,
          "https://docs.gitlab.com/releases/19/gitlab-19-4-released/",
          "Release post",
          ["GitLab 19.4 release notes"],
          "19.4",
        ),
        entry(
          "GitLab 19.3.2",
          23,
          "https://docs.gitlab.com/releases/patches/patch-release-gitlab-19-3-2-released/",
          "Release post",
          [],
          "19.3.2",
        ),
      ],
    },
    github: {
      sourceName: "GitHub Changelog",
      sourceUrl: "https://github.blog/changelog/",
      entries: [
        entry(
          "Copilot code review is now generally available for all plans",
          1,
          "https://github.blog/changelog/2026-10-01-copilot-code-review-is-now-generally-available-for-all-plans/",
          "Changelog post",
          ["Copilot code review is now generally available for every GitHub plan."],
        ),
        entry(
          "Actions: larger runners get Windows Server 2025 images",
          2,
          "https://github.blog/changelog/2026-09-30-actions-larger-runners-get-windows-server-2025-images/",
          "Changelog post",
          ["Larger runners now offer Windows Server 2025 images."],
        ),
      ],
    },
    aws: {
      sourceName: "AWS What's New",
      sourceUrl: "https://aws.amazon.com/new/",
      entries: [
        entry(
          "Amazon EC2 R9i instances are now generally available in additional regions",
          1,
          "https://aws.amazon.com/about-aws/whats-new/2026/10/amazon-ec2-r9i-additional-regions/",
          "What's New post",
          [
            "Starting today, Amazon EC2 R9i instances are available in the Europe (Stockholm) and Asia Pacific (Seoul) Regions.",
          ],
        ),
        entry(
          "AWS Lambda adds support for Node.js 26 & Python 3.15",
          2,
          "https://aws.amazon.com/about-aws/whats-new/2026/09/aws-lambda-nodejs-26-python-3-15/",
          "What's New post",
          [],
        ),
      ],
    },
    gcp: {
      sourceName: "Google Cloud release notes",
      sourceUrl: "https://cloud.google.com/release-notes",
      entries: [
        entry(
          "Cloud Run, BigQuery and 2 more",
          1,
          "https://cloud.google.com/release-notes#October_01_2026",
          "Release notes",
          [
            "Cloud Run now supports GPU-backed worker pools in europe-west1.",
            "BigQuery now supports vector search over partitioned tables.",
          ],
        ),
      ],
    },
    azure: {
      sourceName: "Azure Updates",
      sourceUrl: "https://azure.microsoft.com/en-us/updates",
      entries: [
        entry(
          "[Launched] Generally available: Azure Kubernetes Service Automatic in more regions",
          1,
          "https://azure.microsoft.com/updates?id=551201",
          "Azure update",
          ["AKS Automatic is now generally available in 12 additional Azure regions."],
        ),
      ],
    },
    "cs2-europe": {
      sourceName: "Counter-Strike 2 updates",
      sourceUrl: "https://store.steampowered.com/news/app/730",
      entries: [
        entry(
          "Counter-Strike 2 Update",
          3,
          "https://store.steampowered.com/news/app/730/view/5123456789012345678",
          "Steam announcement",
          ["Added the new Anubis match map to the Premier map pool.", "Fixed a crash when spectating a bot."],
        ),
        entry(
          "Counter-Strike 2 Update",
          8,
          "https://store.steampowered.com/news/app/730/view/5123456789012345001",
          "Steam announcement",
          [],
        ),
      ],
    },
  };
}

/** `fixtureBoard` with the vendors' release feeds attached to the six status cards that have one. */
export function feedBoard(now: number): BoardSnapshot {
  const board = fixtureBoard(now);
  const feeds = releaseFeeds(now);
  return {
    ...board,
    services: board.services.map((service) =>
      feeds[service.id] ? { ...service, releaseFeed: feeds[service.id] } : service,
    ),
  };
}

const SERVER_FN = "**/_serverFn/**";
const served = new WeakMap<Page, (route: Route) => Promise<void>>();

/**
 * Answers the board's server functions (the Refresh POST and the
 * scheduled GET) with `board()` instead of the vendors, in the same
 * serialized form the server sends. The page's first render still comes
 * from the server; press Refresh to bring the fixture in.
 *
 * `pressed`, when given, answers the Refresh POST alone, while the scheduled
 * GET keeps answering with `board()`: a test that needs a change to arrive
 * with its press, and not with a poll that happens to land first on a slow
 * machine, serves the change there.
 */
export async function serveBoard(page: Page, board: () => BoardSnapshot, pressed?: () => BoardSnapshot): Promise<void> {
  // One answer at a time: the newest replaces the one before, so a test that opens many boards on one page does
  // not stack a handler for each.
  const before = served.get(page);
  if (before) await page.unroute(SERVER_FN, before);
  const handler = async (route: Route) => {
    const answer = pressed && route.request().method() === "POST" ? pressed() : board();
    const body = await toCrossJSONAsync({ result: answer, error: undefined, context: {} }, { refs: new Map() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-tss-serialized": "true" },
      body: JSON.stringify(body),
    });
  };
  served.set(page, handler);
  await page.route(SERVER_FN, handler);
}

/**
 * The longest hero the page can have: fifteen services need a look, in all three states, so the headline is
 * "Five are down, five are degraded and five are in maintenance." and the line under it names three of each
 * ("and 2 more" after the first three), says the other three are running normally, and that two could not be read
 * (named, each a link). On a phone the headline and that line wrap to the most lines they can, and the live line
 * sits under them.
 */
export function longHeroBoard(now: number): BoardSnapshot {
  const board = fixtureBoard(now);
  const unread = new Set<ServiceId>(["android", "grok"]);
  const calm = new Set<ServiceId>(["apple-os", "windows", "android-os"]);
  const states: Health[] = ["outage", "degraded", "maintenance"];
  let next = 0;
  const services = board.services.map((service): ServiceSnapshot => {
    if (unread.has(service.id)) {
      return { ...service, health: "unknown", summary: "The official source did not answer in time" };
    }
    if (calm.has(service.id)) return service;
    const health = states[next++ % states.length];
    return {
      ...service,
      health,
      summary: service.summary === "All systems operational" ? "Elevated error rates" : service.summary,
    };
  });
  const counts: Record<Health, number> = { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  for (const service of services) counts[service.health] += 1;
  return { ...board, services, counts };
}
