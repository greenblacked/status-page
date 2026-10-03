// Live canary for the vendor collectors: monitoring of the monitoring.
//
// PR CI never touches the network, so nothing there notices when a vendor
// changes a payload shape. This runs the real collectors, retries anything
// that fails, and, with --issues, keeps exactly one GitHub issue open per
// broken source, closing it again when the source reads cleanly.
//
// It probes two kinds of source, reported apart: every card's health collector
// ("GitLab.com") and each vendor's release or changelog feed ("GitLab releases",
// id "gitlab-releases"), which only adds a quiet line to a card and never decides
// its health. The feeds are read directly here, never from the board's cache.
//
// A source gets an issue only after it has failed in two consecutive runs
// (CONSECUTIVE_RUNS): vendor status pages time out from the runner for an
// hour now and then, and an issue that opens and closes itself is noise. The
// first failing run is remembered in a closed `source-health-state` issue
// (see findStateIssue / parseState / saveState), so no new permission or
// infrastructure is needed. The issue's label is created on first use and its
// body marker is the fallback lookup, so the streak survives a missing label.
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
import { probeReleaseFeeds, type ReleaseFeedResult } from "../../src/lib/status/release-feeds.server.ts";
import { collectAllServices } from "../../src/lib/status/sources.server.ts";
import type { ServiceSnapshot, SourceFailure } from "../../src/lib/status/types.ts";

const ATTEMPTS = Number(process.env.SOURCE_HEALTH_ATTEMPTS ?? 3);
const RETRY_DELAY_MS = Number(process.env.SOURCE_HEALTH_RETRY_MS ?? 20_000);
// A timeout or a network error is the failure that clears on its own, but
// not within 20 seconds: from the third attempt on, wait this long instead.
// The waits start when an attempt ends, and a timed-out attempt takes about 9s,
// so the attempts begin near 0s, 29s and 128s: about two minutes of trouble.
const SLOW_RETRY_MS = Number(process.env.SOURCE_HEALTH_SLOW_RETRY_MS ?? 90_000);
// A source must fail in this many consecutive runs before it gets an issue.
export const CONSECUTIVE_RUNS = 2;
// A run closer than this to the last counted one (a manual re-run minutes
// after a scheduled run) does not count as another run: it would bring back
// the open-then-close noise the two-run rule is there to stop.
export const MIN_RUN_GAP_MS = 30 * 60 * 1000;
// A remembered failure older than this is stale: the next failure starts a
// new streak. Scheduled runs are hours apart (GitHub delays the hourly cron:
// gaps of 4 to 9 hours were seen), so this is generous; a clean run ends a
// streak anyway, the age only guards against very old entries.
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
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

/** A release feed's reading as a row of the report, apart from its card: "GitLab releases", id "gitlab-releases". */
export function releaseFeedResult(read: ReleaseFeedResult, attempt: number): Result {
  return {
    id: `${read.id}-releases`,
    name: read.label,
    ok: read.ok,
    latencyMs: read.latencyMs,
    attempts: attempt,
    failure: read.failure,
  };
}

/**
 * How long to wait after a failed attempt: RETRY_DELAY_MS after the first
 * one, and SLOW_RETRY_MS after any later one while a failing source timed
 * out or could not connect. A parser or HTTP error does not clear by
 * waiting longer, so those keep the short delay.
 */
export function retryDelayMs(
  attempt: number,
  failing: Result[],
  fastMs: number = RETRY_DELAY_MS,
  slowMs: number = SLOW_RETRY_MS,
): number {
  const transient = failing.some((r) => r.failure?.kind === "timeout" || r.failure?.kind === "network");
  return transient && attempt >= 2 ? slowMs : fastMs;
}

async function probe(): Promise<Result[]> {
  const results = new Map<string, Result>();
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const [snapshots, feeds]: [ServiceSnapshot[], ReleaseFeedResult[]] = await Promise.all([
      collectAllServices(),
      probeReleaseFeeds(),
    ]);
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
    for (const read of feeds) {
      const result = releaseFeedResult(read, attempt);
      if (!results.get(result.id)?.ok) results.set(result.id, result);
    }
    const stillFailing = [...results.values()].filter((result) => !result.ok);
    if (stillFailing.length === 0 || attempt === ATTEMPTS) break;
    const delayMs = retryDelayMs(attempt, stillFailing);
    console.log(
      `attempt ${attempt}: ${stillFailing.map((r) => r.id).join(", ")} failed; retrying in ${delayMs / 1000}s`,
    );
    await sleep(delayMs);
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
  // fetchText follows redirects by hand, so a moved resource is several
  // fetches: the 3xx answers (no body worth keeping), then the final one.
  // The file belongs under the path the collector asked for, as it did when
  // fetch followed redirects itself, so each hop remembers who asked.
  const askedFor = new Map<string, URL>();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await realFetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const requested = askedFor.get(url.href) ?? url;
    askedFor.delete(url.href);
    const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get("location") : null;
    if (location !== null) {
      try {
        askedFor.set(new URL(location, url).href, requested);
      } catch {
        // An unusable Location is refused by the caller; there is no next hop to file.
      }
      return response;
    }
    const file = recordPath(dir, requested);
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

type Issue = {
  number: number;
  state?: string;
  labels?: ({ name?: string } | string)[];
  created_at: string;
  body?: string | null;
  pull_request?: unknown;
  title?: string;
  user?: { login?: string; type?: string } | null;
};

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

function issueBody(result: Result, runs: number, firstFailure: string, now: string): string {
  const failure = result.failure;
  const release = result.id.endsWith("-releases");
  const parserNote =
    failure?.kind === "parser"
      ? `A **parser** failure means the vendor answered, but the payload no longer matches what the ${release ? "release feed reader in `src/lib/status/release-feeds.server.ts`" : "collector in `src/lib/status/sources.server.ts`"} expects. That needs a code change.${release ? " The card keeps its health and shows no release line meanwhile." : ""}`
      : "`http`, `timeout` and `network` failures are often on the vendor's side and clear by themselves. If this stays open for hours, check whether the official endpoint moved.";
  return [
    `<!-- source-health:${result.id} -->`,
    `The scheduled source-health check could not read the official ${release ? "release feed" : "status source"} for **${result.name}** in ${runs} consecutive ${runs === 1 ? "run" : "runs"}, and in ${result.attempts === 1 ? "its single attempt" : `all ${result.attempts} attempts`} of the latest one.`,
    "",
    "| | |",
    "| --- | --- |",
    `| Failure kind | \`${failure?.kind ?? "unknown"}\` |`,
    `| HTTP status | ${failure?.status ?? "—"} |`,
    `| Error | \`${inline(failure?.message ?? "none recorded")}\` |`,
    `| First failure | ${firstFailure} |`,
    `| Latest failure | ${now} |`,
    `| Failing runs in a row | ${runs} |`,
    `| Latest run | ${runUrl()} |`,
    "",
    parserNote,
    "",
    `This issue is maintained by \`.github/workflows/source-health.yml\`. It opens only after the source has failed in ${CONSECUTIVE_RUNS} consecutive runs, updates on each failing run and closes itself when the source reads cleanly again.`,
  ].join("\n");
}

// ----------------------------------------------------- failing-run state ---

// What a run remembers about a source that is failing but has no issue yet.
export type Pending = {
  /** The first run of this streak of failures. */
  firstFailure: string;
  /** The latest failing run. */
  lastFailure: string;
  /** How many consecutive runs have failed. */
  runs: number;
};

/**
 * Decides, from this run's results and what earlier runs remembered, which
 * failing sources may now get an issue. Pure, so the rule is tested without
 * GitHub. `next` is what to remember for the next run: one entry per source
 * failing now, none for a source that read cleanly (its streak is over). A
 * source missing from this run (another branch's catalog) keeps its entry
 * until it ages out.
 *
 * A remembered failure older than PENDING_MAX_AGE_MS starts a new streak, and
 * a run less than MIN_RUN_GAP_MS after the last counted one is not counted.
 * `open` holds the run count stated by each source's open issue: an issue
 * that is open means the streak is alive whatever the memory says (an issue
 * from before this rule, a memory that went stale), so the count continues
 * from it.
 */
export function planRun(
  results: Result[],
  previous: ReadonlyMap<string, Pending>,
  now: string,
  open: ReadonlyMap<string, number> = new Map(),
): { next: Map<string, Pending>; mayOpen: ReadonlySet<string> } {
  const next = new Map<string, Pending>();
  const mayOpen = new Set<string>();
  const age = (entry: Pending) => Date.parse(now) - Date.parse(entry.lastFailure);
  // A remembered time later than this run is wrong (a hand-edited body, or
  // clocks that disagree). Left alone it would give a negative age and hold
  // the streak inside the minimum gap for good, so it is clamped to now.
  const clamp = (entry: Pending): Pending => {
    const last = Math.min(Date.parse(entry.lastFailure), Date.parse(now));
    const first = Math.min(Date.parse(entry.firstFailure), last);
    return { ...entry, firstFailure: new Date(first).toISOString(), lastFailure: new Date(last).toISOString() };
  };
  const remembered = new Map([...previous].map(([id, entry]) => [id, clamp(entry)]));
  const seen = new Set(results.map((result) => result.id));
  for (const [id, entry] of remembered) {
    if (!seen.has(id) && age(entry) <= PENDING_MAX_AGE_MS) next.set(id, entry);
  }
  for (const result of results) {
    if (result.ok) continue;
    const before = remembered.get(result.id);
    const fresh = before !== undefined && age(before) <= PENDING_MAX_AGE_MS;
    const known = Math.max(fresh ? before.runs : 0, open.get(result.id) ?? 0);
    if (fresh && age(before) < MIN_RUN_GAP_MS) {
      next.set(result.id, { ...before, runs: known });
    } else {
      next.set(result.id, { firstFailure: fresh ? before.firstFailure : now, lastFailure: now, runs: known + 1 });
    }
    if ((next.get(result.id)?.runs ?? 0) >= CONSECUTIVE_RUNS) mayOpen.add(result.id);
  }
  return { next, mayOpen };
}

// The memory lives in one issue labelled `source-health-state`, kept closed
// so it never shows among the open ones. Its body carries the entries as JSON
// in a code block. Issues are the one thing this job may already write, so
// the workflow needs no new permission and nothing else to run or store.
// The label is created through the API before it is first used, and the issue
// can also be found by the marker in its body (STATE_MARKER), so a label that
// is missing or was dropped can never lose the streak.
const STATE_LABEL = "source-health-state";
const STATE_MARKER = `<!-- ${STATE_LABEL} -->`;
const STATE_TITLE = "Source health: failures awaiting a second run";
const STATE_INTRO = `${STATE_MARKER}
Bookkeeping for \`.github/workflows/source-health.yml\`, kept closed on purpose: a source that fails once is noted here, and gets its own issue only if the next run fails too. Do not edit by hand.`;

export function renderState(state: ReadonlyMap<string, Pending>): string {
  const json = JSON.stringify(Object.fromEntries(state), null, 2);
  return `${STATE_INTRO}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/** Reads the entries back; anything unreadable counts as no memory. */
export function parseState(body: string | null | undefined): Map<string, Pending> {
  const state = new Map<string, Pending>();
  const json = body?.match(/```json\r?\n([\s\S]*?)\r?\n```/)?.[1];
  if (!json) return state;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return state;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return state;
  for (const [id, value] of Object.entries(parsed)) {
    const entry = value as Partial<Pending> | null;
    if (
      typeof entry?.firstFailure === "string" &&
      typeof entry.lastFailure === "string" &&
      Number.isFinite(Date.parse(entry.firstFailure)) &&
      Number.isFinite(Date.parse(entry.lastFailure)) &&
      Number.isInteger(entry.runs) &&
      (entry.runs as number) > 0
    ) {
      state.set(id, { firstFailure: entry.firstFailure, lastFailure: entry.lastFailure, runs: entry.runs as number });
    }
  }
  return state;
}

/** The pages of closed issues the marker fallback reads at most (100 each). */
const STATE_SCAN_PAGES = 3;

/** The login the workflow's own token acts as (github.token). */
const STATE_AUTHOR = "github-actions[bot]";

/**
 * Only an issue this job wrote is the memory: authored by the workflow's bot,
 * with the exact title and a body that opens with the marker. A marker quoted
 * in someone else's issue, or planted in one, is never adopted (its body would
 * be rewritten, its labels replaced and the issue closed).
 */
const isStateIssue = (issue: Issue) =>
  !issue.pull_request &&
  issue.user?.login === STATE_AUTHOR &&
  issue.title === STATE_TITLE &&
  (issue.body ?? "").startsWith(STATE_MARKER);

async function findStateIssue(repo: string): Promise<Issue | undefined> {
  const labelled = await github<Issue[]>(
    "GET",
    `/repos/${repo}/issues?state=all&per_page=10&labels=${encodeURIComponent(STATE_LABEL)}`,
  );
  const byLabel = labelled.find(isStateIssue);
  if (byLabel) return byLabel;
  // No labelled issue: the label may never have been created or applied, so
  // look for the marker in the body. Both lookups are bounded and best effort.
  try {
    const query = encodeURIComponent(`repo:${repo} is:issue in:body author:app/github-actions ${STATE_LABEL}`);
    const found = await github<{ items?: Issue[] }>("GET", `/search/issues?q=${query}&per_page=30`);
    const hit = found.items?.find(isStateIssue);
    if (hit) return hit;
  } catch (error) {
    console.warn(`State issue search failed, scanning closed issues: ${(error as Error).message}`);
  }
  try {
    for (let page = 1; page <= STATE_SCAN_PAGES; page++) {
      const closed = await github<Issue[]>(
        "GET",
        `/repos/${repo}/issues?state=closed&per_page=100&sort=created&direction=asc&page=${page}`,
      );
      const hit = closed.find(isStateIssue);
      if (hit) return hit;
      if (closed.length < 100) break;
    }
  } catch (error) {
    console.warn(`State issue scan failed, starting without memory: ${(error as Error).message}`);
  }
  return undefined;
}

/**
 * Makes sure the state label exists before an issue is given it, and says
 * whether it does. An existing label (422 already_exists) counts. On any
 * other failure the label is left off the issue, because GitHub may reject an
 * unknown label outright; the issue is still created and found again by its
 * marker.
 */
async function ensureStateLabel(repo: string): Promise<boolean> {
  try {
    await github("POST", `/repos/${repo}/labels`, {
      name: STATE_LABEL,
      color: "ededed",
      description: "Bookkeeping for the source-health workflow",
    });
    return true;
  } catch (error) {
    const message = (error as Error).message;
    if (/-> 422:/.test(message) && message.includes("already_exists")) return true;
    console.warn(`Could not create the ${STATE_LABEL} label: ${message}`);
    return false;
  }
}

const hasStateLabel = (issue: Issue) =>
  (issue.labels ?? []).some((label) => (typeof label === "string" ? label : label.name) === STATE_LABEL);

async function saveState(repo: string, issue: Issue | undefined, state: ReadonlyMap<string, Pending>): Promise<void> {
  const body = renderState(state);
  if (issue) {
    // An issue found only by its marker gets the label back.
    const relabel = hasStateLabel(issue) || !(await ensureStateLabel(repo)) ? {} : { labels: [STATE_LABEL] };
    // An issue left open by an earlier failed close is closed again here.
    if (issue.state === "open") {
      await github("PATCH", `/repos/${repo}/issues/${issue.number}`, {
        body,
        state: "closed",
        state_reason: "not_planned",
        ...relabel,
      });
    } else if (issue.body !== body || relabel.labels) {
      await github("PATCH", `/repos/${repo}/issues/${issue.number}`, { body, ...relabel });
    }
  } else if (state.size > 0) {
    const labels = (await ensureStateLabel(repo)) ? { labels: [STATE_LABEL] } : {};
    const created = await github<Issue>("POST", `/repos/${repo}/issues`, { title: STATE_TITLE, body, ...labels });
    await github("PATCH", `/repos/${repo}/issues/${created.number}`, { state: "closed", state_reason: "not_planned" });
  }
}

/** The run count each open source issue states, by source id. */
async function openRunCounts(repo: string): Promise<Map<string, number>> {
  const open = await github<Issue[]>(
    "GET",
    `/repos/${repo}/issues?state=open&per_page=100&labels=${encodeURIComponent(LABEL)}`,
  );
  const counts = new Map<string, number>();
  for (const issue of open) {
    if (issue.pull_request) continue;
    const id = issue.body?.match(/<!-- source-health:(\S+) -->/)?.[1];
    if (!id) continue;
    const runs = Number(issue.body?.match(/\| Failing runs in a row \| (\d+) \|/)?.[1]);
    counts.set(id, Number.isInteger(runs) && runs > 0 ? runs : 1);
  }
  return counts;
}

export async function syncIssues(results: Result[]): Promise<void> {
  const repo = env("GITHUB_REPOSITORY");
  const now = new Date().toISOString();
  const stateIssue = await findStateIssue(repo);
  const { next, mayOpen } = planRun(results, parseState(stateIssue?.body), now, await openRunCounts(repo));
  // Remember the streaks first: if an issue call below fails, this run still
  // counts and the next one opens what is due.
  await saveState(repo, stateIssue, next);
  for (const result of results) {
    const pending = next.get(result.id);
    await syncOneIssue(
      repo,
      {
        id: result.id,
        labels: [LABEL, `source:${result.id}`],
        title: `Collector failure: ${result.name}`,
        failing: !result.ok,
        mayOpen: mayOpen.has(result.id),
        since: pending?.firstFailure,
        body: (firstFailure, at) => issueBody(result, pending?.runs ?? 1, firstFailure, at),
        recovered: (at) =>
          `✅ Recovered: **${result.name}** read cleanly at ${at} (${result.latencyMs}ms). ${runUrl()}`,
      },
      now,
    );
  }
}

// One issue per problem, found by its labels: opened on the first failure
// (a collector's, on the second consecutive failing run: see planRun), its
// body rewritten on each later one (so an hourly outage is one issue, not a
// thread of identical comments), and closed with a comment once the check
// passes again. Shared by the per-collector issues above and the deployment
// check below.
type IssueSpec = {
  /** Named in the log lines. */
  id: string;
  labels: string[];
  title: string;
  failing: boolean;
  /** False holds a failing check back from opening an issue (default true). */
  mayOpen?: boolean;
  /** When the failure began, if that is earlier than the issue itself. */
  since?: string;
  body: (firstFailure: string, now: string) => string;
  recovered: (now: string) => string;
};

const earliest = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);

async function syncOneIssue(repo: string, spec: IssueSpec, now: string): Promise<void> {
  const open = (
    await github<Issue[]>(
      "GET",
      `/repos/${repo}/issues?state=open&per_page=10&labels=${encodeURIComponent(spec.labels.join(","))}`,
    )
  ).filter((issue) => !issue.pull_request);
  const existing = open[0];

  if (spec.failing && !existing && spec.mayOpen === false) {
    console.log(`${spec.id} failed; no issue until it fails in ${CONSECUTIVE_RUNS} consecutive runs`);
  } else if (spec.failing && !existing) {
    const created = await github<Issue>("POST", `/repos/${repo}/issues`, {
      title: spec.title,
      body: spec.body(spec.since ?? now, now),
      labels: spec.labels,
    });
    console.log(`opened #${created.number} for ${spec.id}`);
  } else if (spec.failing && existing) {
    const first = spec.since ? earliest(spec.since, existing.created_at) : existing.created_at;
    await github("PATCH", `/repos/${repo}/issues/${existing.number}`, { body: spec.body(first, now) });
    console.log(`updated #${existing.number} for ${spec.id}`);
  } else if (!spec.failing && existing) {
    await github("POST", `/repos/${repo}/issues/${existing.number}/comments`, { body: spec.recovered(now) });
    await github("PATCH", `/repos/${repo}/issues/${existing.number}`, { state: "closed", state_reason: "completed" });
    console.log(`closed #${existing.number} for ${spec.id}`);
  }
}

// ------------------------------------------------------- deploy health ---

// The deployed board's view of itself. Every collector above can read
// cleanly from a runner while production cannot reach the vendors from
// Cloudflare, or serves a board whose timestamp is too old;
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
    '`"status":"blind"` means no vendor could be read from Cloudflare: check the `collector_failed` lines in Workers Logs. `"status":"stale"` should not occur with on-request collection; if it does, check the isolate\'s clock and the `board_unavailable` lines in Workers Logs. No answer, or any other status, means the deployment itself is down; CONTRIBUTING.md#deploying has the rollback steps.',
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
      `::error::${failures.length} of ${results.length} sources failed at once. That points at the runner's network, not at the vendors, so no issues were opened or closed and the remembered failures are unchanged.`,
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
