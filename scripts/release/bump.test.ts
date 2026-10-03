import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));
const PIPE = { stdio: "pipe", encoding: "utf8" } as const;

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- Something worth releasing.

## [0.5.0] - 2026-09-01

- Earlier.

[Unreleased]: https://github.com/example/repo/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/example/repo/releases/tag/v0.5.0
`;

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      clsx:
        specifier: 2.1.1
        version: 2.1.1
`;

let root: string;
let remote: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, ...PIPE }).trim();
}

function commitFile(dir: string, name: string, subject: string): void {
  writeFileSync(join(dir, name), `${subject}\n`);
  git(dir, "add", name);
  git(dir, "commit", "--quiet", "-m", subject);
}

function bump(...args: string[]) {
  const result = spawnSync(join(work, "scripts", "release", "bump.sh"), args, { cwd: work, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bump-"));
  remote = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "commit.gpgsign", "false");
  mkdirSync(join(work, "scripts", "release"), { recursive: true });
  mkdirSync(join(work, "scripts", "ci"), { recursive: true });
  cpSync(join(SCRIPTS, "release", "bump.sh"), join(work, "scripts", "release", "bump.sh"));
  cpSync(join(SCRIPTS, "ci", "release-notes.sh"), join(work, "scripts", "ci", "release-notes.sh"));
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "x", version: "0.5.0" }, null, 2)}\n`);
  // pnpm-lock.yaml records no version for the root project, so a bump must leave it alone.
  writeFileSync(join(work, "pnpm-lock.yaml"), LOCKFILE);
  writeFileSync(join(work, "CHANGELOG.md"), CHANGELOG);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "chore: start");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "--quiet", "origin", "main");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("bump.sh (local)", () => {
  it("releases from an up-to-date main on a new release branch", () => {
    const result = bump("patch");
    expect(result.status).toBe(0);
    expect(git(work, "branch", "--show-current")).toBe("release/v0.5.1");
    expect(git(work, "log", "-1", "--format=%s")).toBe("release: 0.5.1");
  });

  it("changes only the version line of package.json, and leaves pnpm-lock.yaml alone", () => {
    const result = bump("patch");
    expect(result.status).toBe(0);
    expect(git(work, "show", "--name-only", "--format=", "HEAD").split("\n")).toEqual(["CHANGELOG.md", "package.json"]);
    expect(git(work, "diff", "-U0", "HEAD~1", "HEAD", "--", "package.json")).toMatch(
      /- {2}"version": "0\.5\.0"\n\+ {2}"version": "0\.5\.1"/,
    );
    expect(readFileSync(join(work, "pnpm-lock.yaml"), "utf8")).toBe(LOCKFILE);
  });

  it("releases from the tip of origin/stage when it contains main", () => {
    git(work, "switch", "--quiet", "-c", "stage");
    commitFile(work, "feature.txt", "feat: ahead of main");
    git(work, "push", "--quiet", "origin", "stage");
    git(work, "switch", "--quiet", "--detach", "origin/stage");
    const result = bump("minor");
    expect(result.output).not.toContain("bump:");
    expect(result.status).toBe(0);
    expect(git(work, "branch", "--show-current")).toBe("release/v0.6.0");
    expect(git(work, "log", "-1", "--format=%s")).toBe("release: 0.6.0");
    // The release commit sits on top of stage's commits.
    expect(git(work, "log", "-2", "--format=%s", "HEAD")).toContain("feat: ahead of main");
  });

  it("refuses a checkout that is neither main nor the tip of stage", () => {
    git(work, "switch", "--quiet", "-c", "stage");
    commitFile(work, "feature.txt", "feat: ahead of main");
    git(work, "push", "--quiet", "origin", "stage");
    git(work, "switch", "--quiet", "-c", "feature/other");
    commitFile(work, "other.txt", "feat: unpushed work");
    const result = bump("patch");
    expect(result.status).toBe(1);
    expect(result.output).toContain("release from an up-to-date main");
    expect(result.output).toContain("origin/stage");
  });

  it("refuses the tip of stage when main has moved on past it", () => {
    git(work, "switch", "--quiet", "-c", "stage");
    commitFile(work, "feature.txt", "feat: ahead of main");
    git(work, "push", "--quiet", "origin", "stage");
    git(work, "switch", "--quiet", "main");
    commitFile(work, "hotfix.txt", "fix: straight to main");
    git(work, "push", "--quiet", "origin", "main");
    git(work, "switch", "--quiet", "--detach", "origin/stage");
    const result = bump("patch");
    expect(result.status).toBe(1);
    expect(result.output).toContain("release from an up-to-date main");
  });

  it("refuses when the release branch already exists", () => {
    git(work, "branch", "release/v0.5.1");
    const result = bump("patch");
    expect(result.status).toBe(1);
    expect(result.output).toContain("branch release/v0.5.1 already exists");
  });
});
