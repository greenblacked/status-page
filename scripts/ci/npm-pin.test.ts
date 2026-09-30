import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("release.yml's sparse checkout of the npm pin", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const script = readFileSync(join(ROOT, "scripts/ci/npm-pin.sh"), "utf8");

  /** The lines under the `sparse-checkout: |` key of the sparse checkout of the npm pin. */
  function sparsePaths() {
    const lines = workflow.split("\n");
    const start = lines.findIndex((line) => /^\s*sparse-checkout: \|\s*$/.test(line));
    expect(start).toBeGreaterThan(-1);
    const indent = (lines[start]?.match(/^\s*/) ?? [""])[0].length;
    const paths: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "" || (line.match(/^\s*/) ?? [""])[0].length <= indent) break;
      paths.push(line.trim());
    }
    return paths;
  }

  it("lists every repo script that npm-pin.sh runs, or the release verify job dies with 127", () => {
    const paths = sparsePaths();
    // `./scripts/ci/foo.sh`, however it is quoted or given arguments.
    const invoked = [...script.matchAll(/(?:^|[\s"'(])\.\/(scripts\/[\w./-]+)/gm)].map((m) => m[1]);
    expect(invoked).toContain("scripts/ci/audit-signatures.sh");
    for (const file of new Set(invoked)) {
      expect(paths, `${file} is missing from the sparse checkout`).toContain(`/${file}`);
    }
  });

  it("lists the script itself, package.json and tools/npm", () => {
    expect(sparsePaths()).toEqual(
      expect.arrayContaining(["/.nvmrc", "/package.json", "/scripts/ci/npm-pin.sh", "/tools/npm/"]),
    );
  });

  it("runs no repository script and no cache action after checking out the release commit", () => {
    // CodeQL's "Cache poisoning via execution of untrusted code": a job that checks out a ref chosen at
    // run time and then runs a local script is flagged. The pin is installed first; the release commit
    // goes into release/ last and is only built with npm.
    const verify = workflow.slice(workflow.indexOf("\n  verify:\n"), workflow.indexOf("\n  publish:\n"));
    const marker = verify.indexOf("path: release");
    expect(marker, "the verify job checks the release commit out into release/").toBeGreaterThan(-1);
    const after = verify.slice(marker);
    expect(after).not.toMatch(/(?:^|[\s"'(])\.\/scripts\//m);
    expect(after).not.toMatch(/actions\/(?:cache|setup-[a-z]+)@/);
    expect(after).not.toMatch(/\bcache:/);
  });
});
