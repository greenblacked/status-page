import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSECUTIVE_RUNS,
  PENDING_MAX_AGE_MS,
  type Pending,
  parseState,
  planRun,
  probeReadyz,
  type ReadyzResult,
  type Result,
  recordPath,
  recordResponses,
  renderState,
  retryDelayMs,
  syncDeployHealth,
  syncIssues,
} from "./source-health.ts";

// A fake of the three GitHub issue endpoints the script uses, so the
// open/update/close flow is tested before it ever runs against the real API.
type FakeIssue = {
  number: number;
  state: string;
  state_reason?: string;
  labels: string[];
  title: string;
  body: string;
  created_at: string;
};
let issues: FakeIssue[] = [];
let comments: { issue: number; body: string }[] = [];
let server: Server;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const one = url.pathname.match(/\/issues\/(\d+)$/);
    const commentOn = url.pathname.match(/\/issues\/(\d+)\/comments$/);
    if (req.method === "GET" && url.pathname.endsWith("/issues")) {
      const wanted = (url.searchParams.get("labels") ?? "").split(",");
      return send(
        200,
        issues.filter(
          (i) =>
            (url.searchParams.get("state") === "all" || i.state === url.searchParams.get("state")) &&
            wanted.every((l) => i.labels.includes(l)),
        ),
      );
    }
    if (req.method === "POST" && url.pathname.endsWith("/issues")) {
      const body = await readJson(req);
      const issue = {
        number: issues.length + 1,
        state: "open",
        created_at: "2026-09-23T00:00:00Z",
        ...body,
      } as FakeIssue;
      issues.push(issue);
      return send(201, issue);
    }
    if (req.method === "POST" && commentOn) {
      comments.push({ issue: Number(commentOn[1]), body: String((await readJson(req)).body) });
      return send(201, {});
    }
    if (req.method === "PATCH" && one) {
      const issue = issues.find((i) => i.number === Number(one[1]));
      Object.assign(issue ?? {}, await readJson(req));
      return send(200, issue);
    }
    send(404, { message: "not faked" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  Object.assign(process.env, {
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    GITHUB_TOKEN: "test",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_RUN_ID: "42",
  });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  issues = [];
  comments = [];
});

const broken: Result = {
  id: "apple",
  name: "Apple",
  ok: false,
  latencyMs: 90,
  attempts: 3,
  failure: { kind: "parser", message: "SyntaxError: response was not valid JSON" },
};
const healthy: Result = { ...broken, ok: true, failure: undefined };

const sourceIssues = () => issues.filter((i) => i.labels.includes("source-health"));
const stateIssues = () => issues.filter((i) => i.labels.includes("source-health-state"));

describe("source-health issue sync", () => {
  it("holds a first failure back, then opens one labelled issue on the second and updates it on the third", async () => {
    await syncIssues([broken]);
    expect(sourceIssues()).toHaveLength(0);

    await syncIssues([broken]);
    expect(sourceIssues()).toHaveLength(1);
    expect(sourceIssues()[0].title).toBe("Collector failure: Apple");
    expect(sourceIssues()[0].labels).toEqual(["source-health", "source:apple"]);
    expect(sourceIssues()[0].body).toContain("`parser`");
    expect(sourceIssues()[0].body).toContain("/owner/repo/actions/runs/42");
    expect(sourceIssues()[0].body).toContain("| Failing runs in a row | 2 |");

    await syncIssues([broken]);
    expect(sourceIssues()).toHaveLength(1);
    expect(sourceIssues()[0].body).toContain("| Failing runs in a row | 3 |");
    expect(comments).toHaveLength(0);
  });

  it("dates the first failure from the run that saw it, not from when the issue opened", async () => {
    const first = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await syncIssues([broken]);
    const [state] = stateIssues();
    state.body = renderState(new Map([["apple", { firstFailure: first, lastFailure: first, runs: 1 }]]));
    await syncIssues([broken]);
    expect(sourceIssues()[0].body).toContain(`| First failure | ${first} |`);
    expect(sourceIssues()[0].body).not.toMatch(/First failure \| (.+) \|\n\| Latest failure \| \1 \|/);
  });

  it("opens nothing for a source that fails once and then reads cleanly", async () => {
    await syncIssues([broken]);
    await syncIssues([healthy]);
    await syncIssues([broken]);
    expect(sourceIssues()).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });

  it("keeps its memory in one closed state issue that is edited, never duplicated", async () => {
    await syncIssues([broken]);
    await syncIssues([broken]);
    await syncIssues([healthy]);
    expect(stateIssues()).toHaveLength(1);
    expect(stateIssues()[0].state).toBe("closed");
    expect(stateIssues()[0].state_reason).toBe("not_planned");
    expect(parseState(stateIssues()[0].body).size).toBe(0);
  });

  it("comments and closes the issue once the source recovers", async () => {
    await syncIssues([broken]);
    await syncIssues([broken]);
    await syncIssues([healthy]);
    expect(sourceIssues()[0].state).toBe("closed");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Recovered");
  });

  it("starts the count over after a clean run", async () => {
    await syncIssues([broken]);
    await syncIssues([broken]);
    await syncIssues([healthy]);
    await syncIssues([broken]);
    expect(sourceIssues().filter((i) => i.state === "open")).toHaveLength(0);
  });

  it("counts each source on its own", async () => {
    const other: Result = { ...broken, id: "orange", name: "Orange" };
    await syncIssues([broken, { ...other, ok: true, failure: undefined }]);
    await syncIssues([broken, other]);
    expect(sourceIssues().map((i) => i.title)).toEqual(["Collector failure: Apple"]);
  });

  it("does nothing for a healthy source with no open issue", async () => {
    await syncIssues([healthy]);
    expect(issues).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });
});

describe("planRun", () => {
  const now = "2026-10-02T12:00:00.000Z";
  const earlier = (ms: number) => new Date(Date.parse(now) - ms).toISOString();
  const entry = (ago: number, runs = 1): Pending => ({ firstFailure: earlier(ago), lastFailure: earlier(ago), runs });
  const source = (id: string, ok: boolean): Result => ({
    ...broken,
    id,
    name: id,
    ok,
    failure: ok ? undefined : broken.failure,
  });

  it("remembers a first failure without allowing an issue", () => {
    const { next, mayOpen } = planRun([source("a", false)], new Map(), now);
    expect([...mayOpen]).toEqual([]);
    expect(next.get("a")).toEqual({ firstFailure: now, lastFailure: now, runs: 1 });
  });

  it("allows an issue once the source has failed in CONSECUTIVE_RUNS runs, keeping the first failure time", () => {
    expect(CONSECUTIVE_RUNS).toBe(2);
    const before = entry(60 * 60 * 1000);
    const { next, mayOpen } = planRun([source("a", false)], new Map([["a", before]]), now);
    expect([...mayOpen]).toEqual(["a"]);
    expect(next.get("a")).toEqual({ firstFailure: before.firstFailure, lastFailure: now, runs: 2 });
  });

  it("forgets a source that read cleanly or left the catalog", () => {
    const { next } = planRun(
      [source("a", true)],
      new Map([
        ["a", entry(1000)],
        ["gone", entry(1000)],
      ]),
      now,
    );
    expect(next.size).toBe(0);
  });

  it("treats a failure remembered longer ago than the maximum age as a new one", () => {
    const { next, mayOpen } = planRun([source("a", false)], new Map([["a", entry(PENDING_MAX_AGE_MS + 1000, 5)]]), now);
    expect(mayOpen.size).toBe(0);
    expect(next.get("a")).toEqual({ firstFailure: now, lastFailure: now, runs: 1 });
  });

  it("still counts a failure remembered exactly at the maximum age", () => {
    const { mayOpen } = planRun([source("a", false)], new Map([["a", entry(PENDING_MAX_AGE_MS)]]), now);
    expect(mayOpen.has("a")).toBe(true);
  });
});

describe("failure memory", () => {
  it("round-trips through the issue body", () => {
    const state = new Map<string, Pending>([
      ["a", { firstFailure: "2026-10-02T10:00:00.000Z", lastFailure: "2026-10-02T11:00:00.000Z", runs: 2 }],
    ]);
    expect(parseState(renderState(state))).toEqual(state);
    expect(parseState(renderState(state).replaceAll("\n", "\r\n"))).toEqual(state);
  });

  it("reads anything unusable as no memory, and skips malformed entries", () => {
    expect(parseState(undefined).size).toBe(0);
    expect(parseState("no code block").size).toBe(0);
    expect(parseState("```json\nnot json\n```").size).toBe(0);
    expect(parseState("```json\n[1]\n```").size).toBe(0);
    const body =
      '```json\n{"bad":{"firstFailure":"x","lastFailure":"y","runs":1},"zero":{"firstFailure":"2026-10-02T10:00:00Z","lastFailure":"2026-10-02T10:00:00Z","runs":0},"__proto__":null,"ok":{"firstFailure":"2026-10-02T10:00:00Z","lastFailure":"2026-10-02T10:00:00Z","runs":3}}\n```';
    expect([...parseState(body).keys()]).toEqual(["ok"]);
  });
});

describe("retryDelayMs", () => {
  const fail = (kind: "http" | "timeout" | "network" | "parser"): Result => ({
    ...broken,
    failure: { kind, message: "x" },
  });

  it("waits the short delay after the first attempt", () => {
    expect(retryDelayMs(1, [fail("timeout")], 20, 90)).toBe(20);
  });

  it("waits the long delay after later attempts while a source times out or cannot connect", () => {
    expect(retryDelayMs(2, [fail("timeout")], 20, 90)).toBe(90);
    expect(retryDelayMs(2, [fail("parser"), fail("network")], 20, 90)).toBe(90);
  });

  it("keeps the short delay for failures that waiting does not clear", () => {
    expect(retryDelayMs(2, [fail("parser"), fail("http")], 20, 90)).toBe(20);
  });
});

const notReady: ReadyzResult = {
  url: "https://status.example.com/readyz",
  ok: false,
  status: 503,
  detail: '{"status":"stale","ageSeconds":900}',
  attempts: 3,
};
const ready: ReadyzResult = { ...notReady, ok: true, status: 200, detail: '{"status":"ready"}', attempts: 1 };

describe("deploy-health issue sync", () => {
  it("opens one deploy-health issue while /readyz fails, then updates it", async () => {
    await syncDeployHealth(notReady);
    await syncDeployHealth({ ...notReady, status: 0, detail: "fetch failed" });
    expect(issues).toHaveLength(1);
    expect(issues[0].labels).toEqual(["deploy-health"]);
    expect(issues[0].title).toBe("Production deployment is not ready");
    expect(issues[0].body).toContain("no answer");
    expect(issues[0].body).toContain("fetch failed");
    expect(comments).toHaveLength(0);
  });

  it("closes it with a comment once /readyz answers 200", async () => {
    await syncDeployHealth(notReady);
    await syncDeployHealth(ready);
    expect(issues[0].state).toBe("closed");
    expect(comments[0].body).toContain("Recovered");
  });

  it("leaves collector issues alone", async () => {
    await syncIssues([broken]);
    await syncIssues([broken]);
    await syncDeployHealth(ready);
    expect(sourceIssues()).toHaveLength(1);
    expect(sourceIssues()[0].state).toBe("open");
  });

  it("opens on the first failure, with no second run needed", async () => {
    await syncDeployHealth(notReady);
    expect(issues).toHaveLength(1);
    expect(issues[0].state).toBe("open");
  });
});

describe("probeReadyz", () => {
  let readyz: Server;
  let base = "";
  let answers: number[] = [];
  let requests = 0;

  beforeAll(async () => {
    readyz = createServer((req, res) => {
      requests += 1;
      const status = answers.shift() ?? 200;
      res.writeHead(req.url === "/board/readyz" ? status : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: status === 200 ? "ready" : "stale" }));
    });
    await new Promise<void>((resolve) => readyz.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(readyz.address() as AddressInfo).port}/board`;
  });

  afterAll(() => new Promise<void>((resolve) => readyz.close(() => resolve())));

  beforeEach(() => {
    answers = [];
    requests = 0;
  });

  it("is healthy on a 200, resolving readyz under a base path", async () => {
    await expect(probeReadyz(base, 3, 0)).resolves.toMatchObject({
      ok: true,
      status: 200,
      attempts: 1,
      url: `${base}/readyz`,
    });
  });

  it("retries a 503 and reports the answer that ended it", async () => {
    answers = [503, 200];
    await expect(probeReadyz(`${base}/`, 3, 0)).resolves.toMatchObject({ ok: true, attempts: 2 });
    answers = [503, 503, 503];
    await expect(probeReadyz(base, 3, 0)).resolves.toMatchObject({
      ok: false,
      status: 503,
      attempts: 3,
      detail: '{"status":"stale"}',
    });
  });

  it("reports status 0 when nothing answers", async () => {
    const result = await probeReadyz("http://127.0.0.1:1", 1, 0);
    expect(result).toMatchObject({ ok: false, status: 0, attempts: 1 });
    expect(result.detail).not.toBe("");
    expect(requests).toBe(0);
  });
});

describe("source-health --record", () => {
  it("files each response under its host and path, keeping queries and trailing slashes apart", () => {
    const at = (url: string) => relative("rec", recordPath("rec", new URL(url)));
    expect(at("https://upgrade.mikrotik.com/routeros/NEWESTa7.stable")).toBe(
      join("upgrade.mikrotik.com", "routeros", "NEWESTa7.stable"),
    );
    expect(at("https://store.steampowered.com/api/featured/")).toBe(
      join("store.steampowered.com", "api", "featured", "index"),
    );
    expect(at("https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=730")).toBe(
      join("api.steampowered.com", "ISteamApps", "GetSDRConfig", "v1", "index_appid_730"),
    );
    expect(at("https://status.x.ai/")).toBe(join("status.x.ai", "index"));
  });

  it("never writes outside the recording directory", () => {
    const file = recordPath("rec", new URL("https://example.com/a/%2e%2e/%2E%2E/..%2f..%2fetc/passwd"));
    expect(relative("rec", file).startsWith("..")).toBe(false);
  });

  it("saves the exact bytes a collector received and hands it an unread response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "record-"));
    const body = new Uint8Array([0xff, 0xfe, 0x5b, 0x00, 0x5d, 0x00]); // "[]" as UTF-16LE with a BOM
    vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
    const stop = recordResponses(dir);
    try {
      const response = await fetch("https://health.aws.amazon.com/public/currentevents");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
    expect(new Uint8Array(readFileSync(join(dir, "health.aws.amazon.com", "public", "currentevents")))).toEqual(body);
    rmSync(dir, { recursive: true, force: true });
  });

  it("files the final body of a redirected request under the path that was asked for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "record-"));
    vi.stubGlobal("fetch", async (input: string) => {
      if (input === "https://upgrade.mikrotik.com/routeros/NEWESTa7.stable") {
        return new Response(null, { status: 302, headers: { location: "https://download.mikrotik.com/routeros/N" } });
      }
      return new Response("7.16 1700000000", { status: 200 });
    });
    const stop = recordResponses(dir);
    try {
      const hop = await fetch("https://upgrade.mikrotik.com/routeros/NEWESTa7.stable", { redirect: "manual" });
      expect(hop.status).toBe(302);
      await fetch("https://download.mikrotik.com/routeros/N", { redirect: "manual" });
    } finally {
      stop();
      vi.unstubAllGlobals();
    }
    expect(readFileSync(join(dir, "upgrade.mikrotik.com", "routeros", "NEWESTa7.stable"), "utf8")).toBe(
      "7.16 1700000000",
    );
    expect(existsSync(join(dir, "download.mikrotik.com"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a file name within file system limits", () => {
    const file = recordPath("rec", new URL(`https://example.com/${"a".repeat(300)}`));
    expect(file.split(/[\\/]/).every((segment) => segment.length <= 200)).toBe(true);
  });

  it("still hands the collector its response when the file cannot be saved", async () => {
    // A regular file where a directory must go: mkdir fails with ENOTDIR.
    const dir = mkdtempSync(join(tmpdir(), "record-"));
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));
    const stop = recordResponses(blocked);
    try {
      const response = await fetch("https://status.x.ai/feed.xml");
      expect(await response.text()).toBe("ok");
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("record: could not save"));
    } finally {
      stop();
      vi.unstubAllGlobals();
      errors.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
