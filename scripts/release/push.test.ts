import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));
const PUSH = join(SCRIPTS, "release", "push.sh");
const EXPLAIN = join(SCRIPTS, "release", "explain-failure.sh");
const RELEASE_YML = fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url));

const PIPE = { stdio: "pipe", encoding: "utf8" } as const;
// What GitHub prints when a ruleset rejects a push from GitHub Actions.
const GH013 = [
  "error: GH013: Repository rule violations found for refs/heads/main.",
  "- Changes must be made through a pull request.",
  "- 2 of 2 required status checks are expected.",
].join("\n");

let root: string;
let remote: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, ...PIPE }).trim();
}

function clone(name: string): string {
  const dir = join(root, name);
  git(root, "clone", "--quiet", remote, dir);
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commit(dir: string, subject: string): string {
  git(dir, "commit", "--quiet", "--allow-empty", "-m", subject);
  return git(dir, "rev-parse", "HEAD");
}

// A pre-receive hook on the remote that rejects pushes to the refs matching
// `pattern` with `message`, the way a ruleset without a bypass actor does.
function rejectPushesTo(pattern: string, message: string): void {
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in\n    ${pattern})\n      cat >&2 <<'MSG'\n${message}\nMSG\n      exit 1 ;;\n  esac\ndone\n`,
  );
  chmodSync(hook, 0o755);
}

function push(branch: string, expected: string, cwd = work) {
  const result = spawnSync(PUSH, [branch, expected], { cwd, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "push-"));
  remote = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "commit.gpgsign", "false");
  commit(seed, "chore: start");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--quiet", "origin", "main");
  work = clone("work");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("push.sh", () => {
  it("pushes and exits 0", () => {
    const planned = git(work, "rev-parse", "HEAD");
    const next = commit(work, "release: 0.6.0");
    const result = push("main", planned);
    expect(result.status).toBe(0);
    expect(git(remote, "rev-parse", "main")).toBe(next);
  });

  it("exits 10 and prints no error when the branch really moved past the planned tip", () => {
    const planned = git(work, "rev-parse", "HEAD");
    const other = clone("other");
    commit(other, "fix: someone merged first");
    git(other, "push", "--quiet", "origin", "main");
    commit(work, "release: 0.6.0");
    const result = push("main", planned);
    expect(result.status).toBe(10);
    expect(result.output).not.toContain("::error::");
  });

  it("fails with the ruleset cause and the fix when a ruleset rejects the push and nothing moved", () => {
    rejectPushesTo("refs/heads/main", GH013);
    const planned = git(work, "rev-parse", "HEAD");
    commit(work, "release: 0.6.0");
    const result = push("main", planned);
    expect(result.status).toBe(1);
    expect(result.output).toContain("GH013");
    expect(result.output).toContain("::error::push to main: main's ruleset refused GitHub Actions' push");
    expect(result.output).toContain("nothing was released");
    expect(result.output).toContain(
      "./scripts/release/bump.sh <level|X.Y.Z> from an up-to-date main (it creates release/vX.Y.Z)",
    );
    expect(result.output).toContain("pull request into main (merge commit)");
    expect(result.output).toContain("CONTRIBUTING.md#releases");
    expect(result.output).not.toContain("integration 15368");
    expect(result.output).not.toContain("moved");
    expect(git(remote, "rev-parse", "main")).toBe(planned);
  });

  it("names the branch whose ruleset rejected the push", () => {
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/stage");
    rejectPushesTo("refs/heads/stage", GH013);
    const planned = git(work, "rev-parse", "HEAD");
    commit(work, "merge main");
    const result = push("stage", planned);
    expect(result.status).toBe(1);
    expect(result.output).toContain("push to stage: stage's ruleset refused GitHub Actions' push");
    expect(result.output).toContain("chore/sync-main");
  });

  it("fails with a generic error for any other rejection, still not reporting a move", () => {
    rejectPushesTo("refs/heads/main", "remote: the disk is full");
    const planned = git(work, "rev-parse", "HEAD");
    commit(work, "release: 0.6.0");
    const result = push("main", planned);
    expect(result.status).toBe(1);
    expect(result.output).toContain("::error::push to main failed for a reason other than a ruleset or a newer push");
    expect(result.output).not.toContain("GitHub Actions");
  });

  it("exits 0 when the server applied the push but the client saw an error", () => {
    const planned = git(work, "rev-parse", "HEAD");
    const next = commit(work, "release: 0.6.0");
    // A git that pushes for real and then reports a failure, like a dropped connection.
    const bin = join(root, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("sh", ["-c", "command -v git"], PIPE).trim();
    const wrapper = join(bin, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh\n"${realGit}" "$@"\nstatus=$?\n[ "$1" = push ] && [ "$status" = 0 ] && { echo "fatal: the remote end hung up unexpectedly" >&2; exit 128; }\nexit $status\n`,
    );
    chmodSync(wrapper, 0o755);
    const result = spawnSync(PUSH, ["main", planned], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("reported an error but landed");
    expect(git(remote, "rev-parse", "main")).toBe(next);
  });

  it("fails when the remote cannot be asked again, rather than guess", () => {
    const planned = git(work, "rev-parse", "HEAD");
    commit(work, "release: 0.6.0");
    git(work, "remote", "set-url", "origin", join(root, "gone.git"));
    const result = push("main", planned);
    expect(result.status).toBe(1);
    expect(result.output).toContain("could not be looked up");
  });
});

describe("explain-failure.sh", () => {
  const explain = (text: string) =>
    spawnSync(EXPLAIN, ["creating tag v0.6.0", "v0.6.0"], { input: text, encoding: "utf8" });

  it("recognizes a ruleset rejection from a tag creation", () => {
    const result = explain("gh: Repository rule violations found (HTTP 422)");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("creating tag v0.6.0: a ruleset refused GitHub Actions' request for v0.6.0");
  });

  it("points a refused push to main at bump.sh and a release pull request", () => {
    const result = spawnSync(EXPLAIN, ["push to main", "main"], {
      input: "error: GH013: Repository rule violations found for refs/heads/main.",
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release/vX.Y.Z");
    expect(result.stdout).toContain("only where the GitHub settings offer it");
  });

  it("does not treat other errors as a ruleset", () => {
    const result = explain("HTTP 500");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("refused GitHub Actions");
  });
});

// The sync-branches step of release.yml, run for real against a bare remote.
function syncScript(): string {
  const lines = readFileSync(RELEASE_YML, "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes("- name: Merge main into stage and dev"));
  const run = lines.findIndex((line, i) => i > start && line.trim() === "run: |");
  expect(run).toBeGreaterThan(start);
  const indent = lines[run + 1].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

describe("release.yml: merge main into stage and dev", () => {
  let runner: string;
  let output: string;

  function copyScripts(): void {
    for (const dir of ["scripts/ci", "scripts/release"]) mkdirSync(join(work, dir), { recursive: true });
    for (const file of [
      "ci/dev-paused",
      "ci/dev-paused.sh",
      "release/push.sh",
      "release/explain-failure.sh",
      "release/merge-changelog.sh",
    ]) {
      cpSync(join(SCRIPTS, file), join(work, "scripts", file));
    }
  }

  // main has a release commit that stage and dev lack; dev also holds a change
  // that conflicts with main's, as the paused dev did.
  function seedBranches(devPaused: boolean, dev: "conflict" | "clean" | "none" = "conflict"): void {
    copyScripts();
    writeFileSync(join(work, "scripts/ci/dev-paused"), `${devPaused}\n`);
    writeFileSync(join(work, "file.txt"), "base\n");
    git(work, "add", "-A");
    commit(work, "chore: scripts");
    git(work, "push", "--quiet", "origin", "main");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/stage");
    if (dev !== "none") git(work, "push", "--quiet", "origin", "HEAD:refs/heads/dev");

    writeFileSync(join(work, "file.txt"), "main\n");
    git(work, "commit", "--quiet", "-am", "release: 0.6.0");
    git(work, "push", "--quiet", "origin", "main");

    if (dev !== "none") {
      const devClone = clone("devclone");
      git(devClone, "switch", "--quiet", "dev");
      writeFileSync(join(devClone, dev === "conflict" ? "file.txt" : "dev.txt"), "dev\n");
      git(devClone, "add", "-A");
      git(devClone, "commit", "--quiet", "-m", "feat: dev only");
      git(devClone, "push", "--quiet", "origin", "dev");
    }
    git(work, "fetch", "--quiet", "origin");
  }

  // A CHANGELOG.md far enough apart that a release at its top and a line added
  // at its bottom merge cleanly. main is released (turns Unreleased into a
  // dated section); stage then changes the changelog, something else, or nothing.
  function seedChangelog(stage: "changelog" | "other" | "none"): void {
    copyScripts();
    const filler = Array.from({ length: 12 }, (_, i) => `- old ${i}`).join("\n");
    writeFileSync(join(work, "scripts/ci/dev-paused"), "true\n");
    writeFileSync(
      join(work, "CHANGELOG.md"),
      `# Changelog\n\n## [Unreleased]\n\n## [0.5.0] - 2026-01-01\n\n${filler}\n`,
    );
    git(work, "add", "-A");
    commit(work, "chore: scripts");
    git(work, "push", "--quiet", "origin", "main");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/stage");

    const released = `# Changelog\n\n## [Unreleased]\n\n## [0.6.0] - 2026-02-01\n\n- shipped\n\n## [0.5.0] - 2026-01-01\n\n${filler}\n`;
    writeFileSync(join(work, "CHANGELOG.md"), released);
    git(work, "commit", "--quiet", "-am", "release: 0.6.0");
    git(work, "push", "--quiet", "origin", "main");

    if (stage !== "none") {
      const stageClone = clone("stageclone");
      git(stageClone, "switch", "--quiet", "stage");
      if (stage === "changelog") {
        writeFileSync(
          join(stageClone, "CHANGELOG.md"),
          `# Changelog\n\n## [Unreleased]\n\n## [0.5.0] - 2026-01-01\n\n${filler}\n- stage only\n`,
        );
      } else {
        writeFileSync(join(stageClone, "stage.txt"), "stage\n");
      }
      git(stageClone, "add", "-A");
      git(stageClone, "commit", "--quiet", "-m", "feat: stage only");
      git(stageClone, "push", "--quiet", "origin", "stage");
    }
    git(work, "fetch", "--quiet", "origin");
  }

  function run() {
    const script = join(runner, "sync.sh");
    writeFileSync(script, syncScript());
    const { DEV_PAUSED: _unset, ...env } = process.env;
    const result = spawnSync("bash", ["-e", script], {
      cwd: work,
      encoding: "utf8",
      env: { ...env, ACTOR: "tester", ACTOR_ID: "1", RUNNER_TEMP: runner, GITHUB_OUTPUT: output },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, outputs: readFileSync(output, "utf8") };
  }

  const remoteTip = (branch: string) => git(remote, "rev-parse", branch);
  const containsMain = (branch: string) =>
    spawnSync("git", ["merge-base", "--is-ancestor", "main", branch], { cwd: remote }).status === 0;

  beforeEach(() => {
    runner = join(root, "runner");
    mkdirSync(runner);
    output = join(runner, "output");
    writeFileSync(output, "");
  });

  it("skips dev with a notice while it is paused, and still merges main into stage", () => {
    seedBranches(true);
    const devBefore = remoteTip("dev");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.output).toContain("::notice::dev is paused");
    expect(remoteTip("dev")).toBe(devBefore);
    expect(containsMain("stage")).toBe(true);
    expect(containsMain("dev")).toBe(false);
    expect(result.outputs).toContain("stage_pushed=true");
  });

  it("fails on a main to dev conflict once dev is back, as before", () => {
    seedBranches(false);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("main and dev conflict");
    expect(result.outputs).toContain("stage_pushed=true");
  });

  it("merges main into dev when it is back and does not conflict", () => {
    seedBranches(false, "clean");
    const result = run();
    expect(result.status).toBe(0);
    expect(containsMain("dev")).toBe(true);
    expect(containsMain("stage")).toBe(true);
  });

  it("skips a missing dev cleanly when it is back", () => {
    seedBranches(false, "none");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.output).toContain("::notice::no dev branch; nothing to sync");
  });

  it("runs main's push.sh, never the one a branch carries", () => {
    seedBranches(true);
    const marker = join(root, "branch-script-ran");
    const stageClone = clone("stageclone");
    git(stageClone, "switch", "--quiet", "stage");
    writeFileSync(join(stageClone, "scripts/release/push.sh"), `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`);
    git(stageClone, "commit", "--quiet", "-am", "ci: tamper with push.sh");
    git(stageClone, "push", "--quiet", "origin", "stage");
    git(work, "fetch", "--quiet", "origin");
    const result = run();
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(containsMain("stage")).toBe(true);
  });

  it("fails at once with the ruleset cause when a push is rejected, without calling it moved", () => {
    seedBranches(true);
    rejectPushesTo("refs/heads/stage", GH013);
    const stageBefore = remoteTip("stage");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("push to stage: stage's ruleset refused GitHub Actions' push");
    expect(result.output).toContain("chore/sync-main");
    expect(result.output).not.toContain("moved");
    expect(result.output).not.toContain("trying again");
    expect(remoteTip("stage")).toBe(stageBefore);
    expect(result.outputs).not.toContain("stage_pushed");
  });

  const CHANGELOG_WARNING =
    "::warning::stage moved while the release was open; check that its CHANGELOG [Unreleased] lines";

  it("warns, but still merges and pushes, when stage and main both changed the changelog", () => {
    seedChangelog("changelog");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.output).toContain(CHANGELOG_WARNING);
    expect(result.output).toContain("(CONTRIBUTING.md#releases)");
    expect(containsMain("stage")).toBe(true);
    expect(result.outputs).toContain("stage_pushed=true");
  });

  it("does not warn when the sync is a fast-forward", () => {
    seedChangelog("none");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("::warning::");
    expect(containsMain("stage")).toBe(true);
  });

  it("does not warn when only main changed the changelog", () => {
    seedChangelog("other");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("::warning::");
    expect(containsMain("stage")).toBe(true);
    expect(remoteTip("stage")).not.toBe(remoteTip("main"));
  });
});
