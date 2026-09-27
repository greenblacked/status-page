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
// or an odd character becomes `_`, and `.`/`..` can never walk upwards.
function safeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_");
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
export function recordResponses(dir: string): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await realFetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const file = recordPath(dir, url);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, new Uint8Array(await response.clone().arrayBuffer()));
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
  if (!value) throw new Error(`${name} is required with --issues`);
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
    const labels = [LABEL, `source:${result.id}`];
    const open = (
      await github<Issue[]>("GET", `/repos/${repo}/issues?state=open&per_page=10&labels=${encodeURIComponent(labels.join(","))}`)
    ).filter((issue) => !issue.pull_request);
    const existing = open[0];

    if (!result.ok && !existing) {
      const created = await github<Issue>("POST", `/repos/${repo}/issues`, {
        title: `Collector failure: ${result.name}`,
        body: issueBody(result, now, now),
        labels,
      });
      console.log(`opened #${created.number} for ${result.id}`);
    } else if (!result.ok && existing) {
      // Edit the body instead of commenting, so an hourly outage is one issue,
      // not a thread of identical comments.
      await github("PATCH", `/repos/${repo}/issues/${existing.number}`, {
        body: issueBody(result, existing.created_at, now),
      });
      console.log(`updated #${existing.number} for ${result.id}`);
    } else if (result.ok && existing) {
      await github("POST", `/repos/${repo}/issues/${existing.number}/comments`, {
        body: `✅ Recovered: **${result.name}** read cleanly at ${now} (${result.latencyMs}ms). ${runUrl()}`,
      });
      await github("PATCH", `/repos/${repo}/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
      console.log(`closed #${existing.number} for ${result.id}`);
    }
  }
}

// ------------------------------------------------------------------ main ---

async function main(): Promise<number> {
  const withIssues = process.argv.includes("--issues");
  const recordAt = process.argv.indexOf("--record");
  const recordDir = recordAt === -1 ? undefined : process.argv[recordAt + 1];
  if (recordAt !== -1 && (!recordDir || recordDir.startsWith("--"))) {
    console.error("usage: source-health.ts [--issues] [--record <dir>]");
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
