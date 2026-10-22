import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");

/** The text of the step with this id, from its `id:` line to the next step. */
function stepBlock(id: string): string {
  const start = DEPLOY.search(new RegExp(`^ +id: ${id}\\n`, "m"));
  expect(start, `step ${id}`).toBeGreaterThanOrEqual(0);
  const rest = DEPLOY.slice(start);
  const end = rest.search(/^ {6}- /m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The `run: |` script of the step with this id, without its indentation. */
function stepScript(id: string): string {
  const run = stepBlock(id).match(/^( +)run: \|\n((?:\1 {2}.*\n|\n)+)/m);
  expect(run, `run script of ${id}`).not.toBeNull();
  const indent = `${run?.[1] ?? ""}  `;
  return (run?.[2] ?? "")
    .split("\n")
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join("\n");
}

/** The `if:` condition of the step with this id. */
function stepCondition(id: string): string {
  const condition = stepBlock(id).match(/^ +if: (.+)$/m);
  expect(condition, `if: of ${id}`).not.toBeNull();
  return condition?.[1] ?? "";
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs a step's script as Actions runs a step with no `shell:` (bash -e), with only PATH and GITHUB_OUTPUT set. */
function runStep(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-workflow-"));
  dirs.push(dir);
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const script = join(dir, "step.sh");
  writeFileSync(script, stepScript(id));
  const result = spawnSync("bash", ["-e", script], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_OUTPUT: output },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: readFileSync(output, "utf8") };
}

describe("deploy.yml: the smoke-test URL", () => {
  it("is the environment's DEPLOY_URL and nothing else", () => {
    // The public hostnames sit behind the zone's protection, which can answer
    // GitHub's runners 403 while the Worker is healthy: neither production's
    // Custom Domain nor the preview URL wrangler prints is a fallback.
    const assignments = [...DEPLOY.matchAll(/^ +DEPLOY_URL: (.+)$/gm)].map((match) => match[1]);
    expect(assignments.length).toBeGreaterThanOrEqual(2);
    for (const value of assignments) expect(value).toMatch(/^\$\{\{ vars\.DEPLOY_URL \}\}$/);
    for (const fallback of [
      "production_url",
      "production-url",
      "PRODUCTION_URL",
      "PREVIEW_URL",
      "steps.preview.outputs.url",
      "steps.target.outputs.url",
    ]) {
      expect(DEPLOY).not.toContain(fallback);
    }
  });

  it("is smoke-tested only when DEPLOY_URL is set, within the step's own time limit", () => {
    expect(stepCondition("smoke-test")).toBe("vars.DEPLOY_URL != ''");
    expect(stepBlock("smoke-test")).toMatch(/^ +timeout-minutes: \d+$/m);
  });
});

describe("deploy.yml: No DEPLOY_URL set", () => {
  it("runs only when DEPLOY_URL is unset", () => {
    expect(stepCondition("no-deploy-url")).toBe("vars.DEPLOY_URL == ''");
  });

  it("warns once, says why, and leaves the job going", () => {
    const result = runStep("no-deploy-url");
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const [warning] = lines;
    expect(warning).toMatch(/^::warning::/);
    expect(warning).toContain("no DEPLOY_URL variable");
    expect(warning).toContain("not smoke-tested");
    expect(warning).toContain("not rolled back");
    expect(warning).toContain("403");
    expect(warning).toContain("CONTRIBUTING.md#deploying");
  });
});

describe("deploy.yml: Roll back the failed deployment", () => {
  it("also rolls back production when the run is cancelled after the deploy but before the smoke test starts", () => {
    const condition = stepCondition("rollback");
    // A smoke test that never started is skipped, and a cancelled run skips it: the deploy is live and untested.
    expect(condition).toContain("steps.deploy.outputs.version_id != ''");
    expect(condition).toMatch(/cancelled\(\) && steps\.smoke-test\.outcome == 'skipped'/);
    expect(condition).toContain("steps.smoke-test.outcome == 'failure'");
    expect(condition).toContain("steps.smoke-test.outcome == 'cancelled'");
    expect(condition).toContain("needs.build.outputs.environment == 'production'");
  });

  it("never rolls back a deploy that has no DEPLOY_URL to smoke-test", () => {
    // Without it the smoke test is skipped by design, so a cancelled run must
    // not read that skip as an untested deploy and roll a healthy release back.
    expect(stepCondition("rollback")).toMatch(/^\(failure\(\) \|\| cancelled\(\)\) && vars\.DEPLOY_URL != '' && /);
  });
});
