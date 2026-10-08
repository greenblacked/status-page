import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The text of one top-level job in a workflow file (up to the next job). */
function job(workflow: string, name: string): string {
  const start = workflow.search(new RegExp(`^ {2}${name}:\\n`, "m"));
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\n/m);
  return next < 0 ? rest : rest.slice(0, next);
}

// A push to dev is checked by what a pull request into stage runs, so the checks do not wait for
// that pull request to be opened.
describe("a push to dev runs the checks a pull request into stage runs", () => {
  const deploy = read(".github/workflows/deploy.yml");
  const ci = read(".github/workflows/ci.yml");
  const review = read(".github/workflows/dependency-review.yml");

  it("builds and dry-runs the deploy for dev, and never deploys it", () => {
    expect(deploy).toMatch(/^ {2}push:\n {4}branches: \[main, stage, dev\]$/m);
    expect(job(deploy, "dry-run")).toMatch(
      /if: github\.event_name == 'pull_request' \|\| \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev'\)/,
    );
    // The deploy job runs only for an environment the build job picked, and never picks one for dev.
    expect(job(deploy, "deploy")).toMatch(
      /if: needs\.build\.outputs\.environment == 'production' \|\| needs\.build\.outputs\.environment == 'staging'/,
    );
    expect(job(deploy, "deploy")).not.toMatch(/event_name != 'pull_request'/);
    const pick = job(deploy, "build");
    expect(pick).toMatch(/dev\)\n\s+\[ "\$EVENT" = push \]/);
    expect(pick).toMatch(/dev\)\n[^\n]*\n\s+echo "environment=none"/);
    expect(pick).not.toMatch(/dev\) echo "environment=(production|staging)"/);
  });

  it("keeps a push to dev out of the stage and main deploy groups", () => {
    expect(deploy).toMatch(/group: deploy-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref_name \}\}/);
    expect(deploy).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });

  it("checks dev's commits against stage, and the branch name for pull requests only", () => {
    const commits = job(ci, "commits");
    expect(commits).toMatch(
      /if: github\.event_name == 'pull_request' \|\| \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev'\)/,
    );
    expect(commits).toMatch(
      /BASE_REF: \$\{\{ github\.event_name == 'pull_request' && github\.base_ref \|\| 'stage' \}\}/,
    );
    expect(job(ci, "branch")).toMatch(/if: github\.event_name == 'pull_request'\n/);
  });

  it("reviews dev's dependency changes against stage", () => {
    expect(review).toMatch(/^ {2}push:\n {4}branches: \[dev\]$/m);
    expect(review).toMatch(/git merge-base origin\/stage "\$PUSH_SHA"/);
    expect(review).toMatch(/base-ref: \$\{\{ steps\.range\.outputs\.base \}\}/);
    expect(review).toMatch(/head-ref: \$\{\{ steps\.range\.outputs\.head \}\}/);
    expect(review).toMatch(/fail-on-severity:\s*high\b/);
  });

  it("never skips dependency review: any non-200 from the graph API fails the job", () => {
    expect(review).not.toMatch(/available=false|Dependency review skipped|steps\.graph/);
    expect(review).toMatch(/if \[ "\$status" != "200" \]; then[\s\S]*?exit 1\n\s+fi/);
    expect(review).toMatch(/settings\/security_analysis/);
  });

  it("leaves the PR title check and the triage comment to pull requests", () => {
    expect(read(".github/workflows/pr-title.yml")).not.toMatch(/^ {2}push:/m);
    expect(read(".github/workflows/ci-triage.yml")).toMatch(/if: github\.event\.workflow_run\.event == 'pull_request'/);
  });

  it("documents the PR-only title and branch name checks consistently in CONTRIBUTING.md", () => {
    const contributing = read("CONTRIBUTING.md");
    expect(contributing).not.toMatch(/Only the pull request title check has no push form/);
    expect(contributing).toMatch(/all of CI except the branch name check/);
    expect(contributing).toMatch(/title and branch name checks have no push form/);
  });
});
