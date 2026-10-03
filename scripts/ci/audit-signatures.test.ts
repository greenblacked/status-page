import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./audit-signatures.sh", import.meta.url));

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const OTHER = `sha512-${"B".repeat(86)}==`;
const LOCKFILE = `---
lockfileVersion: '9.0'

packages:

  clsx@2.1.1:
    resolution: {integrity: ${INTEGRITY}}

snapshots:

  clsx@2.1.1: {}
`;

// What pnpm 12 prints, taken from real runs against a registry that misbehaved.
const OK = "audited 322 packages\n\n322 packages have verified registry signatures";
const INVALID =
  "1 package has an invalid registry signature:\n\nclsx@2.1.1 has an invalid registry signature with keyid SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA\n\nSomeone might have tampered with this package since it was published on the registry!";
const MISSING =
  "321 packages have verified registry signatures\n\n1 package is missing registry signature but the registry is providing signing keys:";
const NO_KEYS =
  "Error: ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL\n\n  x Failed to request the registry keys endpoint (at https://registry.npmjs.org/-/npm/v1/keys): error sending request";
const SERVER_ERROR =
  "1 package has an invalid registry signature:\n\nThe packument endpoint (at https://registry.npmjs.org/clsx) responded with 503: Service Unavailable";

// The registry's signing key, shaped the way npm publishes it.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY = { keyid: "SHA256:test", key: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
const signature = (integrity: string) => ({
  keyid: KEY.keyid,
  sig: sign("sha256", Buffer.from(`clsx@2.1.1:${integrity}`), privateKey).toString("base64"),
});

const dirs: string[] = [];
let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the script with a fake `pnpm` that fails `audit signatures` with each
 * of `failures` in turn and then passes, against a local registry that signs
 * `registryIntegrity` for clsx@2.1.1. Every pnpm call is logged.
 */
async function run(failures: string[], registryIntegrity = INTEGRITY) {
  const dir = mkdtempSync(join(tmpdir(), "audit-signatures-"));
  dirs.push(dir);
  writeFileSync(join(dir, "count"), "0");
  failures.forEach((failure, index) => {
    writeFileSync(join(dir, `fail-${index + 1}`), failure);
  });
  writeFileSync(join(dir, "pnpm-lock.yaml"), LOCKFILE);
  const pnpm = join(dir, "pnpm");
  writeFileSync(
    pnpm,
    `#!/usr/bin/env bash
n=$(( $(cat "${dir}/count") + 1 )); echo "$n" > "${dir}/count"
echo "$*" >> "${dir}/calls"
if [ -f "${dir}/fail-$n" ]; then cat "${dir}/fail-$n" >&2; exit 1; fi
echo "${OK.replaceAll("\n", "\\n")}"
`,
  );
  chmodSync(pnpm, 0o755);

  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/-/npm/v1/keys") return void res.end(JSON.stringify({ keys: [KEY] }));
    res.end(JSON.stringify({ dist: { integrity: registryIntegrity, signatures: [signature(registryIntegrity)] } }));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const child = spawn(SCRIPT, [join(dir, "pnpm-lock.yaml")], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      AUDIT_SIGNATURES_BACKOFF: "0",
      LOCKFILE_INTEGRITY_REGISTRY: `http://127.0.0.1:${port}`,
      LOCKFILE_INTEGRITY_BACKOFF: "0",
    },
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk;
    });
  }
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : [];
  return { ok: status === 0, output, calls };
}

describe("audit-signatures.sh", () => {
  it("passes when pnpm verifies the signatures and the lockfile holds the signed integrity", async () => {
    const { ok, calls, output } = await run([]);
    expect(calls).toEqual(["audit signatures"]);
    expect(output).toContain("322 packages have verified registry signatures");
    expect(output).toContain("all 1 integrity values");
    expect(ok).toBe(true);
  });

  it("fails when the lockfile holds an integrity the registry did not sign, though pnpm is satisfied", async () => {
    // `pnpm audit signatures` checks the registry's own integrity, not the lockfile's: this is the gap.
    const { ok, output } = await run([], OTHER);
    expect(ok).toBe(false);
    expect(output).toContain(
      `clsx@2.1.1: pnpm-lock.yaml records ${INTEGRITY}, which no registry signature covers (the registry reports ${OTHER})`,
    );
  });

  it("fails at once on an invalid signature, without a retry", async () => {
    const { ok, calls, output } = await run([INVALID]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(output).toContain("failed on a package, not on reaching the registry");
  });

  it("fails at once on a missing signature, without a retry", async () => {
    const { ok, calls } = await run([MISSING]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("fails at once on an error it does not recognise", async () => {
    const { ok, calls } = await run(["Error: ERR_PNPM_SOMETHING_ELSE"]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("retries when the registry cannot be reached or answers 5xx, then passes", async () => {
    const { ok, calls, output } = await run([NO_KEYS, SERVER_ERROR]);
    expect(calls).toHaveLength(3);
    expect(output).toContain("could not reach the registry (attempt 1 of 3); retrying");
    expect(ok).toBe(true);
  });

  it("gives up after three attempts when the registry never answers", async () => {
    const { ok, calls, output } = await run([NO_KEYS, NO_KEYS, NO_KEYS]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(3);
    expect(output).toContain("could not reach the registry in 3 attempts");
  });
});
