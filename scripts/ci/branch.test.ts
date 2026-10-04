import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./branch.sh", import.meta.url));

function checkWith(name: string, base?: string, env: Record<string, string> = {}): { ok: boolean; output: string } {
  const result = spawnSync(SCRIPT, base === undefined ? [name] : [name, base], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

const check = checkWith;

describe("branch.sh", () => {
  it.each([
    "feature/board-metrics-stars-shortcuts",
    "fix/42-aws-stale-events",
    "docs/readme-integrations",
    "ci/cache-actionlint-image",
    "chore/bump-tanstack-start",
    "refactor/split-collectors",
    "test/parser-edge-cases",
    "perf/cache-catalog-lookup",
    "build/pin-node-22",
    "feature/a",
  ])("accepts %s", (name) => {
    expect(check(name).ok).toBe(true);
  });

  it.each(["dev", "stage", "dependabot/npm_and_yarn/vite-8.4.0", "release/v0.4.0"])(
    "accepts the long-lived or tool-named %s",
    (name) => {
      expect(check(name).ok).toBe(true);
    },
  );

  it.each([
    ["feat/board-metrics", "a commit type that is not a branch prefix"],
    ["fb/board-metrics", "fb/, which feature/ replaced"],
    ["style/tidy-board", "a commit type that is not a branch prefix"],
    ["revert/board-metrics", "a commit type that is not a branch prefix"],
    ["Feature/board-metrics", "an uppercase prefix"],
    ["features/board-metrics", "a prefix that only starts with an accepted one"],
    ["fix-aws", "no slash"],
    ["feature/Add-Gemini", "uppercase"],
    ["feature/add_gemini", "an underscore"],
    ["feature/add--gemini", "a double hyphen"],
    ["docs/readme-", "a trailing hyphen"],
    ["feature/", "an empty description"],
    ["feature/nested/path", "a second slash"],
    ["release/next", "a release branch without a version"],
    ["develop", "a long-lived name the repository does not use"],
    ["main", "main as a head branch, which would commit dev's work to main"],
    ["staging", "a long-lived name the repository does not use"],
  ])("rejects %s (%s)", (name) => {
    const result = check(name);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("CONTRIBUTING.md#branches");
  });

  it("rejects a name over 50 characters and says how long it is", () => {
    const name = `feature/${"a".repeat(43)}`;
    expect(name).toHaveLength(51);
    const result = check(name);
    expect(result.ok).toBe(false);
    expect(result.output).toContain(`${name.length} characters`);
  });

  it("accepts a name of exactly 50 characters", () => {
    const name = `feature/${"a".repeat(42)}`;
    expect(name).toHaveLength(50);
    expect(check(name).ok).toBe(true);
  });

  describe("with the pull request's base branch, dev active (DEV_PAUSED=false)", () => {
    const check = (name: string, base?: string, env: Record<string, string> = {}) =>
      checkWith(name, base, { DEV_PAUSED: "false", ...env });

    it.each([
      ["feature/board-metrics", "dev"],
      ["fix/42-aws-stale-events", "dev"],
      ["dependabot/npm_and_yarn/vite-8.4.0", "dev"],
      ["release/v0.4.0", "dev"],
      ["chore/sync-main", "dev"],
      ["dev", "stage"],
      ["chore/sync-main", "stage"],
      ["stage", "main"],
      ["release/v0.4.0", "main"],
    ])("accepts %s into %s", (name, base) => {
      expect(check(name, base).ok).toBe(true);
    });

    it.each([
      ["feature/board-metrics", "stage", "an ordinary branch into stage"],
      ["fix/urgent-hotfix", "main", "a fix into main"],
      ["dependabot/npm_and_yarn/vite-8.4.0", "main", "Dependabot into main"],
      ["dev", "main", "dev skipping stage"],
      ["dev", "dev", "dev into itself"],
      ["stage", "dev", "stage into dev"],
      ["stage", "stage", "stage into itself"],
      ["release/v0.4.0", "stage", "a bump.sh release into stage"],
    ])("rejects %s into %s (%s)", (name, base) => {
      const result = check(name, base);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("CONTRIBUTING.md#branches");
    });

    it("still checks the name against the prefixes", () => {
      expect(check("feat/board-metrics", "dev").ok).toBe(false);
    });

    it.each(["dev", "stage"])("rejects a fork's %s", (name) => {
      const result = check(name, name === "dev" ? "stage" : "main", { FROM_FORK: "true" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("a fork's");
    });

    it.each([
      ["release/v0.4.0", "main"],
      ["chore/sync-main", "stage"],
    ])("rejects a fork's %s into %s", (name, base) => {
      const result = check(name, base, { FROM_FORK: "true" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("a fork's");
    });

    it.each([
      ["release/v0.4.0", "main"],
      ["chore/sync-main", "stage"],
    ])("still accepts %s into %s when FROM_FORK is false", (name, base) => {
      expect(check(name, base, { FROM_FORK: "false" }).ok).toBe(true);
    });

    it("lets a fork use an ordinary branch name into dev", () => {
      expect(check("fix/typo", "dev", { FROM_FORK: "true" }).ok).toBe(true);
    });
  });

  describe("the repository's own switch (scripts/ci/dev-paused, DEV_PAUSED not set)", () => {
    const { DEV_PAUSED: _unset, ...env } = process.env;
    const run = (name: string, base: string) => spawnSync(SCRIPT, [name, base], { encoding: "utf8", env });

    it("has dev active: stage takes dev, not a feature branch", () => {
      expect(run("dev", "stage").status).toBe(0);
      expect(run("feature/board-metrics", "stage").status).not.toBe(0);
      expect(run("feature/board-metrics", "dev").status).toBe(0);
    });
  });

  describe("while dev is paused (DEV_PAUSED=true)", () => {
    const check = (name: string, base?: string, env: Record<string, string> = {}) =>
      checkWith(name, base, { DEV_PAUSED: "true", ...env });

    it.each([
      ["feature/board-metrics", "stage"],
      ["fix/42-aws-stale-events", "stage"],
      ["chore/bump-tanstack-start", "stage"],
      ["docs/readme-integrations", "stage"],
      ["ci/cache-actionlint-image", "stage"],
      ["dependabot/npm_and_yarn/vite-8.4.0", "stage"],
      ["chore/sync-main", "stage"],
      ["dev", "stage"],
      ["stage", "main"],
      ["release/v0.4.0", "main"],
    ])("accepts %s into %s", (name, base) => {
      expect(check(name, base).ok).toBe(true);
    });

    it.each([
      ["fix/urgent-hotfix", "main", "a fix into main"],
      ["feature/board-metrics", "main", "a feature into main"],
      ["dependabot/npm_and_yarn/vite-8.4.0", "main", "Dependabot into main"],
      ["dev", "main", "dev skipping stage"],
      ["stage", "dev", "stage into dev"],
      ["stage", "stage", "stage into itself"],
      ["release/v0.4.0", "stage", "a bump.sh release into stage"],
    ])("rejects %s into %s (%s)", (name, base) => {
      const result = check(name, base);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("CONTRIBUTING.md#branches");
    });

    it("sends a branch aimed at main to stage, not dev", () => {
      const result = check("feature/board-metrics", "main");
      expect(result.output).toContain("open it into stage");
      expect(result.output).not.toContain("into dev");
    });

    it.each(["feat/board-metrics", "feature/Add-Gemini", "feature/nested/path"])(
      "still checks the name of %s into stage",
      (name) => {
        expect(check(name, "stage").ok).toBe(false);
      },
    );

    it("still enforces the 50 character limit into stage", () => {
      expect(check(`feature/${"a".repeat(43)}`, "stage").ok).toBe(false);
      expect(check(`feature/${"a".repeat(42)}`, "stage").ok).toBe(true);
    });

    it("lets a fork's feature branch into stage", () => {
      expect(check("fix/typo", "stage", { FROM_FORK: "true" }).ok).toBe(true);
      expect(check("dependabot/npm_and_yarn/vite-8.4.0", "stage", { FROM_FORK: "true" }).ok).toBe(true);
    });

    it.each([
      ["chore/sync-main", "stage"],
      ["release/v0.4.0", "main"],
    ])("still rejects a fork's %s into %s", (name, base) => {
      const result = check(name, base, { FROM_FORK: "true" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("a fork's");
    });

    it.each(["dev", "stage"])("still rejects a fork's %s", (name) => {
      const result = check(name, name === "dev" ? "stage" : "main", { FROM_FORK: "true" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("a fork's");
    });
  });
});
