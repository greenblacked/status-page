import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");

/** The `run: |` script of the step with this id, without its indentation. */
function stepScript(id: string): string {
  const start = DEPLOY.search(new RegExp(`^ +id: ${id}\\n`, "m"));
  expect(start, `step ${id}`).toBeGreaterThanOrEqual(0);
  const rest = DEPLOY.slice(start);
  const run = rest.match(/^( +)run: \|\n((?:\1 {2}.*\n|\n)+)/m);
  expect(run, `run script of ${id}`).not.toBeNull();
  const indent = `${run?.[1] ?? ""}  `;
  return (run?.[2] ?? "")
    .split("\n")
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join("\n");
}

/** The `if:` condition of the step with this id. */
function stepCondition(id: string): string {
  const start = DEPLOY.search(new RegExp(`^ +id: ${id}\\n`, "m"));
  expect(start, `step ${id}`).toBeGreaterThanOrEqual(0);
  const rest = DEPLOY.slice(start);
  const end = rest.search(/^ {6}- /m);
  const condition = (end < 0 ? rest : rest.slice(0, end)).match(/^ +if: (.+)$/m);
  expect(condition, `if: of ${id}`).not.toBeNull();
  return condition?.[1] ?? "";
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the "Read the production URL" step as Actions runs a step with no `shell:` (bash -e) on a built config. */
function readProductionUrl(config: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-workflow-"));
  dirs.push(dir);
  mkdirSync(join(dir, "dist/server"), { recursive: true });
  writeFileSync(join(dir, "dist/server/wrangler.json"), JSON.stringify(config));
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const script = join(dir, "step.sh");
  writeFileSync(script, stepScript("production-url"));
  const result = spawnSync("bash", ["-e", script], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_OUTPUT: output },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: readFileSync(output, "utf8") };
}

describe("deploy.yml: Read the production URL", () => {
  it("takes the Custom Domain of an object route", () => {
    const result = readProductionUrl({ routes: [{ pattern: "status.example.com", custom_domain: true }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("url=https://status.example.com\n");
  });

  it.each([
    ["a string route", { routes: ["status.example.com/*"] }],
    ["an object route with a path", { routes: [{ pattern: "status.example.com/*", zone_name: "example.com" }] }],
    ["no route", {}],
  ])("only warns for %s, and leaves the build going", (_name, config) => {
    const result = readProductionUrl(config);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^::warning::the first route in dist\/server\/wrangler\.json is not a plain host/);
    expect(result.output).toBe("");
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
});
