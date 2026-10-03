// CI triage bot, run by .github/workflows/ci-triage.yml through
// actions/github-script. It is a controller, not a build executor: it only
// reads the GitHub API and writes one PR comment and one label. It never runs
// code from the pull request.
//
// Each run rebuilds the whole picture from the API for the PR's current head
// commit, rather than trusting the single workflow_run event that woke it.
// GitHub keeps at most one pending run per concurrency group and cancels the
// rest, so an event can be dropped; recomputing everything makes any surviving
// run correct.

const WATCHED = ["CI", "CodeQL", "Dependency review"];
const MARKER = "<!-- status-bar-ci-triage -->";
const LABEL = "ci-failed";
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
// Only these count as passing. cancelled, action_required (a fork run waiting
// for approval) and stale say nothing about the code, so they hold the
// previous verdict instead of declaring recovery.
const PASSED = new Set(["success", "neutral", "skipped"]);

// Job and step names come from workflow files in the PR head, so a fork
// controls them. Keep them inside code spans (no mentions, no links) and short.
// Inside a table cell a bare | ends the cell even within a code span, which
// would let a name break out of the span. Escaping | alone is not enough:
// "\|" would become "\\|", an escaped backslash followed by a bare pipe. So
// backslashes and pipes are escaped together, in one pass.
function code(text) {
  const safe = String(text)
    .replace(/[`\r\n]+/g, " ")
    .slice(0, 120)
    .replace(/[\\|]/g, (ch) => `\\${ch}`);
  return `\`${safe}\``;
}

function categorize(workflow, _jobName, stepName) {
  const step = (stepName || "").toLowerCase();
  if (!stepName) return "infrastructure: the job failed without a failing step (timeout, cancellation or runner loss)";
  if (workflow === "CodeQL") return "code scanning";
  if (workflow === "Dependency review") {
    return step.includes("availability")
      ? "dependency graph API: token or API problem"
      : "dependency review: a high or critical vulnerability, or a disallowed change";
  }
  // Step names from ci.yml. A failure inside .github/actions/setup shows
  // as its step in the job, "Set up the toolchain (pnpm install)".
  const rules = [
    [/initialize containers/, "infrastructure"],
    [
      /check the browser/,
      "browser build missing: the Playwright image and @playwright/test differ, or the install failed",
    ],
    [/set up job|checkout|setup-node|download-artifact|upload-artifact|post /, "infrastructure"],
    [/pin pnpm|check pnpm|pnpm pin|declared toolchain/, "toolchain version"],
    [/pnpm install|verify registry signatures/, "dependency install, toolchain version or registry signature check"],
    [/biome/, "lint or formatting: run `pnpm run lint:fix`"],
    [/typecheck/, "type error"],
    [/pnpm (run )?test/, "unit test failure, or coverage under its threshold"],
    [/playwright/, "browser test failure: the playwright-report artifact has traces"],
    [/pnpm run build/, "build"],
    [/smoke/, "SSR smoke test: the built app did not serve"],
    [/hygiene/, "repository hygiene"],
    [/documentation links/, "broken documentation link"],
    [/changelog/, "CHANGELOG.md has no section for the package.json version"],
    [/shell scripts/, "shellcheck"],
    [/conventional commits/, "commit message format"],
    [/branch naming/, "branch name"],
    [/actionlint/, "workflow syntax"],
    [/zizmor/, "workflow security"],
    [/every job passed/, "a required job above failed"],
  ];
  for (const [pattern, label] of rules) if (pattern.test(step)) return label;
  return "unclassified";
}

async function findPullRequest(github, owner, repo, run) {
  if (run.pull_requests && run.pull_requests.length > 0) return run.pull_requests[0].number;
  const { data: byCommit } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: run.head_sha,
  });
  const open = byCommit.find((pr) => pr.state === "open");
  if (open) return open.number;
  // Fork PRs leave workflow_run.pull_requests empty; match on the head branch.
  if (run.head_repository) {
    const { data } = await github.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${run.head_repository.owner.login}:${run.head_branch}`,
    });
    if (data.length > 0) return data[0].number;
  }
  return undefined;
}

async function latestRuns(github, owner, repo, headSha) {
  const { data } = await github.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: headSha,
    event: "pull_request",
    per_page: 100,
  });
  const latest = new Map();
  for (const run of data.workflow_runs) {
    if (!WATCHED.includes(run.name)) continue;
    const previous = latest.get(run.name);
    if (!previous || run.run_number > previous.run_number) latest.set(run.name, run);
  }
  return latest;
}

async function describeFailure(github, owner, repo, run) {
  const { data } = await github.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  const failures = [];
  for (const job of data.jobs) {
    if (!FAILED.has(job.conclusion)) continue;
    const step = (job.steps || []).find((s) => FAILED.has(s.conclusion));
    failures.push({
      job: job.name,
      step: step ? step.name : undefined,
      url: step ? `${job.html_url}#step:${step.number}:1` : job.html_url,
      category: categorize(run.name, job.name, step?.name),
    });
  }
  return failures;
}

function render(headSha, rows, failing) {
  const short = headSha.slice(0, 7);
  const lines = [MARKER];
  lines.push(
    failing ? `### ❌ CI failing on \`${short}\`` : `### ✅ Recovered: all watched workflows pass on \`${short}\``,
  );
  lines.push("", "| Workflow | Result |", "| --- | --- |");
  for (const row of rows) lines.push(`| ${row.workflow} | ${row.result} |`);
  lines.push(
    "",
    "<sub>Updated in place by `.github/workflows/ci-triage.yml`. It reads the GitHub API only and never runs code from this pull request.</sub>",
  );
  return lines.join("\n");
}

async function triage({ github, context, core }) {
  const { owner, repo } = context.repo;
  const trigger = context.payload.workflow_run;

  const number = await findPullRequest(github, owner, repo, trigger);
  if (!number) return core.info(`No open pull request for ${trigger.head_sha}; nothing to do.`);

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.state !== "open") return core.info(`#${number} is ${pr.state}; nothing to do.`);
  if (pr.head.sha !== trigger.head_sha) {
    return core.info(`#${number} has moved on to ${pr.head.sha}; ignoring the result for ${trigger.head_sha}.`);
  }

  const runs = await latestRuns(github, owner, repo, pr.head.sha);
  const rows = [];
  let failing = false;
  let pending = false;
  for (const workflow of WATCHED) {
    const run = runs.get(workflow);
    if (!run) continue;
    if (run.status !== "completed") {
      pending = true;
      rows.push({ workflow, result: `⏳ ${run.status} · [run](${run.html_url})` });
    } else if (FAILED.has(run.conclusion)) {
      failing = true;
      const failures = await describeFailure(github, owner, repo, run);
      const detail = failures.length
        ? failures
            .map((f) => `${code(f.job)}${f.step ? ` → ${code(f.step)}` : ""}: ${f.category} · [logs](${f.url})`)
            .join("<br>")
        : `${run.conclusion} · [run](${run.html_url})`;
      rows.push({ workflow, result: `❌ ${detail}` });
    } else if (PASSED.has(run.conclusion)) {
      rows.push({ workflow, result: `✅ ${run.conclusion} · [run](${run.html_url})` });
    } else {
      pending = true;
      rows.push({ workflow, result: `⚪ ${run.conclusion}: no verdict · [run](${run.html_url})` });
    }
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  const existing = comments.find((c) => c.user && c.user.type === "Bot" && (c.body || "").startsWith(MARKER));

  if (failing || existing) {
    // A green PR that never failed gets no comment at all. While a recovery
    // is still in flight, keep the red report rather than declaring success.
    if (!failing && pending) {
      core.info("No failures, but runs are still in flight; leaving the comment until they finish.");
    } else {
      const body = render(pr.head.sha, rows, failing);
      if (existing) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      else await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
    }
  }

  const labelled = (pr.labels || []).some((l) => l.name === LABEL);
  if (failing && !labelled) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [LABEL] });
  } else if (!failing && !pending && labelled) {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name: LABEL });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  core.info(`#${number}: ${failing ? "failing" : pending ? "pending" : "green"}`);
}

module.exports = { triage, categorize, MARKER, LABEL };
