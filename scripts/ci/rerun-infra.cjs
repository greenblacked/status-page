// Infrastructure re-run, run by .github/workflows/rerun-infra.yml through
// actions/github-script. When a workflow run fails or is cancelled because the
// GitHub runner never started (or died) and not because of our code, it asks
// GitHub to re-run the failed jobs, once. Anything that failed in one of our
// own steps (a test, a build, a lint) is a real failure and stays red.
//
// It is a controller, not a build executor: it reads the API and makes one
// re-run request. It never runs code from the pull request.

// A run is looked at once: the re-run is attempt 2, and attempt 2 is never
// re-run again, so a real outage ends in a red run rather than a loop.
const FIRST_ATTEMPT = 1;
const RUN_CONCLUSIONS = new Set(["failure", "cancelled"]);
const PULL_REQUEST = "pull_request";
// Runs of a branch head, where an older commit must never replace a newer one.
const BRANCH_EVENTS = new Set(["push", "workflow_dispatch"]);
const BAD_JOB = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

// Only says the job's own verdict, so it is never the cause of anything: it
// fails whenever another job did. Matched by job name, and only once the step
// that sums the others up has run: an aggregator the runner starved is a lost
// job like any other, and it is the one required check.
const AGGREGATORS = new Map([["CI OK", "Check every job passed"]]);

// The runner, not our code, ended the job. These messages come from GitHub's
// annotations on the job, whatever step the runner was in.
const RUNNER_LOST = [
  /was not acquired by runner/i,
  /lost communication with the server/i,
  /the runner has received a shutdown signal/i,
];
// "The operation was canceled." is the runner's own wording when it drops a
// job before it starts. Any other annotation on a job with no step of ours
// (cancelled by a person, replaced by a higher priority request, refused by an
// environment protection rule or a spending limit) says something else
// ended it, so it is not a runner fault (see classify).
const CANCELED = /^the operation was canceled\.?$/i;
// A step that failed by its own exit code ran our code.
const OWN_EXIT = /process completed with exit code/i;

// Steps the runner adds around the workflow's own.
const RUNNER_STEP = /^(set up job|initialize containers|complete job|stop containers|post .*)$/i;

// True for the aggregate job once its own verdict step ran.
function isAggregate(job) {
  const step = AGGREGATORS.get(job.name);
  if (!step) return false;
  return (job.steps || []).some((s) => s.name === step && ["success", "failure"].includes(s.conclusion));
}

/**
 * Sorts one job of a failed run. Returns { kind, why }:
 *   ignore      the job did not fail or was cancelled
 *   aggregator  the job only sums up the others
 *   infra       the runner failed it before or apart from our code
 *   real        a step of ours failed, or the job was ended some other way
 *               (a person, a newer run, a protection rule, a spending limit)
 */
function classify(job, annotations = []) {
  if (!BAD_JOB.has(job.conclusion)) return { kind: "ignore", why: `${job.conclusion}` };
  if (isAggregate(job)) return { kind: "aggregator", why: "only sums up the other jobs" };

  const messages = annotations.map((a) => String(a.message || "")).filter(Boolean);
  const steps = job.steps || [];
  const failed = steps.find((s) => s.conclusion === "failure");
  const ran = steps.filter(
    (s) => !RUNNER_STEP.test(s.name) && ["success", "failure", "cancelled"].includes(s.conclusion),
  );

  if (failed && messages.some((m) => OWN_EXIT.test(m))) return { kind: "real", why: `step "${failed.name}" failed` };
  const lost = messages.find((m) => RUNNER_LOST.some((p) => p.test(m)));
  if (lost) return { kind: "infra", why: lost.split("\n")[0].slice(0, 160) };
  if (failed) return { kind: "real", why: `step "${failed.name}" failed` };
  if (ran.length === 0) {
    // Positive evidence only: nothing but the runner's own wording, or nothing.
    const other = messages.find((m) => !CANCELED.test(m.trim()));
    if (other) return { kind: "real", why: `ended before any step: ${other.split("\n")[0].slice(0, 160)}` };
    return { kind: "infra", why: messages.length > 0 ? "cancelled before any step ran" : "no step beyond setup ran" };
  }
  return { kind: "real", why: `ended after step "${ran[ran.length - 1].name}" without a runner fault` };
}

// Why a run is not even looked at, or undefined when it is.
function notEligible(run) {
  if (run.run_attempt !== FIRST_ATTEMPT) return `attempt ${run.run_attempt}: a re-run is not re-run again`;
  if (!RUN_CONCLUSIONS.has(run.conclusion)) return `run ${run.conclusion}: nothing to re-run`;
  return undefined;
}

/**
 * Decides whether a finished run is re-run. `jobs` are the run's latest jobs,
 * `annotations` maps a job id to its annotations. Returns { rerun, reason, jobs }.
 */
function decide({ run, jobs, annotations = {} }) {
  const skip = notEligible(run);
  if (skip) return { rerun: false, reason: skip, jobs: [] };
  const sorted = jobs
    .map((job) => ({ name: job.name, ...classify(job, annotations[job.id]) }))
    .filter((job) => job.kind !== "ignore");
  const causes = sorted.filter((job) => job.kind !== "aggregator");
  if (causes.length === 0) return { rerun: false, reason: "no failed job to explain", jobs: sorted };
  const real = causes.filter((job) => job.kind === "real");
  if (real.length > 0) {
    return { rerun: false, reason: `${real.length} job(s) failed in our own steps: ${real[0].name}`, jobs: sorted };
  }
  return { rerun: true, reason: `${causes.length} job(s) lost to the runner`, jobs: sorted };
}

// True when `other` is a run for the pull request that `run` ran for. GitHub
// lists the pull requests of a run in pull_requests[], but leaves it empty for
// a pull request from a fork. There the head repository and branch name the
// pull request instead: the head commit cannot, because a newer push to the
// same pull request is exactly the run that replaces this one.
function samePullRequest(run, other) {
  if (other.event !== PULL_REQUEST) return false;
  const numbers = (run.pull_requests || []).map((pr) => pr.number);
  if (numbers.length > 0) return (other.pull_requests || []).some((pr) => numbers.includes(pr.number));
  return other.head_branch === run.head_branch && other.head_repository?.full_name === run.head_repository?.full_name;
}

// A run that a newer one replaced (a pull request run is cancelled for it, a
// queued deploy is dropped for it) looks just like a starved one. Re-running it
// would fight the newer run, or deploy an older commit over a newer one.
//  - A pull request run is replaced only by a newer pull request run of the same
//    workflow for the same pull request. A dispatched or push run of the branch
//    never shows on the pull request or satisfies its required checks, so it
//    replaces nothing there.
//  - A push or dispatched run is replaced by any newer run of the same workflow
//    on the same branch, whatever started it: release.yml dispatches Deploy by
//    hand over a queued push run. It is also left alone once its commit is no
//    longer the branch head.
async function isSuperseded(github, owner, repo, run) {
  const forPullRequest = run.event === PULL_REQUEST;
  const { data } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: run.workflow_id,
    branch: run.head_branch,
    ...(forPullRequest ? { event: PULL_REQUEST } : {}),
    per_page: 20,
  });
  const newer = data.workflow_runs.filter((other) => other.run_number > run.run_number);
  if (forPullRequest) return newer.some((other) => samePullRequest(run, other)) ? "a newer run exists" : undefined;
  if (newer.length > 0) return "a newer run exists";
  if (!BRANCH_EVENTS.has(run.event)) return undefined;
  try {
    const { data: branch } = await github.rest.repos.getBranch({ owner, repo, branch: run.head_branch });
    if (branch.commit.sha !== run.head_sha) return "its commit is no longer the branch head";
  } catch (error) {
    if (error.status === 404) return "its branch is gone";
    throw error;
  }
  return undefined;
}

async function rerunInfra({ github, context, core }) {
  const { owner, repo } = context.repo;
  const run = context.payload.workflow_run;
  const label = `${run.name} #${run.run_number}`;

  // Cheap checks first: most completed runs are green or already a re-run.
  const skip = notEligible(run);
  if (skip) return core.info(`${label}: ${skip}.`);

  const superseded = await isSuperseded(github, owner, repo, run);
  if (superseded) return core.info(`${label}: ${superseded}; leaving it.`);

  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  const annotations = {};
  for (const job of jobs) {
    if (!BAD_JOB.has(job.conclusion) || isAggregate(job)) continue;
    annotations[job.id] = await github.paginate(github.rest.checks.listAnnotations, {
      owner,
      repo,
      check_run_id: job.id,
      per_page: 100,
    });
  }

  const verdict = decide({ run, jobs, annotations });
  for (const job of verdict.jobs) core.info(`  ${job.kind.padEnd(10)} ${job.name}: ${job.why}`);
  if (!verdict.rerun) return core.info(`${label}: not re-run, ${verdict.reason}.`);

  await github.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: run.id });
  core.info(`${label}: failed jobs re-run once, ${verdict.reason}.`);
}

module.exports = { rerunInfra, decide, classify, notEligible };
