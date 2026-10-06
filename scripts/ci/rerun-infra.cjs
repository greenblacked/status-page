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
const BAD_JOB = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

// Only says the job's own verdict, so it is never the cause of anything: it
// fails whenever another job did. Matched by job name.
const AGGREGATORS = new Set(["CI OK"]);

// The runner, not our code, ended the job. These messages come from GitHub's
// annotations on the job, whatever step the runner was in.
const RUNNER_LOST = [
  /was not acquired by runner/i,
  /lost communication with the server/i,
  /the runner has received a shutdown signal/i,
];
// "The operation was canceled." alone also reads on a job somebody cancelled,
// so it counts only where no step of ours ever ran (see classify).
const CANCELED = /^the operation was canceled\.?$/i;
// A step that failed by its own exit code ran our code.
const OWN_EXIT = /process completed with exit code/i;

// Steps the runner adds around the workflow's own.
const RUNNER_STEP = /^(set up job|initialize containers|complete job|stop containers|post .*)$/i;

/**
 * Sorts one job of a failed run. Returns { kind, why }:
 *   ignore      the job did not fail or was cancelled
 *   aggregator  the job only sums up the others
 *   infra       the runner failed it before or apart from our code
 *   real        a step of ours failed, or the job was ended some other way
 */
function classify(job, annotations = []) {
  if (!BAD_JOB.has(job.conclusion)) return { kind: "ignore", why: `${job.conclusion}` };
  if (AGGREGATORS.has(job.name)) return { kind: "aggregator", why: "only sums up the other jobs" };

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
    const canceled = messages.some((m) => CANCELED.test(m.trim()));
    return { kind: "infra", why: canceled ? "cancelled before any step ran" : "no step beyond setup ran" };
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

// A run that a newer push replaced (a pull request run is cancelled for it, a
// queued deploy is dropped for it) looks just like a starved one. Re-running it
// would fight the newer run, or deploy an older commit over a newer one.
async function isSuperseded(github, owner, repo, run) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: run.workflow_id,
    branch: run.head_branch,
    event: run.event,
    per_page: 20,
  });
  return data.workflow_runs.some((other) => other.run_number > run.run_number);
}

async function rerunInfra({ github, context, core }) {
  const { owner, repo } = context.repo;
  const run = context.payload.workflow_run;
  const label = `${run.name} #${run.run_number}`;

  // Cheap checks first: most completed runs are green or already a re-run.
  const skip = notEligible(run);
  if (skip) return core.info(`${label}: ${skip}.`);

  if (await isSuperseded(github, owner, repo, run)) return core.info(`${label}: a newer run exists; leaving it.`);

  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  const annotations = {};
  for (const job of jobs) {
    if (!BAD_JOB.has(job.conclusion) || AGGREGATORS.has(job.name)) continue;
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
