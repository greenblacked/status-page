import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the files `pnpm-pin.sh check` reads, in a directory the test can edit. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pnpm-pin-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts/ci"), { recursive: true });
  cpSync(join(ROOT, "scripts/ci/pnpm-pin.sh"), join(dir, "scripts/ci/pnpm-pin.sh"));
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
  return dir;
}

function setPackageManager(dir: string, value: string | undefined) {
  const file = join(dir, "package.json");
  const json = JSON.parse(readFileSync(file, "utf8")) as { packageManager?: string };
  if (value === undefined) delete json.packageManager;
  else json.packageManager = value;
  writeFileSync(file, JSON.stringify(json, null, 2));
}

function check(dir: string) {
  const result = spawnSync("bash", [join(dir, "scripts/ci/pnpm-pin.sh"), "check"], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const PINNED = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/;

describe("pnpm-pin.sh check", () => {
  const packageManager = (JSON.parse(read("package.json")) as { packageManager: string }).packageManager;
  const [, version = "", hash = ""] = PINNED.exec(packageManager) ?? [];

  it("passes on the repository", () => {
    const result = check(ROOT);
    expect(result.output).toContain(`pins pnpm ${version}`);
    expect(result.status).toBe(0);
  });

  it("pins pnpm by version and sha512 digest, which Corepack verifies the download against", () => {
    expect(packageManager).toMatch(PINNED);
  });

  it("fails when packageManager has no digest", () => {
    const dir = fixture();
    setPackageManager(dir, `pnpm@${version}`);
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain("packageManager must be pnpm@");
  });

  it("fails on a range, a short digest or another package manager", () => {
    for (const value of [
      `pnpm@^${version}+sha512.${hash}`,
      `pnpm@${version}+sha512.${hash.slice(0, 64)}`,
      `pnpm@${version}+sha1.${hash.slice(0, 40)}`,
      "npm@12.1.0",
      undefined,
    ]) {
      const dir = fixture();
      setPackageManager(dir, value);
      const result = check(dir);
      expect(result.status, String(value)).toBe(1);
      expect(result.output).toContain("packageManager must be pnpm@");
    }
  });
});

describe("pnpm's own settings", () => {
  const workspace = read("pnpm-workspace.yaml");
  const lockfile = read("pnpm-lock.yaml");

  it("leaves pinning pnpm to Corepack, so pnpm-lock.yaml stays one YAML document", () => {
    // With the default, pnpm 12 writes itself into a first document of pnpm-lock.yaml. OSV-Scanner
    // (OpenSSF Scorecard's Vulnerabilities check) reads only the first document: it would find pnpm's
    // fifteen packages and none of the project's.
    expect(workspace).toMatch(/^pmOnFail: ignore$/m);
    expect(lockfile.split("\n").filter((line) => line === "---")).toEqual([]);
    expect(lockfile).not.toContain("packageManagerDependencies");
  });

  it("blocks every dependency build script, explicitly", () => {
    expect(workspace).toMatch(/^allowBuilds:\n {2}esbuild: false\n {2}fsevents: false\n {2}workerd: false\n/m);
    expect(workspace).not.toMatch(/dangerouslyAllowAllBuilds|: true/);
  });

  it("fails an install on a trust downgrade, with three exact-version exceptions and nothing broader", () => {
    expect(workspace).toMatch(/^trustPolicy: no-downgrade$/m);
    const excluded = [...workspace.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]);
    expect(excluded).toEqual(["semver@6.3.1", "undici-types@6.21.0", "why-is-node-running@3.2.2"]);
    expect(workspace).not.toMatch(/trustPolicyIgnoreAfter|minimumReleaseAge/);
  });

  it("needs no .npmrc and no hoisting", () => {
    expect(existsSync(join(ROOT, ".npmrc"))).toBe(false);
    const settings = workspace.split("\n").filter((line) => !/^\s*#/.test(line));
    expect(settings.join("\n")).not.toMatch(/hoist/i);
  });
});

describe("release.yml's verify job", () => {
  const workflow = read(".github/workflows/release.yml");
  const script = read("scripts/ci/pnpm-pin.sh");
  const verify = workflow.slice(workflow.indexOf("\n  verify:\n"), workflow.indexOf("\n  publish:\n"));
  const checkouts = [...verify.matchAll(/uses: actions\/checkout@[^\n]*\n((?:\s+[^\n]+\n)*)/g)].map((m) => m[1] ?? "");

  it("takes the pnpm pin from the commit that started the run, in full", () => {
    // A backfill releases an older commit, which may predate pnpm-pin.sh. The run's own commit has it,
    // so the checkout must not be sparse: a sparse list would have to name every file pnpm-pin.sh
    // reads, and forgetting one dies mid-release.
    expect(checkouts).toHaveLength(1);
    const [checkout = ""] = checkouts;
    expect(checkout).toMatch(/^\s+ref: \$\{\{ github\.sha \}\}\s*$/m);
    expect(checkout).not.toMatch(/sparse-checkout/);
    expect(checkout).toMatch(/^\s+fetch-depth: 0\s*$/m);
    expect(verify).toContain("./scripts/ci/pnpm-pin.sh install");
    expect(verify).toContain("./scripts/ci/pnpm-pin.sh verify");
    // The pin script is self-contained: it runs no other repository script.
    const invoked = [...script.matchAll(/(?:^|[\s"'(])\.\/(scripts\/[\w./-]+)/gm)].map((m) => m[1]);
    expect(invoked.filter((path) => path !== "scripts/ci/pnpm-pin.sh")).toEqual([]);
  });

  it("gets the release commit from that history with git, not from a second actions/checkout", () => {
    // CodeQL's "Cache poisoning via execution of untrusted code" and "Checkout of untrusted code in a
    // non-privileged context" fire on an actions/checkout whose ref comes from `needs.<job>.outputs.sha`,
    // followed by package-manager steps. Plan only picks a commit that is on main, and the history is
    // already here.
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
    // Only the project's own pnpm commands run in release/, from its lockfile.
    expect(after).toMatch(/run: pnpm install --frozen-lockfile\n\s+working-directory: release/);
  });

  it("uses no package cache at all, so no cache entry saved by another run reaches the release", () => {
    expect(verify).toMatch(/package-manager-cache: false/);
    expect(verify).not.toMatch(/^\s+cache:/m);
  });
});

describe("no npm toolchain is left to scan", () => {
  // CVE-2026-93748 (http-cache-semantics) was reachable only through the npm CLI that CI used to pin
  // from tools/npm. pnpm 12 has no dependencies. These guard against that pin, and the scanner
  // exceptions it needed, coming back.
  const tracked = (glob: string) => {
    const result = spawnSync("git", ["ls-files", "--", glob], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.split("\n").filter(Boolean);
  };

  it("has no second lockfile, no npm lockfile and no scanner exception files", () => {
    expect(tracked("**/package-lock.json")).toEqual([]);
    expect(tracked("**/npm-shrinkwrap.json")).toEqual([]);
    expect(tracked("tools/**")).toEqual([]);
    expect(tracked("**/osv-scanner.toml")).toEqual([]);
    expect(tracked("**/.trivyignore*")).toEqual([]);
    expect(existsSync(join(ROOT, "tools"))).toBe(false);
  });

  it("locks neither http-cache-semantics nor make-fetch-happen", () => {
    expect(read("pnpm-lock.yaml")).not.toMatch(/http-cache-semantics|make-fetch-happen/);
  });

  it("lets dependency review fail on any high advisory, with no allowed advisory", () => {
    const workflow = read(".github/workflows/dependency-review.yml");
    expect(workflow).not.toMatch(/^\s*allow-\w+:/m);
    expect(workflow).not.toMatch(/deny-|comment-summary-in-pr:\s*never/);
    expect(workflow).toMatch(/fail-on-severity:\s*high\b/);
  });

  it("makes the security service scan every advisory at HIGH and above, ignoring none", () => {
    const trivy = read("compose.yaml")
      .split("\n")
      .filter((line) => /^\s*trivy fs /.test(line));
    expect(trivy).toHaveLength(1);
    const command = trivy[0] ?? "";
    expect(command).not.toMatch(/--ignorefile|--ignore-unfixed|--skip-files/);
    expect(command).toContain("--severity HIGH,CRITICAL");
    expect(command).toContain("--exit-code 1");
    expect(command.match(/--skip-(?:dirs|files) \S+/g)).toEqual(["--skip-dirs node_modules"]);
  });

  it("has Dependabot watch the one lockfile, the workflows and the Dockerfile, and no tools/npm", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(
      [...dependabot.matchAll(/package-ecosystem: (\S+)\n\s+directory: (\S+)/g)].map((m) => `${m[1]} ${m[2]}`),
    ).toEqual(["npm /", "github-actions /", "docker /"]);
  });
});

describe("a restored pnpm store is not trusted", () => {
  // `pnpm install --frozen-lockfile` does not check the files of a store restored from the Actions
  // cache against the lockfile's integrity, so a poisoned cache entry would be installed silently.
  // The jobs that make the Worker or hold the Cloudflare token therefore download every package.
  it("restores no package cache in deploy.yml, and turns setup-node's off in each job", () => {
    const deploy = read(".github/workflows/deploy.yml");
    expect(deploy).not.toMatch(/^\s+cache:/m);
    expect(deploy).not.toMatch(/actions\/cache(?:\/restore)?@/);
    const setups = deploy.match(/uses: actions\/setup-node@/g) ?? [];
    expect(setups).toHaveLength(3);
    expect(deploy.match(/package-manager-cache: false/g)).toHaveLength(setups.length);
  });

  it("keeps pnpm's store inside the container, not in the host's checkout", () => {
    expect(read("scripts/ci/container-checks.sh")).toMatch(/^export pnpm_config_store_dir=/m);
    expect(read(".gitignore")).toMatch(/^\.pnpm-store$/m);
  });
});
