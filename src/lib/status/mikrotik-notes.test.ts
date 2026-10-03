import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { service } from "../../test/fixtures.ts";
import { type Handler, text } from "../../test/stub-fetch.ts";
import { runWithCloudflareContext } from "./cloudflare-context.ts";
import { collectBoard } from "./collect-board.ts";
import { clearMikrotikNotesCache, startMikrotikNotes, withMikrotikNotes } from "./mikrotik-notes.server.ts";
import { clearReleaseFeedCache, RELEASE_FEED_RETRY_MS } from "./release-feeds.server.ts";
import type { ServiceSnapshot } from "./types.ts";

// The MikroTik changelog notes are advisory: read after the health sweep, in the background, cached like a
// release feed. Most of what is pinned here is what they must NOT do: delay the sweep or change any result.

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (path: string) => readFileSync(new URL(path, FIXTURES), "utf8");

const UPGRADE = "https://upgrade.mikrotik.com/routeros/";
const DOWNLOAD = "https://download.mikrotik.com/routeros/";
const CHANGELOG_FILES = [
  "NEWESTa7.stable",
  "NEWESTa7.long-term",
  "NEWESTa7.testing",
  "NEWESTa7.development",
  "NEWESTa6.long-term",
];
const VERSIONS = ["7.20.2", "7.18.4", "7.21beta3", "7.21beta4", "6.49.19"];
const RELEASED = [
  "2026-09-15T12:00:00.000Z",
  "2026-07-22T12:00:00.000Z",
  "2026-09-17T12:00:00.000Z",
  "2026-09-19T12:00:00.000Z",
  "2026-03-03T12:00:00.000Z",
];
const changelog = (version: string) => `${DOWNLOAD}${version}/CHANGELOG`;
const CLAUDE = "https://status.claude.com/api/v2/summary.json";
const degraded = {
  status: { indicator: "minor", description: "Partially Degraded Service" },
  components: [{ id: "a", name: "claude.ai", status: "degraded_performance" }],
  incidents: [],
  scheduled_maintenances: [],
};

const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** The channel files answer with their fixtures. */
function channels(): Record<string, Handler> {
  return Object.fromEntries(CHANGELOG_FILES.map((file) => [`${UPGRADE}${file}`, text(fixture(`mikrotik/${file}`))]));
}

/** Both changelogs there are fixtures for. */
function changelogs(): Record<string, Handler> {
  return {
    [changelog("7.20.2")]: text(fixture("mikrotik/7.20.2/CHANGELOG")),
    [changelog("7.21beta4")]: text(fixture("mikrotik/7.21beta4/CHANGELOG")),
  };
}

/** A MikroTik card as the collector builds it: the five channels, no notes. */
function card(): ServiceSnapshot {
  return service("mikrotik", {
    category: "updates",
    summary: "Latest RouterOS 7.20.2 · Sep 19",
    components: VERSIONS.map((version, index) => ({
      name: CHANGELOG_FILES[index],
      health: "operational" as const,
      release: {
        version,
        // 7.21beta4 is the newest.
        releasedAt: RELEASED[index],
        url: changelog(version),
        linkLabel: "Release notes",
      },
    })),
  });
}

describe("MikroTik changelog notes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-02T12:00:00.000Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clearMikrotikNotesCache();
    clearReleaseFeedCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearMikrotikNotesCache();
    clearReleaseFeedCache();
  });

  /** Routes `fetch` and records each changelog request with its Range header. */
  function route(routes: Record<string, Handler>) {
    const asked: string[] = [];
    const ranges = new Set<string | null>();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith(DOWNLOAD)) {
        asked.push(url);
        ranges.add(new Headers(init?.headers).get("range"));
      }
      return routes[url]?.() ?? new Response("not found", { status: 404, statusText: "Not Found" });
    });
    return { asked, ranges };
  }

  describe("withMikrotikNotes and startMikrotikNotes", () => {
    it("adds each version's first notes and the newest release's first note, and nothing else", async () => {
      const { asked, ranges } = route(changelogs());
      const before = [card()];
      // Nothing is cached yet: the card is exactly the collector's.
      expect(withMikrotikNotes(before)[0]).toBe(before[0]);
      await startMikrotikNotes(before);
      // One ranged read of the start of each distinct version's changelog, not of the whole file.
      expect(asked.sort()).toEqual(VERSIONS.map(changelog).sort());
      expect(ranges).toEqual(new Set(["bytes=0-65535"]));

      const [after] = withMikrotikNotes(before);
      expect(after.summary).toBe(
        "What's new in 7.21beta4 (2026-Sep-19 12:00) — bgp - fixed route refresh handling when the peer restarts",
      );
      const release = (version: string) => after.components.find((c) => c.release?.version === version)?.release;
      expect(release("7.20.2")).toEqual({
        ...before[0].components[0].release,
        // The important bullet first, four of the five, no markers or trailing semicolons.
        notes: [
          "lte - fixed a crash when a modem is removed during a firmware update",
          "bridge - fixed VLAN filtering after a port is moved between bridges",
          "dhcpv4-server - fixed lease expiry reported in the wrong unit",
          "ipsec - improved rekeying with peers that change address",
        ],
      });
      expect(release("7.21beta4")?.notes?.[0]).toBe("bgp - fixed route refresh handling when the peer restarts");
      // A version whose changelog could not be read has its link and date, and no notes: nothing is made up.
      expect(release("6.49.19")).toEqual(before[0].components[4].release);
      // Health, versions, incidents and the rest are exactly the collector's.
      expect({ ...after, summary: "", components: [] }).toEqual({ ...before[0], summary: "", components: [] });
      expect(after.components.map(({ name, health, detail }) => ({ name, health, detail }))).toEqual(
        before[0].components.map(({ name, health, detail }) => ({ name, health, detail })),
      );
    });

    it("leaves every other card, a failed MikroTik card and a MikroTik card of other versions alone", async () => {
      route(changelogs());
      const other = service("windows", { category: "updates" });
      const failed = service("mikrotik", { health: "unknown", failure: { kind: "network", message: "down" } });
      await startMikrotikNotes([card()]);
      const [a, b, c] = withMikrotikNotes([other, failed, { ...card(), components: [] }]);
      expect(a).toBe(other);
      expect(b).toBe(failed);
      expect(c.components).toEqual([]);
    });

    it("reads a version once: a second start asks for nothing that was read", async () => {
      const { asked } = route(changelogs());
      await startMikrotikNotes([card()]);
      expect(asked).toHaveLength(5);
      asked.length = 0;
      await startMikrotikNotes([card()]);
      // The three that did not answer (404) are left for the retry window, so nothing at all is asked.
      expect(asked).toEqual([]);
      // Past it, only the failed ones are asked again: the two that parsed are kept.
      vi.setSystemTime(Date.now() + RELEASE_FEED_RETRY_MS + 1);
      await startMikrotikNotes([card()]);
      expect(asked.sort()).toEqual([changelog("6.49.19"), changelog("7.18.4"), changelog("7.21beta3")].sort());
    });

    it("a failed changelog is cached for the retry period and asked again after it", async () => {
      let down = true;
      const { asked } = route({
        ...changelogs(),
        [changelog("7.20.2")]: () =>
          down ? new Response("", { status: 503 }) : text(fixture("mikrotik/7.20.2/CHANGELOG"))(),
      });
      await startMikrotikNotes([card()]);
      expect(asked.filter((url) => url === changelog("7.20.2"))).toHaveLength(1);
      expect(withMikrotikNotes([card()])[0].components[0].release?.notes).toBeUndefined();
      // Inside the retry period nothing is asked, even by a board that comes every few seconds.
      down = false;
      vi.setSystemTime(Date.now() + RELEASE_FEED_RETRY_MS - 1);
      await startMikrotikNotes([card()]);
      expect(asked.filter((url) => url === changelog("7.20.2"))).toHaveLength(1);
      vi.setSystemTime(Date.now() + 2);
      await startMikrotikNotes([card()]);
      expect(asked.filter((url) => url === changelog("7.20.2"))).toHaveLength(2);
      expect(withMikrotikNotes([card()])[0].components[0].release?.notes).toBeTruthy();
    });

    describe("a body that does not parse is a failed read", () => {
      const badBodies: Array<[string, string]> = [
        ["empty", ""],
        [
          "an HTML error page",
          "<!doctype html><html><head><title>Error</title></head><body><h1>502 Bad Gateway</h1></body></html>",
        ],
        ["truncated before the version's section", "Changelog for RouterOS\n\n"],
        ["a heading with no bullet", "What's new in 7.20.2 (2025-Sep-19 10:00):\n\n"],
        ["the changelog of another version", fixture("mikrotik/7.21beta4/CHANGELOG")],
      ];
      for (const [label, bad] of badBodies) {
        it(`${label}: no notes, and asked again after the retry period`, async () => {
          let broken = true;
          const { asked } = route({
            ...changelogs(),
            [changelog("7.20.2")]: () => text(broken ? bad : fixture("mikrotik/7.20.2/CHANGELOG"))(),
          });
          await startMikrotikNotes([card()]);
          const [first] = withMikrotikNotes([card()]);
          expect(first.components[0].release?.notes).toBeUndefined();
          expect(first.components[0].release?.url).toBe(changelog("7.20.2"));
          // The newest version's summary is unaffected by the stable one's bad body.
          expect(first.summary).toContain("What's new in 7.21beta4");
          broken = false;
          vi.setSystemTime(Date.now() + RELEASE_FEED_RETRY_MS + 1);
          await startMikrotikNotes([card()]);
          expect(asked.filter((url) => url === changelog("7.20.2"))).toHaveLength(2);
          expect(withMikrotikNotes([card()])[0].components[0].release?.notes).toBeTruthy();
        });
      }

      it("the newest version's bad body leaves the generic summary", async () => {
        route({ ...changelogs(), [changelog("7.21beta4")]: text("<html>oops</html>") });
        await startMikrotikNotes([card()]);
        const [after] = withMikrotikNotes([card()]);
        expect(after.summary).toBe("Latest RouterOS 7.20.2 · Sep 19");
        expect(after.components[0].release?.notes).toBeTruthy();
      });
    });

    it("never throws or rejects, whatever the changelog host does", async () => {
      vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
      await expect(startMikrotikNotes([card()])).resolves.toBeUndefined();
      expect(withMikrotikNotes([card()])[0].components.every((c) => c.release?.notes === undefined)).toBe(true);
    });
  });

  describe("on the board", () => {
    const feedUrls = (url: string) => url.startsWith(DOWNLOAD);
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const judged = (board: Awaited<ReturnType<typeof collectBoard>>) => ({
      counts: board.counts,
      services: board.services.map((card) => ({
        id: card.id,
        health: card.health,
        summary: card.summary,
        components: card.components,
        incidents: card.incidents,
        failure: card.failure,
        latencyMs: card.latencyMs,
        meta: card.meta,
      })),
    });

    /** One board build as a Worker runs it: what it returns, and what it asked `waitUntil` to keep alive. */
    async function collectInWorker() {
      const waiting: Promise<unknown>[] = [];
      const board = await runWithCloudflareContext({ env: {}, waitUntil: (promise) => waiting.push(promise) }, () =>
        collectBoard(),
      );
      return { board, waiting, background: () => Promise.all(waiting) };
    }

    it("changelogs that are failing, hanging or slow change no health result and not the board's duration", async () => {
      const upgrade = channels();
      const known = changelogs();
      const hung: Array<() => void> = [];
      const scenarios: Record<string, (url: string) => Promise<Response>> = {
        up: async (url) => (known[url] ? (known[url] as Handler)() : new Response("", { status: 404 })),
        "failing (500)": async () => new Response("", { status: 500 }),
        "network error": async () => Promise.reject(new TypeError("fetch failed")),
        hanging: () =>
          new Promise<Response>((resolve) => {
            hung.push(() => resolve(new Response("", { status: 500 })));
          }),
      };
      const results: Array<{ name: string; durationMs: number; judged: ReturnType<typeof judged> }> = [];
      for (const [name, scenario] of Object.entries(scenarios)) {
        clearMikrotikNotesCache();
        clearReleaseFeedCache();
        vi.setSystemTime(Date.parse("2026-10-02T12:00:00.000Z"));
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = urlOf(input);
          if (feedUrls(url)) return scenario(url);
          // Each health answer moves the clock on, so the board has a duration to compare.
          vi.setSystemTime(Date.now() + 250);
          if (url === CLAUDE) return new Response(JSON.stringify(degraded));
          return upgrade[url]?.() ?? new Response("not found", { status: 404, statusText: "Not Found" });
        });
        const { board, background } = await collectInWorker();
        for (const release of hung.splice(0)) release();
        await background();
        results.push({ name, durationMs: board.durationMs, judged: judged(board) });
      }
      const [baseline, ...others] = results;
      expect(baseline.durationMs).toBeGreaterThan(0);
      const mikrotik = baseline.judged.services.find((card) => card.id === "mikrotik");
      expect(mikrotik?.health).toBe("operational");
      expect(mikrotik?.components).toHaveLength(5);
      for (const other of others) {
        expect(other.durationMs, other.name).toBe(baseline.durationMs);
        expect(other.judged, other.name).toEqual(baseline.judged);
      }
    });

    it("starts no changelog request until every health request has settled", async () => {
      const upgrade = channels();
      const known = changelogs();
      let slowest: (() => void) | undefined;
      let slowestDone = false;
      const changelogsBeforeSlowest: string[] = [];
      vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (feedUrls(url)) {
          if (!slowestDone) changelogsBeforeSlowest.push(url);
          return Promise.resolve(known[url]?.() ?? new Response("", { status: 404 }));
        }
        if (url === CLAUDE) {
          return new Promise<Response>((resolve) => {
            slowest = () => {
              slowestDone = true;
              resolve(new Response(JSON.stringify(degraded)));
            };
          });
        }
        return Promise.resolve(upgrade[url]?.() ?? new Response("not found", { status: 404, statusText: "Not Found" }));
      });
      let finished = false;
      const run = collectInWorker().then((result) => {
        finished = true;
        return result;
      });
      // Every other source, the MikroTik channels among them, has answered; one is still out.
      await settle();
      await settle();
      expect(finished).toBe(false);
      expect(changelogsBeforeSlowest).toEqual([]);
      slowest?.();
      const { board, background } = await run;
      await background();
      expect(changelogsBeforeSlowest).toEqual([]);
      expect(board.services.find((card) => card.id === "claude")?.health).toBe("degraded");
    });

    it("never waits for a slow changelog; Worker is kept alive for it, and the next board has the notes", async () => {
      const upgrade = channels();
      const known = changelogs();
      const held: Array<() => void> = [];
      const calls: string[] = [];
      vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (feedUrls(url)) {
          calls.push(url);
          return new Promise<Response>((resolve) => {
            held.push(() => resolve(known[url]?.() ?? new Response("", { status: 404 })));
          });
        }
        return Promise.resolve(upgrade[url]?.() ?? new Response("not found", { status: 404, statusText: "Not Found" }));
      });
      const first = await collectInWorker();
      const mikrotik = first.board.services.find((card) => card.id === "mikrotik");
      // The cold board went out without the notes...
      expect(mikrotik?.summary).toBe("Latest RouterOS 7.20.2 · Sep 19");
      expect(mikrotik?.components.some((component) => component.release?.notes)).toBe(false);
      // ...the changelogs were started, once, after the sweep, and the Worker was asked to stay alive for them.
      await settle();
      expect(calls.sort()).toEqual(VERSIONS.map(changelog).sort());
      expect(first.waiting).toHaveLength(1);
      let done = false;
      void Promise.resolve(first.waiting[0]).then(() => {
        done = true;
      });
      await settle();
      expect(done).toBe(false);
      for (const release of held.splice(0)) release();
      await first.background();
      expect(done).toBe(true);
      // The next board has them from the cache, without asking again.
      calls.length = 0;
      const second = await collectBoard();
      const after = second.services.find((card) => card.id === "mikrotik");
      expect(after?.summary).toContain("What's new in 7.21beta4");
      expect(after?.components[0].release?.notes?.[0]).toContain("lte - fixed a crash");
      expect(after?.health).toBe("operational");
      expect(calls).toEqual([]);
    });
  });
});
