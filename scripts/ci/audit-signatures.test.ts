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

// What pnpm 12 prints (shaped after real runs; the signing-keys errors below are verbatim).
const OK = "audited 322 packages\n\n322 packages have verified registry signatures";
const INVALID =
  "1 package has an invalid registry signature:\n\nclsx@2.1.1 has an invalid registry signature with keyid SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA\n\nSomeone might have tampered with this package since it was published on the registry!";
const MISSING =
  "321 packages have verified registry signatures\n\n1 package is missing registry signature but the registry is providing signing keys:";
// Real `pnpm audit signatures` 12.8.1 output (no terminal) when it cannot fetch the
// registry's signing keys. It prints this before it audits any package. miette draws
// the message with "×" and wraps it at 80 columns onto "│" lines, in the middle of a URL.
const KEYS_DNS = `Error: ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL

  × Failed to request the registry keys endpoint (at https://
  │ registry.npmjs.invalid/-/npm/v1/keys): error sending request for url
  │ (https://registry.npmjs.invalid/-/npm/v1/keys)
`;
const KEYS_REFUSED = `Error: ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL

  × Failed to request the registry keys endpoint (at http://127.0.0.1:48772/-/
  │ npm/v1/keys): error sending request for url (http://127.0.0.1:48772/-/npm/
  │ v1/keys)
`;
const KEYS_TRUNCATED = `Error: ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL

  × Failed to request the registry keys endpoint (at http://127.0.0.1:49105/-/
  │ npm/v1/keys): error decoding response body for url
  │ (http://127.0.0.1:49105/-/npm/v1/keys)
`;
const KEYS_INVALID_JSON = `Error: ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL

  × The registry keys endpoint (at http://127.0.0.1:49104/-/npm/v1/keys)
  │ returned invalid JSON: key must be a string at line 1 column 2. Response
  │ body: {not json
`;
const KEYS_503 = `Error: ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL

  × The registry keys endpoint (at http://127.0.0.1:49201/-/npm/v1/keys)
  │ responded with 503: Service Unavailable
`;
// The same, on a terminal without Unicode: an ASCII "x" for the "×".
const KEYS_ASCII = KEYS_DNS.replace("×", "x");
const NO_KEYS = [KEYS_DNS, KEYS_REFUSED, KEYS_TRUNCATED, KEYS_INVALID_JSON, KEYS_503, KEYS_ASCII];
const SERVER_ERROR =
  "1 package has an invalid registry signature:\n\nThe packument endpoint (at https://registry.npmjs.org/clsx) responded with 503: Service Unavailable";
// A manifest response that came back unreadable (truncated or corrupt body):
// pnpm lists the package under "invalid registry signature" with this cause
// instead of a key id (CI run 37353864878).
const UNREADABLE_MANIFEST =
  "audited 306 packages\n\n306 packages have verified registry signatures\n\n1 package has an invalid registry signature:\n\n| @playwright/test@1.63.0 | https://registry.npmjs.org/ | Failed to request the packument endpoint (at https://registry.npmjs.org/@playwright%2Ftest): error decoding response body for url (https://registry.npmjs.org/@playwright%2Ftest) |\n\nSomeone might have tampered with this package since it was published on the registry!";
// The other package-level failures pnpm 12.8.1 prints, taken from real runs
// against a fake registry. It prints them as rows of a box-drawn table: package,
// registry, cause.
const REGISTRY = "http://127.0.0.1:48799/";
const UNKNOWN_KEY = [
  "aaa@1.0.0",
  "aaa@1.0.0 has a registry signature with keyid SHA256:nope but no corresponding public key can be found",
];
const EXPIRED_KEY = [
  "aaa@1.0.0",
  "aaa@1.0.0 has a registry signature with keyid SHA256:test but the corresponding public key has expired 2020-01-01T00:00:00.000Z",
];
const MALFORMED_METADATA = ["aaa@1.0.0", "Malformed registry signatures metadata for aaa@1.0.0"];
const MISSING_METADATA = ["aaa@1.0.0", "Missing registry metadata for aaa@1.0.0"];
const BAD_SIGNATURE = ["aaa@1.0.0", "aaa@1.0.0 has an invalid registry signature with keyid SHA256:test"];
const UNKNOWN_WORDING = ["aaa@1.0.0", "aaa@1.0.0 could not be checked for a reason pnpm never printed before"];
const NOT_FOUND = ["aaa@1.0.0", `The packument endpoint (at ${REGISTRY}aaa) responded with 404: Not Found`];
// The two rows that are only a registry that could not answer.
const UNREADABLE_ROW = [
  "bbb@1.0.0",
  `Failed to request the packument endpoint (at ${REGISTRY}bbb): error decoding response body for url (${REGISTRY}bbb)`,
];
const SERVER_ERROR_ROW = [
  "bbb@1.0.0",
  `The packument endpoint (at ${REGISTRY}bbb) responded with 503: Service Unavailable`,
];
const TOO_MANY_ROW = ["bbb@1.0.0", `The packument endpoint (at ${REGISTRY}bbb) responded with 429: Too Many Requests`];

/** A table the way pnpm draws it: the cells padded to the widest in their column. */
function table(rows: string[][]) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const rule = (left: string, middle: string, right: string) =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
  const body = rows.map((row) => `│ ${row.map((cell, column) => cell.padEnd(widths[column])).join(" │ ")} │`);
  return [rule("┌", "┬", "┐"), body.join(`\n${rule("├", "┼", "┤")}\n`), rule("└", "┴", "┘")].join("\n");
}

/** What `pnpm audit signatures` prints for rows under "invalid registry signature". */
function invalidReport(...failures: string[][]) {
  const count = failures.length;
  const rows = failures.map(([pkg, cause]) => [pkg, REGISTRY, cause]);
  return [
    `audited ${count + 1} packages`,
    count === 1
      ? "1 package has an invalid registry signature:"
      : `${count} packages have invalid registry signatures:`,
    table(rows),
    `Someone might have tampered with ${count === 1 ? "this package" : "these packages"} since ${count === 1 ? "it was" : "they were"} published on the registry!`,
  ].join("\n\n");
}

/** The separate section pnpm prints for a package whose version has no signature at all. */
const NO_SIGNATURE = [
  "audited 2 packages",
  "1 package is missing registry signature but the registry is providing signing keys:",
  table([["aaa@1.0.0", REGISTRY]]),
].join("\n\n");

// The registry's signing key, shaped the way npm publishes it.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY = {
  keyid: "SHA256:test",
  key: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64"),
};
const signature = (integrity: string) => ({
  keyid: KEY.keyid,
  sig: Buffer.from(sign("sha256", Buffer.from(`clsx@2.1.1:${integrity}`), privateKey)).toString("base64"),
});

// Some cases start the script dozens of times.
const SLOW = 60_000;

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
    const { ok, calls, output } = await run([KEYS_DNS, SERVER_ERROR]);
    expect(calls).toHaveLength(3);
    expect(output).toContain("could not reach the registry (attempt 1 of 3); retrying");
    expect(ok).toBe(true);
  });

  it("gives up after three attempts when the registry never answers", async () => {
    const { ok, calls, output } = await run([KEYS_DNS, KEYS_REFUSED, KEYS_TRUNCATED]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(3);
    expect(output).toContain("could not reach the registry in 3 attempts");
  });

  it(
    "retries when the signing keys cannot be fetched, as pnpm prints it (wrapped, with a Unicode or an ASCII marker), then passes",
    async () => {
      for (const keys of NO_KEYS) {
        for (const output of [
          keys,
          keys.replaceAll("\n", "\r\n"),
          keys.replaceAll(/^.+$/gm, (line) => `\u001b[31m${line}\u001b[39m`),
          keys.replaceAll("│", "|"),
        ]) {
          const { ok, calls, output: log } = await run([output]);
          expect(calls).toHaveLength(2);
          expect(log).toContain("could not reach the registry (attempt 1 of 3); retrying");
          expect(ok).toBe(true);
        }
      }
    },
    SLOW,
  );

  it(
    "fails at once when the signing keys error is printed beside a package that failed",
    async () => {
      const rows = [UNKNOWN_KEY, EXPIRED_KEY, BAD_SIGNATURE, MALFORMED_METADATA, MISSING_METADATA, UNREADABLE_ROW];
      for (const keys of [KEYS_DNS, KEYS_503, KEYS_ASCII]) {
        for (const row of rows) {
          for (const output of [
            `${keys}\n${invalidReport(row)}`,
            `${invalidReport(row)}\n\n${keys}`,
            // No blank line after the message: the table must not be read as wrapped text.
            `${keys.trimEnd()}\n${invalidReport(row).split("\n").filter(Boolean).slice(2).join("\n")}`,
          ]) {
            const { ok, calls, output: log } = await run([output]);
            expect(ok).toBe(false);
            expect(calls).toHaveLength(1);
            expect(log).toContain("failed on a package, not on reaching the registry");
          }
        }
        for (const output of [`${keys}\n${NO_SIGNATURE}`, `${NO_SIGNATURE}\n\n${keys}`, `${keys}\n${INVALID}`]) {
          const { ok, calls } = await run([output]);
          expect(ok).toBe(false);
          expect(calls).toHaveLength(1);
        }
      }
    },
    SLOW,
  );

  it("fails at once on text under the signing keys error that is not its message", async () => {
    for (const output of [
      `${KEYS_DNS}\nsomething else went wrong`,
      `${KEYS_DNS}  help: ignore this\n`,
      "Error: ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL\n\nsomething else went wrong\n",
    ]) {
      const { ok, calls } = await run([output]);
      expect(ok).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("retries a manifest the registry returned unreadable, then passes", async () => {
    const { ok, calls, output } = await run([UNREADABLE_MANIFEST]);
    expect(calls).toHaveLength(2);
    expect(output).toContain("could not reach the registry (attempt 1 of 3); retrying");
    expect(ok).toBe(true);
  });

  it("gives up after three attempts when the manifest never comes back readable", async () => {
    const { ok, calls, output } = await run([UNREADABLE_MANIFEST, UNREADABLE_MANIFEST, UNREADABLE_MANIFEST]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(3);
    expect(output).toContain("could not reach the registry in 3 attempts");
  });

  it("fails at once when an unreadable manifest is listed beside an invalid signature", async () => {
    const mixed = `${UNREADABLE_MANIFEST}\n\n${INVALID}`;
    const { ok, calls, output } = await run([mixed]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(output).toContain("failed on a package, not on reaching the registry");
  });

  it("fails at once when an unreadable manifest is listed beside a missing signature", async () => {
    const { ok, calls } = await run([`${UNREADABLE_MANIFEST}\n\n${MISSING}`]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("retries rows that are all a registry that could not answer, as pnpm prints them, then passes", async () => {
    for (const rows of [[UNREADABLE_ROW], [SERVER_ERROR_ROW], [TOO_MANY_ROW], [UNREADABLE_ROW, SERVER_ERROR_ROW]]) {
      const { ok, calls, output } = await run([invalidReport(...rows)]);
      expect(calls).toHaveLength(2);
      expect(output).toContain("could not reach the registry (attempt 1 of 3); retrying");
      expect(ok).toBe(true);
    }
  });

  it("reads the table with ANSI colours, CRLF line ends and ASCII bars", async () => {
    const real = invalidReport(UNREADABLE_ROW);
    for (const output of [
      real.replaceAll(/^│.*$/gm, (row) => `\u001b[31m${row}\u001b[39m`),
      real.replaceAll("\n", "\r\n"),
      real.replaceAll("│", "|"),
    ]) {
      const { ok, calls } = await run([output]);
      expect(calls).toHaveLength(2);
      expect(ok).toBe(true);
    }
  });

  it.each([
    ["an invalid signature", BAD_SIGNATURE],
    ["an unknown key", UNKNOWN_KEY],
    ["an expired key", EXPIRED_KEY],
    ["malformed signature metadata", MALFORMED_METADATA],
    ["missing registry metadata", MISSING_METADATA],
    ["a cause pnpm never printed before", UNKNOWN_WORDING],
    ["a 404 from the packument endpoint", NOT_FOUND],
  ])(
    "fails at once, without a retry, on %s (alone, and in one table with an unreadable manifest or a 5xx)",
    async (_name, failure) => {
      for (const rows of [
        [failure],
        [UNREADABLE_ROW, failure],
        [failure, UNREADABLE_ROW],
        [SERVER_ERROR_ROW, failure],
        [UNREADABLE_ROW, failure, SERVER_ERROR_ROW],
      ]) {
        const { ok, calls, output } = await run([invalidReport(...rows)]);
        expect(ok).toBe(false);
        expect(calls).toHaveLength(1);
        expect(output).toContain("failed on a package, not on reaching the registry");
        expect(output).not.toContain("could not reach the registry");
      }
    },
  );

  it("fails at once on a missing signature, alone and beside an unreadable manifest or a 5xx", async () => {
    for (const reach of [UNREADABLE_ROW, SERVER_ERROR_ROW]) {
      for (const output of [
        NO_SIGNATURE,
        `${NO_SIGNATURE}\n\n${invalidReport(reach)}`,
        `${invalidReport(reach)}\n\n${NO_SIGNATURE}`,
      ]) {
        const { ok, calls } = await run([output]);
        expect(ok).toBe(false);
        expect(calls).toHaveLength(1);
      }
    }
  });

  it("fails at once on a row it cannot parse, or one the heading does not count", async () => {
    const real = invalidReport(UNREADABLE_ROW, SERVER_ERROR_ROW);
    for (const output of [
      real.replace("│ bbb@1.0.0", "│"),
      real.replace("2 packages have", "3 packages have"),
      real.replace("2 packages have invalid registry signatures:\n\n", ""),
      `${real}\n\nsomething else went wrong`,
    ]) {
      const { ok, calls } = await run([output]);
      expect(ok).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it("fails at once when a connection error is printed beside a package that failed", async () => {
    const { ok, calls } = await run([`${invalidReport(UNKNOWN_KEY)}\n\nError: connect ETIMEDOUT 104.16.0.1:443`]);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
