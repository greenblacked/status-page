import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the files `npm-pin.sh check` reads, in a directory the test can edit. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "npm-pin-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts/ci"), { recursive: true });
  mkdirSync(join(dir, "tools/npm"), { recursive: true });
  cpSync(join(ROOT, "scripts/ci/npm-pin.sh"), join(dir, "scripts/ci/npm-pin.sh"));
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
  cpSync(join(ROOT, "tools/npm/package.json"), join(dir, "tools/npm/package.json"));
  cpSync(join(ROOT, "tools/npm/package-lock.json"), join(dir, "tools/npm/package-lock.json"));
  return dir;
}

type Json = { packageManager?: string; packages: Record<string, { version: string }> };

function edit(file: string, change: (json: Json) => void) {
  const json = JSON.parse(readFileSync(file, "utf8")) as Json;
  change(json);
  writeFileSync(file, JSON.stringify(json, null, 2));
}

function check(dir: string) {
  const result = spawnSync("bash", [join(dir, "scripts/ci/npm-pin.sh"), "check"], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("npm-pin.sh check", () => {
  it("passes on the repository: packageManager, tools/npm and its lockfile pin one npm", () => {
    const result = check(ROOT);
    expect(result.output).toContain("all pin npm");
    expect(result.status).toBe(0);
  });

  it("locks the npm tarball by sha512 integrity", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "tools/npm/package-lock.json"), "utf8"));
    expect(lock.packages["node_modules/npm"].integrity).toMatch(/^sha512-/);
  });

  it("fails when packageManager moves without tools/npm", () => {
    const dir = fixture();
    edit(join(dir, "package.json"), (json) => {
      json.packageManager = "npm@0.0.1";
    });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("tools/npm/package.json");
    expect(result.output).toContain("packageManager pins 0.0.1");
  });

  it("fails when the lockfile is stale", () => {
    const dir = fixture();
    edit(join(dir, "tools/npm/package-lock.json"), (json) => {
      json.packages["node_modules/npm"].version = "0.0.1";
    });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("tools/npm/package-lock.json");
  });

  it("fails on a range or a hash suffix in packageManager", () => {
    const dir = fixture();
    edit(join(dir, "package.json"), (json) => {
      json.packageManager = "npm@11.9.0+sha512.abc";
    });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("packageManager must be");
  });
});

describe("release.yml's verify job", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const script = readFileSync(join(ROOT, "scripts/ci/npm-pin.sh"), "utf8");
  const verify = workflow.slice(workflow.indexOf("\n  verify:\n"), workflow.indexOf("\n  publish:\n"));
  const checkouts = [...verify.matchAll(/uses: actions\/checkout@[^\n]*\n((?:\s+[^\n]+\n)*)/g)].map((m) => m[1] ?? "");

  it("takes the npm pin from the commit that started the run, in full", () => {
    // A backfill releases an older commit, which may predate npm-pin.sh, audit-signatures.sh and
    // tools/npm. The run's own commit has them all, so the checkout must not be sparse: a sparse list
    // would have to name every file npm-pin.sh runs, and forgetting one dies with 127 mid-release.
    expect(checkouts).toHaveLength(1);
    const [checkout = ""] = checkouts;
    expect(checkout).toMatch(/^\s+ref: \$\{\{ github\.sha \}\}\s*$/m);
    expect(checkout).not.toMatch(/sparse-checkout/);
    expect(checkout).toMatch(/^\s+fetch-depth: 0\s*$/m);
    const invoked = [...script.matchAll(/(?:^|[\s"'(])\.\/(scripts\/[\w./-]+)/gm)].map((m) => m[1]);
    expect(invoked).toContain("scripts/ci/audit-signatures.sh");
    expect(verify).toContain("./scripts/ci/npm-pin.sh install");
  });

  it("gets the release commit from that history with git, not from a second actions/checkout", () => {
    // CodeQL's "Cache poisoning via execution of untrusted code" and "Checkout of untrusted code in a
    // non-privileged context" fire on an actions/checkout whose ref comes from `needs.<job>.outputs.sha`,
    // followed by npm steps. Plan only picks a commit that is on main, and the history is already here.
    expect(verify).not.toMatch(/ref: \$\{\{\s*needs\./);
    expect(verify).toMatch(/RELEASE_SHA: \$\{\{ needs\.plan\.outputs\.sha \}\}/);
    expect(verify).toMatch(/git worktree add --detach release "\$RELEASE_SHA"/);
  });

  it("runs no repository script and no cache action after adding the release commit", () => {
    const marker = verify.indexOf("git worktree add");
    expect(marker, "the verify job adds the release commit as release/").toBeGreaterThan(-1);
    const after = verify.slice(marker);
    expect(after).not.toMatch(/(?:^|[\s"'(])\.\/scripts\//m);
    expect(after).not.toMatch(/actions\/(?:cache|setup-[a-z]+)@/);
    expect(after).not.toMatch(/\bcache:/);
    // Only the project's own npm commands run in release/.
    expect(after).toMatch(/run: npm ci\n\s+working-directory: release/);
  });
});

describe("the scanner exception for the pinned npm's bundled dependencies", () => {
  // Owner-approved, narrow, and temporary. It grows only by a deliberate edit of these lists.
  const GHSAS = ["GHSA-6j4f-fj2g-mc7p", "GHSA-qhr7-859c-m2p7", "GHSA-rfgv-xxqx-mfg5"];
  const CVES = ["CVE-2026-102276", "CVE-2026-102278", "CVE-2026-19534"];
  const EXPIRY = "2026-12-31";

  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

  it("lets dependency review allow exactly those GHSA IDs, and nothing else", () => {
    const workflow = read(".github/workflows/dependency-review.yml");
    const allowed = [...workflow.matchAll(/^\s*allow-(\w+):\s*(.*)$/gm)];
    expect(allowed.map((m) => m[1])).toEqual(["ghsas"]);
    const ids = (allowed[0]?.[2] ?? "").split(",").map((id) => id.trim());
    expect([...ids].sort()).toEqual(GHSAS);
    expect(workflow).not.toMatch(/deny-|comment-summary-in-pr:\s*never/);
    expect(workflow).toMatch(/fail-on-severity:\s*high\b/);
  });

  /** The entries of `.trivyignore.yaml`, read without a YAML parser (the file is flat and ours). */
  function trivyEntries() {
    const body = read(".trivyignore.yaml")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // Only `vulnerabilities` may be a top-level key: no misconfiguration, secret or license ignores.
    expect([...body.matchAll(/^([A-Za-z]\w*):/gm)].map((m) => m[1])).toEqual(["vulnerabilities"]);
    return body
      .split(/^ {2}- (?=id:)/m)
      .slice(1)
      .map((entry) => ({
        id: /^id:\s*(\S+)/m.exec(entry)?.[1],
        paths: [...entry.matchAll(/^ {6}- (\S+)\s*$/gm)].map((m) => m[1]),
        expiredAt: /^ {4}expired_at:\s*(\S+)\s*$/m.exec(entry)?.[1],
      }));
  }

  it("lets trivy ignore exactly those advisories (by GHSA or CVE ID), each in the one lockfile", () => {
    const entries = trivyEntries();
    expect(entries.map((e) => e.id).sort()).toEqual([...GHSAS, ...CVES].sort());
    for (const entry of entries) {
      expect(entry.paths, `${entry.id} must name the one lockfile it is ignored in`).toEqual([
        "tools/npm/package-lock.json",
      ]);
    }
  });

  it("gives every trivy ignore an expiry date, so the exception lapses by itself", () => {
    for (const entry of trivyEntries()) {
      expect(entry.expiredAt, `${entry.id} needs expired_at`).toBe(EXPIRY);
    }
  });

  it("makes the security service read that file, and skips nothing new", () => {
    const trivy = read("compose.yaml")
      .split("\n")
      .filter((line) => /^\s*trivy fs /.test(line));
    expect(trivy).toHaveLength(1);
    const command = trivy[0] ?? "";
    expect(command).toContain("--ignorefile .trivyignore.yaml");
    expect(command).toContain("--severity HIGH,CRITICAL");
    expect(command).toContain("--exit-code 1");
    expect(command.match(/--skip-(?:dirs|files) \S+/g)).toEqual(["--skip-dirs node_modules"]);
  });

  it("has no plain .trivyignore beside it", () => {
    expect(existsSync(join(ROOT, ".trivyignore"))).toBe(false);
  });
});
