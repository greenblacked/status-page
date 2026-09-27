import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { probeReadyz, syncDeployHealth, syncIssues, type ReadyzResult, type Result } from "./source-health.ts";

// A fake of the three GitHub issue endpoints the script uses, so the
// open/update/close flow is tested before it ever runs against the real API.
type FakeIssue = { number: number; state: string; labels: string[]; title: string; body: string; created_at: string };
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
      return send(200, issues.filter((i) => i.state === url.searchParams.get("state") && wanted.every((l) => i.labels.includes(l))));
    }
    if (req.method === "POST" && url.pathname.endsWith("/issues")) {
      const body = await readJson(req);
      const issue = { number: issues.length + 1, state: "open", created_at: "2026-09-23T00:00:00Z", ...body } as FakeIssue;
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
  failure: { kind: "parser", message: "SyntaxError: Unexpected token '<'" },
};
const healthy: Result = { ...broken, ok: true, failure: undefined };

describe("source-health issue sync", () => {
  it("opens one labelled issue for a failing source, then updates it instead of opening another", async () => {
    await syncIssues([broken]);
    await syncIssues([broken]);
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe("Collector failure: Apple");
    expect(issues[0].labels).toEqual(["source-health", "source:apple"]);
    expect(issues[0].body).toContain("`parser`");
    expect(issues[0].body).toContain("/owner/repo/actions/runs/42");
    expect(comments).toHaveLength(0);
  });

  it("comments and closes the issue once the source recovers", async () => {
    await syncIssues([broken]);
    await syncIssues([healthy]);
    expect(issues[0].state).toBe("closed");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Recovered");
  });

  it("does nothing for a healthy source with no open issue", async () => {
    await syncIssues([healthy]);
    expect(issues).toHaveLength(0);
    expect(comments).toHaveLength(0);
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
    await syncDeployHealth(ready);
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
    await expect(probeReadyz(base, 3, 0)).resolves.toMatchObject({ ok: true, status: 200, attempts: 1, url: `${base}/readyz` });
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
