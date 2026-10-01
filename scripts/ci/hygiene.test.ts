import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./hygiene.sh", import.meta.url));
let repo: string;

// hygiene.sh starts a git process per tracked file, so the files take a few seconds.
const SLOW = 60_000;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "hygiene-"));
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/**
 * Tracks `extra` and, under a nested directory (paths of about 760 bytes, under
 * macOS's PATH_MAX of 1024), enough empty files that
 * `git ls-files` writes about 400 KB of paths, far over a pipe buffer (64 KiB):
 * it is then still writing when the .env guard's grep has matched and stopped
 * reading. ".env" sorts before the nested files, so the match comes first.
 */
function track(extra: string[]): void {
  const dir = join(repo, ...Array.from({ length: 3 }, (_, i) => String(i).repeat(250).slice(0, 250)));
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 560; i++) writeFileSync(join(dir, `f${String(i).padStart(4, "0")}`), "");
  for (const name of extra) writeFileSync(join(repo, name), "");
  git("add", "--all");
}

function hygiene() {
  const result = spawnSync(SCRIPT, [], { cwd: repo, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("hygiene.sh environment files", () => {
  it(
    "rejects a tracked .env even when the file list is larger than a pipe buffer",
    () => {
      track([".env"]);
      const { status, output } = hygiene();
      expect(output).toContain("environment files must not be committed");
      expect(status).toBe(1);
    },
    SLOW,
  );

  it(
    "rejects a tracked .env.production among many files",
    () => {
      track([".env.production"]);
      const { status, output } = hygiene();
      expect(output).toContain("environment files must not be committed");
      expect(status).toBe(1);
    },
    SLOW,
  );

  it(
    "passes when no environment file is tracked",
    () => {
      track(["environment.md"]);
      const { status, output } = hygiene();
      expect(output).toContain("hygiene: OK");
      expect(status).toBe(0);
    },
    SLOW,
  );
});
