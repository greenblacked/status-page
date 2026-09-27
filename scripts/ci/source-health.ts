// Live canary for the vendor collectors: monitoring of the monitoring.
//
// PR CI never touches the network, so nothing there notices when a vendor
// changes a payload shape. This runs the real collectors, retries anything
// that fails, and, with --issues, keeps exactly one GitHub issue open per
// broken source, closing it again when the source reads cleanly.
//
// Local:  node --experimental-strip-types scripts/ci/source-health.ts
//         (exits 1 when any source fails)
// CI:     ... scripts/ci/source-health.ts --issues
//         (per-source failures become issues; the job fails only when the
//          runner itself looks broken, i.e. most sources fail at once)
//         ... scripts/ci/source-health.ts --deploy-health
//         (checks $PRODUCTION_URL/readyz and keeps one `deploy-health`
//          issue open while it is not 200; only a notice when
//          PRODUCTION_URL is unset)
// Record: ... scripts/ci/source-health.ts --record <dir>
//         (also saves every vendor response as <dir>/<host>/<path>, to
//          refresh src/lib/status/__fixtures__ from)

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectAllServices } from "../../src/lib/status/sources.server.ts";
import type { ServiceSnapshot, SourceFailure } from "../../src/lib/status/types.ts";

const ATTEMPTS = Number(process.env.SOURCE_HEALTH_ATTEMPTS ?? 3);
const RETRY_DELAY_MS = Number(process.env.SOURCE_HEALTH_RETRY_MS ?? 20_000);
// When this share of sources fails together, the runner's network is a far
// likelier cause than a dozen vendors breaking in the same hour. Opening a
// dozen issues would be noise, so fail the job instead.
const MASS_FAILURE_RATIO = 0.5;
const LABEL = "source-health";

export type Result = {
  id: string;
  name: string;
  ok: boolean;
  latencyMs: number;
  attempts: number;
  failure?: SourceFailure;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(): Promise<Result[]> {
  const results = new Map<string, Result>();
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const snapshots: ServiceSnapshot[] = await collectAllServices();
    for (const snapshot of snapshots) {
      const previous = results.get(snapshot.id);
      if (previous?.ok) continue;
      results.set(snapshot.id, {
        id: snapshot.id,
        name: snapshot.name,
        ok: !snapshot.failure,
        latencyMs: snapshot.latencyMs,
        attempts: attempt,
        failure: snapshot.failure,
      });
    }
    const stillFailing = [...results.values()].filter((result) => !result.ok);
    if (stillFailing.length === 0 || attempt === ATTEMPTS) break;
    console.log(
      `attempt ${attempt}: ${stillFailing.map((r) => r.id).join(", ")} failed; retrying in ${RETRY_DELAY_MS / 1000}s`,
    );
    await sleep(RETRY_DELAY_MS);
  }
  return [...results.values()];
}

function describe(result: Result): string {
  if (result.ok) return "";
  const failure = result.failure;
  if (!failure) return "unknown failure";
  return failure.status ? `${failure.kind} ${failure.status}` : failure.kind;
}

function renderTable(results: Result[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  return results
    .map((r) => `${r.name.padEnd(width)}  ${r.ok ? "OK  " : "FAIL"}  ${`${r.latencyMs}ms`.padStart(7)}  ${describe(r)}`)
    .join("\n");
}

function renderSummary(results: Result[]): string {
  const rows = results.map((r) => {
    const detail = r.ok ? "" : `${describe(r)}: ${inline(r.failure?.message ?? "")}`;
    return `| ${r.name} | ${r.ok ? "✅ OK" : "❌ FAIL"} | ${r.latencyMs}ms | ${r.attempts} | ${detail} |`;
  });
  return [
    "### Source health",
    "",
    "| Source | Result | Latency | Attempts | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

// Error text lands inside Markdown code spans and table cells.
function inline(text: string): string {
  return text.replace(/[`|\r\n]+/g, " ").slice(0, 300);
}

// ------------------------------------------------------------- recording ---

// One path segment, safe on any file system: a query such as `?appid=730`
// or an odd character becomes `_`, `.`/`..` can never walk upwards, and
// no segment outgrows the usual 255-byte file name limit.
function safeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return /^\.+$/.test(cleaned) ? cleaned.replace(/\./g, "_") : cleaned;
}

/** Where `--record` keeps the response for `url`: `<dir>/<host>/<path>`. */
export function recordPath(dir: string, url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean).map(safeSegment);
  if (url.pathname.endsWith("/") || segments.length === 0) segments.push("index");
  if (url.search) segments.push(`${segments.pop()}${safeSegment(url.search)}`);
  return join(dir, safeSegment(url.host), ...segments);
}

// Wraps fetch rather than the collectors, so sources.server.ts stays as it
// is and the files hold exactly the bytes a collector was sent (AWS's UTF-16
// included). A later attempt overwrites an earlier one. Returns the undo.
// A file that cannot be saved is reported and skipped: thrown from inside
// fetch, it would count as that vendor's network failure, and with
// --issues open an issue against every vendor for a local disk problem.
export function recordResponses(dir: string): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await realFetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const file = recordPath(dir, url);
    try {
      const body = new Uint8Array(await response.clone().arrayBuffer());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    } catch (error) {
      console.error(`record: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return response;
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

// ---------------------------------------------------------------- GitHub ---

type Issue = { number: number; created_at: string; pull_request?: unknown };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to open or close GitHub issues`);
  return value;
}

async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Actions sets GITHUB_API_URL; it also lets the tests point at a fake.
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} -> ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function runUrl(): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`;
}

function issueBody(result: Result, firstFailure: string, now: string): string {
  const failure = result.failure;
  const parserNote =
    failure?.kind === "parser"
      ? "A **parser** failure means the vendor answered, but the payload no longer matches what the collector in `src/lib/status/sources.server.ts` expects. That needs a code change."
      : "`http`, `timeout` and `network` failures are often on the vendor's side and clear by themselves. If this stays open for hours, check whether the official endpoint moved.";
  return [
    `<!-- source-health:${result.id} -->`,
    `The scheduled source-health check could not read the official status source for **${result.name}** in ${result.attempts} consecutive attempts.`,
    "",
    "| | |",
    "| --- | --- |",
    `| Failure kind | \`${failure?.kind ?? "unknown"}\` |`,
    `| HTTP status | ${failure?.status ?? "—"} |`,
    `| Error | \`${inline(failure?.message ?? "none recorded")}\` |`,
    `| First failure | ${firstFailure} |`,
    `| Latest failure | ${now} |`,
    `| Latest run | ${runUrl()} |`,
    "",
    parserNote,
    "",
    "This issue is maintained by `.github/workflows/source-health.yml`. It updates on each failing run and closes itself when the source reads cleanly again.",
  ].join("\n");
}

export async function syncIssues(results: Result[]): Promise<void> {
  const repo = env("GITHUB_REPOSITORY");
  const now = new Date().toISOString();
  for (const result of results) {
    await syncOneIssue(
      repo,
      {
        id: result.id,
        labels: [LABEL, `source:${result.id}`],
        title: `Collector failure: ${result.name}`,
        failing: !result.ok,
        body: (firstFailure, at) => issueBody(result, firstFailure, at),
        recovered: (at) =>
          `✅ Recovered: **${result.name}** read cleanly at ${at} (${result.latencyMs}ms). ${runUrl()}`,
      },
      now,
    );
  }
}

// One issue per problem, found by its labels: opened on the first failure,
// its body rewritten on each later one (so an hourly outage is one issue,
// not a thread of identical comments), and closed with a comment once the
// check passes again. Shared by the per-collector issues above and the
// deployment check below.
type IssueSpec = {
  /** Named in the log lines. */
  id: string;
  labels: string[];
  title: string;
  failing: boolean;
  body: (firstFailure: string, now: string) => string;
  recovered: (now: string) => string;
};

async function syncOneIssue(repo: string, spec: IssueSpec, now: string): Promise<void> {
  const open = (
    await github<Issue[]>(
      "GET",
      `/repos/${repo}/issues?state=open&per_page=10&labels=${encodeURIComponent(spec.labels.join(","))}`,
    )
  ).filter((issue) => !issue.pull_request);
  const existing = open[0];

  if (spec.failing && !existing) {
    const created = await github<Issue>("POST", `/repos/${repo}/issues`, {
      title: spec.title,
      body: spec.body(now, now),
      labels: spec.labels,
    });
    console.log(`opened #${created.number} for ${spec.id}`);
  } else if (spec.failing && existing) {
    await github("PATCH", `/repos/${repo}/issues/${existing.number}`, { body: spec.body(existing.created_at, now) });
    console.log(`updated #${existing.number} for ${spec.id}`);
  } else if (!spec.failing && existing) {
    await github("POST", `/repos/${repo}/issues/${existing.number}/comments`, { body: spec.recovered(now) });
    await github("PATCH", `/repos/${repo}/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
    console.log(`closed #${existing.number} for ${spec.id}`);
  }
}

// ------------------------------------------------------- deploy health ---

// The deployed board's view of itself. Every collector above can read
// cleanly from a runner while production serves an old snapshot (a stopped
// Cron Trigger, a KV outage) or cannot reach the vendors from Cloudflare;
// /readyz (src/routes/readyz.ts) is what says so.
const DEPLOY_LABEL = "deploy-health";
const READYZ_TIMEOUT_MS = 15_000;

export type ReadyzResult = {
  url: string;
  ok: boolean;
  /** HTTP status, or 0 when nothing answered. */
  status: number;
  /** The response body or the network error, trimmed for an issue. */
  detail: string;
  attempts: number;
};

/**
 * Fetches <baseUrl>/readyz, retrying a failure the way the collectors are
 * retried, so one dropped connection does not open an issue. Only a 200
 * counts as healthy: /readyz answers 503 for a stale or all-Unknown board.
 */
export async function probeReadyz(
  baseUrl: string,
  attempts: number = ATTEMPTS,
  delayMs: number = RETRY_DELAY_MS,
): Promise<ReadyzResult> {
  const url = new URL("readyz", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
  let result: ReadyzResult = { url, ok: false, status: 0, detail: "not checked", attempts: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(READYZ_TIMEOUT_MS),
      });
      const text = await response.text();
      result = { url, ok: response.status === 200, status: response.status, detail: inline(text), attempts: attempt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { url, ok: false, status: 0, detail: inline(message), attempts: attempt };
    }
    if (result.ok || attempt === attempts) break;
    console.log(`attempt ${attempt}: ${url} answered ${result.status || "nothing"}; retrying in ${delayMs / 1000}s`);
    await sleep(delayMs);
  }
  return result;
}

function deployIssueBody(result: ReadyzResult, firstFailure: string, now: string): string {
  const answer = result.status ? `HTTP ${result.status}` : "no answer";
  return [
    `<!-- ${DEPLOY_LABEL} -->`,
    `The scheduled check of the production deployment got **${answer}** from \`${result.url}\` in ${result.attempts} consecutive attempts; a healthy board answers 200.`,
    "",
    "| | |",
    "| --- | --- |",
    `| HTTP status | ${result.status || "—"} |`,
    `| Response | \`${result.detail || "empty"}\` |`,
    `| First failure | ${firstFailure} |`,
    `| Latest failure | ${now} |`,
    `| Latest run | ${runUrl()} |`,
    "",
    '`"status":"stale"` means the snapshot is over ten minutes old: check the Worker\'s cron events and the `sweep_failed` lines in Workers Logs. `"status":"blind"` means no vendor could be read from Cloudflare. No answer, or any other status, means the deployment itself is down; CONTRIBUTING.md#deploying has the rollback steps.',
    "",
    "This issue is maintained by `.github/workflows/source-health.yml`. It updates on each failing run and closes itself when `/readyz` answers 200 again.",
  ].join("\n");
}

export async function syncDeployHealth(result: ReadyzResult): Promise<void> {
  await syncOneIssue(
    env("GITHUB_REPOSITORY"),
    {
      id: DEPLOY_LABEL,
      labels: [DEPLOY_LABEL],
      title: "Production deployment is not ready",
      failing: !result.ok,
      body: (firstFailure, at) => deployIssueBody(result, firstFailure, at),
      recovered: (at) => `✅ Recovered: \`${result.url}\` answered 200 at ${at}. ${runUrl()}`,
    },
    new Date().toISOString(),
  );
}

async function deployHealth(): Promise<number> {
  const base = process.env.PRODUCTION_URL ?? "";
  if (!base) {
    console.log(
      "::notice::PRODUCTION_URL is not set, so the production deployment is not checked (CONTRIBUTING.md#deploying)",
    );
    return 0;
  }
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    console.error("::error::PRODUCTION_URL is not a URL");
    return 1;
  }
  if (parsed.protocol !== "https:") {
    console.error("::error::PRODUCTION_URL must be an https:// URL");
    return 1;
  }
  const result = await probeReadyz(parsed.href);
  console.log(`${result.url}: ${result.status || "no answer"} ${result.detail}`);
  await syncDeployHealth(result);
  return 0;
}

// ------------------------------------------------------------------ main ---

async function main(): Promise<number> {
  if (process.argv.includes("--deploy-health")) return deployHealth();
  const withIssues = process.argv.includes("--issues");
  const recordAt = process.argv.indexOf("--record");
  const recordDir = recordAt === -1 ? undefined : process.argv[recordAt + 1];
  if (recordAt !== -1 && (!recordDir || recordDir.startsWith("--"))) {
    console.error("usage: source-health.ts [--issues] [--record <dir>] | --deploy-health");
    return 2;
  }
  // Only the vendor sweep is recorded, never the GitHub calls after it.
  const stopRecording = recordDir ? recordResponses(recordDir) : undefined;
  let results: Result[];
  try {
    results = await probe();
  } finally {
    stopRecording?.();
  }
  if (recordDir) console.log(`recorded vendor responses under ${recordDir}`);
  const failures = results.filter((r) => !r.ok);

  console.log(renderTable(results));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(results));

  const massFailure = results.length > 2 && failures.length >= Math.ceil(results.length * MASS_FAILURE_RATIO);
  if (massFailure) {
    console.error(
      `::error::${failures.length} of ${results.length} sources failed at once. That points at the runner's network, not at the vendors, so no issues were opened or closed.`,
    );
    return 1;
  }

  if (!withIssues) return failures.length > 0 ? 1 : 0;
  await syncIssues(results);
  return 0;
}

// Run only when executed directly, so the tests can import syncIssues.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
