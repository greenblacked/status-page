import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./next.sh", import.meta.url));
let repo: string;

// execFileSync copies a child's stderr to ours unless stdio is set, so pipe it:
// a failure's message is then asserted on, not leaked into the test output.
const PIPE = { stdio: "pipe" } as const;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", ...PIPE });
}

function commit(subject: string, body?: string): void {
  git("commit", "--quiet", "--allow-empty", "-m", subject, ...(body ? ["-m", body] : []));
}

function next(mode: "level" | "notes", range = "v0.1.0..HEAD"): string {
  return execFileSync(SCRIPT, [mode, range], { cwd: repo, encoding: "utf8", ...PIPE });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "next-"));
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  commit("chore: start");
  git("tag", "v0.1.0");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("next.sh level", () => {
  it("releases nothing for docs, ci, build and chore commits", () => {
    commit("docs(readme): explain badges");
    commit("ci: cache npm");
    commit("build(deps): bump vite");
    expect(next("level")).toBe("none\n");
  });

  it("maps fix to patch and feat to minor, taking the largest", () => {
    commit("fix(status): decode entities (#20)");
    expect(next("level")).toBe("patch\n");
    commit("feat: add a feed (#21)");
    commit("perf: cache the board");
    expect(next("level")).toBe("minor\n");
  });

  it("treats a ! or a BREAKING CHANGE footer as major", () => {
    commit("refactor!: rename the badge route");
    expect(next("level")).toBe("major\n");
    git("tag", "v1.0.0");
    commit("fix: keep the old route", "BREAKING CHANGE: /badge is now /api/badge");
    expect(next("level", "v1.0.0..HEAD")).toBe("major\n");
  });

  it("sees a BREAKING CHANGE footer ahead of a body longer than a pipe buffer", () => {
    // 200 KB after the footer: the body is still being written when the footer
    // has matched, so a reader that stops at the first match must not turn
    // that into a failed check.
    const message = join(repo, ".git", "COMMIT_LONG");
    writeFileSync(
      message,
      `fix: keep the old route\n\nBREAKING CHANGE: /badge is now /api/badge\n\n${"x".repeat(99).concat("\n").repeat(2000)}`,
    );
    git("commit", "--quiet", "--allow-empty", "-F", message);
    expect(next("level")).toBe("major\n");
  });

  it("ignores release bump commits and non-conventional subjects", () => {
    commit("release: 0.2.0");
    commit("chore(release): 0.1.1");
    commit("Merge something by hand");
    expect(next("level")).toBe("none\n");
  });

  it("ignores release and legacy chore(release) commits while feat and fix still count", () => {
    commit("release: 0.2.0");
    commit("chore(release): 0.1.1");
    expect(next("level")).toBe("none\n");
    commit("fix: keep the badge");
    expect(next("level")).toBe("patch\n");
    commit("feat: add a feed");
    commit("release: 0.3.0");
    commit("chore(release): 0.2.1");
    expect(next("level")).toBe("minor\n");
  });

  it("keeps a ! or a BREAKING CHANGE footer on a release commit from forcing a major", () => {
    commit("release!: 0.2.0");
    expect(next("level")).toBe("none\n");
    commit("release: 0.2.1", "BREAKING CHANGE: x");
    expect(next("level")).toBe("none\n");
    commit("chore(release)!: 0.2.2");
    expect(next("level")).toBe("none\n");
    commit("chore(release): 0.2.3", "BREAKING CHANGE: x");
    expect(next("level")).toBe("none\n");
  });

  it("fails on a range it cannot resolve instead of reporting none", () => {
    const result = spawnSync(SCRIPT, ["level", "v9.9.9..HEAD"], { cwd: repo, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("next: cannot resolve commit range: v9.9.9..HEAD\n");
  });
});

describe("next.sh notes", () => {
  it("groups subjects into changelog sections", () => {
    commit("feat(api): add a JSON API (#19)");
    commit("fix: link incidents correctly (#18)");
    commit("docs: typo");
    commit("refactor!: drop the legacy route");
    expect(next("notes")).toBe(
      [
        "### Added",
        "",
        "- Add a JSON API (#19)",
        "",
        "### Changed",
        "",
        "- Drop the legacy route",
        "",
        "### Fixed",
        "",
        "- Link incidents correctly (#18)",
        "",
      ].join("\n"),
    );
  });

  it("leaves release and legacy chore(release) commits out", () => {
    commit("release: 0.2.0");
    commit("chore(release): 0.1.1");
    commit("fix: link incidents correctly (#18)");
    expect(next("notes")).toBe(["### Fixed", "", "- Link incidents correctly (#18)", ""].join("\n"));
    commit("release: 0.2.1");
    expect(next("notes", "v0.1.0..HEAD")).not.toContain("0.2");
  });

  it("leaves a release commit out of the notes even when it carries a !", () => {
    commit("release!: 0.2.0");
    commit("chore(release)!: 0.2.1");
    expect(next("notes")).toBe("");
  });

  it("prints nothing when no commit is worth a line", () => {
    commit("docs: typo");
    expect(next("notes")).toBe("");
  });
});
