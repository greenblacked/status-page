import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./audit-signatures.sh", import.meta.url));

const MISSING_KEY =
  "npm error code EMISSINGSIGNATUREKEY\nnpm error @playwright/test@1.63.0 has attestations but no corresponding public key(s) can be found";
const BAD_SIGNATURE = "npm error code EINTEGRITY\nnpm error 1 package has an invalid registry signature";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the script against a fake `npm` that fails `audit signatures` with
 * each of `failures` in turn and then passes. Every call logs its arguments
 * and whether the trust-root cache was there at the time.
 */
function run(failures: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "audit-signatures-"));
  dirs.push(dir);
  const cache = join(dir, "cache");
  mkdirSync(join(cache, "_tuf"), { recursive: true });
  writeFileSync(join(dir, "count"), "0");
  failures.forEach((failure, index) => {
    writeFileSync(join(dir, `fail-${index + 1}`), failure);
  });
  const npm = join(dir, "npm");
  writeFileSync(
    npm,
    `#!/usr/bin/env bash
if [ "$1 $2" = "config get" ]; then echo "${cache}"; exit 0; fi
n=$(( $(cat "${dir}/count") + 1 )); echo "$n" > "${dir}/count"
tuf=absent; [ -d "${cache}/_tuf" ] && tuf=present
echo "$* tuf=$tuf" >> "${dir}/calls"
if [ -f "${dir}/fail-$n" ]; then cat "${dir}/fail-$n" >&2; exit 1; fi
echo "audited 214 packages; 214 have verified registry signatures"
`,
  );
  chmodSync(npm, 0o755);
  const result = spawnSync(SCRIPT, [], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AUDIT_SIGNATURES_BACKOFF: "0" },
  });
  const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : [];
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`, calls };
}

describe("audit-signatures.sh", () => {
  it("passes on the first attempt without touching the cache", () => {
    const { ok, calls } = run([]);
    expect(ok).toBe(true);
    expect(calls).toEqual(["audit signatures tuf=present"]);
  });

  it("retries a missing key with a fresh trust root and fresh registry keys", () => {
    const { ok, calls, output } = run([MISSING_KEY, MISSING_KEY]);
    expect(ok).toBe(true);
    expect(calls).toEqual([
      "audit signatures tuf=present",
      "audit signatures --prefer-online tuf=absent",
      "audit signatures --prefer-online tuf=absent",
    ]);
    expect(output).toContain("retrying with a fresh trust root");
  });

  it("fails at once on an invalid signature, without a retry", () => {
    const { ok, calls, output } = run([BAD_SIGNATURE]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(output).toContain("failed on a package, not on fetching keys");
  });

  it("gives up after four attempts when the key never loads", () => {
    const { ok, calls, output } = run([MISSING_KEY, MISSING_KEY, MISSING_KEY, MISSING_KEY]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(4);
    expect(output).toContain("could not load a verification key in 4 attempts");
  });
});
