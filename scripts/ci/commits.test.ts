import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./commits.sh", import.meta.url));

function checkSubject(subject: string, branches?: { base?: string; head?: string }): { ok: boolean; output: string } {
  const args = ["--subject", subject];
  if (branches?.base !== undefined) args.push("--base", branches.base);
  if (branches?.head !== undefined) args.push("--head", branches.head);
  const result = spawnSync(SCRIPT, args, { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe("commits.sh --subject", () => {
  it.each([
    "feat: add a feed",
    "fix(status): decode entities (#20)",
    "refactor!: drop the legacy route",
    "release: 0.6.0",
    "release: v0.6.0",
    "release: v0.6.0 (#110)",
  ])("accepts %s", (subject) => {
    expect(checkSubject(subject).ok).toBe(true);
  });

  it.each(["release(core): 0.6.0", "release!: 0.6.0", "release(core)!: 0.6.0"])(
    "rejects %s, since a release takes no scope and no !",
    (subject) => {
      const result = checkSubject(subject);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("release takes no scope and no !");
    },
  );

  it.each(["release: add a feed", "release:  0.6.0", "release: 0.6", "release: v0.6.0 now", "release: 0.6.0."])(
    "rejects %s, since release takes only a version",
    (subject) => {
      const result = checkSubject(subject);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("release takes only a version");
    },
  );

  it.each(["release 0.6.0", "release:", "Release: 0.6.0", "added: a feed", "release: added 0.6.0"])(
    "rejects %s",
    (subject) => {
      expect(checkSubject(subject).ok).toBe(false);
    },
  );

  it("lists release among the types in its error", () => {
    expect(checkSubject("nope: x").output).toContain("release");
  });

  it("rejects a flag it does not know and a flag without a value", () => {
    expect(spawnSync(SCRIPT, ["--subject", "feat: x", "--bogus"], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(SCRIPT, ["--subject", "feat: x", "--base"], { encoding: "utf8" }).status).toBe(2);
  });
});

describe("commits.sh --subject with the pull request's branches", () => {
  const releaseOnly = "release: titles are only for a release/vX.Y.Z pull request into main";

  it.each([
    ["release: v0.6.0", "release/v0.6.0"],
    ["release: 0.6.0", "release/v0.6.0"],
    ["release: v0.6.0 (#110)", "release/v0.6.0"],
    ["release: v12.34.56", "release/v12.34.56"],
  ])("accepts %s from %s into main", (subject, head) => {
    expect(checkSubject(subject, { base: "main", head }).ok).toBe(true);
  });

  it.each(["stage", "dev"])("rejects a release title into %s", (base) => {
    const result = checkSubject("release: v0.6.0", { base, head: "release/v0.6.0" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain(releaseOnly);
  });

  it.each([
    "stage",
    "dev",
    "feature/add-a-feed",
    "chore/sync-main",
    "release/0.6.0",
    "release/v0.6",
    "release/v0.6.0-rc1",
    "release/v0.6.0/x",
    "xrelease/v0.6.0",
    "",
  ])("rejects a release title into main from %j", (head) => {
    const result = checkSubject("release: v0.6.0", { base: "main", head });
    expect(result.ok).toBe(false);
    expect(result.output).toContain(releaseOnly);
  });

  it("rejects a release title from a release branch when only the head is given", () => {
    expect(checkSubject("release: v0.6.0", { head: "release/v0.6.0" }).ok).toBe(false);
    expect(checkSubject("release: v0.6.0", { base: "main" }).ok).toBe(false);
  });

  it.each([
    ["release: v0.6.1", "release/v0.6.0"],
    ["release: 0.6.1", "release/v0.6.0"],
    ["release: v0.6.10", "release/v0.6.1"],
    ["release: v1.6.0", "release/v0.6.0"],
  ])("rejects %s from %s, since the versions differ", (subject, head) => {
    const result = checkSubject(subject, { base: "main", head });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not the release branch's version");
  });

  it.each([
    ["feat: add a feed", "dev", "feature/add-a-feed"],
    ["fix(status): decode entities (#20)", "stage", "fix/decode-entities"],
    ["feat: promote stage", "main", "stage"],
    ["chore: sync main", "stage", "chore/sync-main"],
    ["feat: add a feed", "main", "release/v0.6.0"],
  ])("leaves %s from %s into %s unchanged", (subject, base, head) => {
    expect(checkSubject(subject, { base, head }).ok).toBe(true);
  });

  it("still rejects a bad title whatever the branches", () => {
    expect(checkSubject("added a feed", { base: "dev", head: "feature/x" }).ok).toBe(false);
    expect(checkSubject("release(core): 0.6.0", { base: "main", head: "release/v0.6.0" }).ok).toBe(false);
    expect(checkSubject("release: add a feed", { base: "main", head: "release/v0.6.0" }).ok).toBe(false);
  });

  it.each([
    "$(touch /tmp/pwned)",
    "`id`",
    "a; exit 0",
    "release/v0.6.0 && true",
    "release/v0.6.0\nrelease/v0.6.0",
    "-n",
    "--subject",
    "*",
    "feature/with space",
  ])("treats the head %j as plain text", (head) => {
    expect(checkSubject("release: v0.6.0", { base: "main", head }).ok).toBe(false);
    expect(checkSubject("feat: add a feed", { base: "dev", head }).ok).toBe(true);
  });
});

describe("commits.sh with a commit range", () => {
  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }

  it("accepts the release commit bump.sh makes and rejects a bad one", () => {
    const dir = mkdtempSync(join(tmpdir(), "commits-range-"));
    try {
      git(dir, "init", "--quiet", "--initial-branch=main");
      git(dir, "commit", "--quiet", "--allow-empty", "-m", "chore: init");
      git(dir, "branch", "base");
      git(dir, "commit", "--quiet", "--allow-empty", "-m", "release: 0.6.0");

      const good = spawnSync(SCRIPT, ["base..HEAD"], { cwd: dir, encoding: "utf8" });
      expect(good.status).toBe(0);

      git(dir, "commit", "--quiet", "--allow-empty", "-m", "release: add stuff");
      const bad = spawnSync(SCRIPT, ["base..HEAD"], { cwd: dir, encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(`${bad.stdout}${bad.stderr}`).toContain("release takes only a version");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
