import { spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { check, type Entry, isSigned, parseLockfile, registryKeys, registryVersion } from "./lockfile-integrity.ts";

const SCRIPT = fileURLToPath(new URL("./lockfile-integrity.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const A = `sha512-${"A".repeat(86)}==`;
const B = `sha512-${"B".repeat(86)}==`;
const C = `sha512-${"C".repeat(86)}==`;

const LOCKFILE = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.8.1
        version: 12.8.1

packages:

  '@pnpm/exe.linux-x64@12.8.1':
    resolution: {integrity: ${A}}
    cpu: [x64]

  pnpm@12.8.1:
    resolution: {integrity: ${B}}
    hasBin: true

snapshots:

  pnpm@12.8.1: {}

---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      clsx:
        specifier: 2.1.1
        version: 2.1.1

packages:

  clsx@2.1.1:
    resolution: {integrity: ${C}}
    engines: {node: '>=6'}

  pnpm@12.8.1:
    resolution: {integrity: ${B}}

  from-git@1.0.0:
    resolution: {tarball: https://codeload.github.com/example/from-git/tar.gz/abc123}
    version: 1.0.0

  other@git+https://example.com/other.git#abc:
    resolution: {commit: abc, repo: https://example.com/other.git, type: git}

  no-integrity@2.0.0:
    resolution: {directory: vendor/no-integrity, type: directory}

  broken@3.0.0:
    resolution: {integrity: sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=}

snapshots:

  clsx@2.1.1: {}
`;

/** The lockfile without its one malformed entry, which the CLI refuses outright. */
const VALID = LOCKFILE.replace(/ {2}broken@3\.0\.0:\n {4}resolution: .*\n\n/, "");

describe("parseLockfile", () => {
  it("reads the packages of every YAML document, once each, with scoped names and versions split at the last @", () => {
    const { entries } = parseLockfile(LOCKFILE);
    expect(entries).toEqual<Entry[]>([
      { name: "@pnpm/exe.linux-x64", version: "12.8.1", integrity: A },
      { name: "pnpm", version: "12.8.1", integrity: B },
      { name: "clsx", version: "2.1.1", integrity: C },
    ]);
  });

  it("skips what is not from the registry, and reports a registry package with no sha512", () => {
    const { skipped, malformed } = parseLockfile(LOCKFILE);
    expect(skipped).toEqual(["from-git@1.0.0", "other@git+https://example.com/other.git#abc", "no-integrity@2.0.0"]);
    expect(malformed).toEqual(["broken@3.0.0"]);
  });

  it("reads this repository's lockfile: every package, nothing malformed or skipped", () => {
    const { entries, skipped, malformed } = parseLockfile(readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8"));
    const names = entries.map((e) => `${e.name}@${e.version}`);
    expect(names).toContain("react@19.3.0");
    expect(names).toContain("@typescript/typescript6@6.0.2");
    expect(names).toContain("typescript@6.0.3");
    expect(entries.length).toBeGreaterThan(300);
    expect(skipped).toEqual([]);
    expect(malformed).toEqual([]);
  });
});

/** An ECDSA P-256 signing key, shaped the way npm publishes its keys. */
function signer(keyid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return {
    keyid,
    listed: { keyid, keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256", expires: null, key },
    /** The signature npm makes: over `name@version:integrity`. */
    sign: (e: Entry, integrity = e.integrity) => ({
      keyid,
      sig: sign("sha256", Buffer.from(`${e.name}@${e.version}:${integrity}`), privateKey).toString("base64"),
    }),
  };
}

const npm = signer("SHA256:npm");
const other = signer("SHA256:other");

const fast = { attempts: 3, backoffMs: 0 };
const document = (dist: object) => ({ status: 200, json: async () => ({ dist }) });
const status = (code: number) => ({ status: code, json: async () => ({}) });
const keysDocument = (...signers: ReturnType<typeof signer>[]) => ({
  status: 200,
  json: async () => ({ keys: signers.map((k) => k.listed) }),
});

/** The version document a registry serves for a lockfile entry that npm signed. */
const signedBy = (s: ReturnType<typeof signer>, e: Entry) =>
  document({ integrity: e.integrity, signatures: [s.sign(e)] });

describe("registryKeys", () => {
  it("reads the signing keys by key id", async () => {
    const urls: string[] = [];
    const { keys } = await registryKeys("https://registry.example/", {
      ...fast,
      fetch: async (url) => {
        urls.push(url);
        return keysDocument(npm, other);
      },
    });
    expect(urls).toEqual(["https://registry.example/-/npm/v1/keys"]);
    expect([...(keys?.keys() ?? [])]).toEqual(["SHA256:npm", "SHA256:other"]);
  });

  it("reports a registry with no keys and one that cannot be reached", async () => {
    const none = await registryKeys("https://r", {
      ...fast,
      fetch: async () => ({ status: 200, json: async () => ({}) }),
    });
    expect(none.error).toContain("no signing keys");
    const down = await registryKeys("https://r", { ...fast, fetch: async () => status(503) });
    expect(down.error).toContain("HTTP 503");
  });
});

describe("registryVersion", () => {
  const entry: Entry = { name: "@scope/pkg", version: "1.2.3", integrity: A };

  it("asks the registry for that version's manifest, with a scoped name's slash encoded", async () => {
    const urls: string[] = [];
    const result = await registryVersion("https://registry.example/", entry, {
      ...fast,
      fetch: async (url) => {
        urls.push(url);
        return signedBy(npm, entry);
      },
    });
    expect(result.integrity).toBe(A);
    expect(result.signatures).toEqual([{ keyid: npm.keyid, sig: expect.any(String) }]);
    expect(urls).toEqual(["https://registry.example/@scope%2Fpkg/1.2.3"]);
  });

  it("retries a 5xx, a 429 and a dropped connection, then answers", async () => {
    const answers = [
      () => status(503),
      () => status(429),
      () => Promise.reject(new Error("socket hang up")),
      () => document({ integrity: A, signatures: [] }),
    ];
    let calls = 0;
    const result = await registryVersion("https://r", entry, {
      attempts: 4,
      backoffMs: 0,
      fetch: async () => answers[calls++]?.() as never,
    });
    expect(calls).toBe(4);
    expect(result).toEqual({ integrity: A, signatures: [] });
  });

  it("gives up after its attempts and says why", async () => {
    let calls = 0;
    const result = await registryVersion("https://r", entry, {
      ...fast,
      fetch: async () => {
        calls++;
        return status(502);
      },
    });
    expect(calls).toBe(3);
    expect(result.error).toContain("HTTP 502");
  });

  it("does not retry a 404, and reports a manifest with no integrity", async () => {
    let calls = 0;
    const missing = await registryVersion("https://r", entry, {
      ...fast,
      fetch: async () => {
        calls++;
        return status(404);
      },
    });
    expect(calls).toBe(1);
    expect(missing.error).toContain("no such version");
    expect((await registryVersion("https://r", entry, { ...fast, fetch: async () => document({}) })).error).toContain(
      "no integrity",
    );
  });

  it("ignores a signature entry that is not a key id and a signature", async () => {
    const result = await registryVersion("https://r", entry, {
      ...fast,
      fetch: async () => document({ integrity: A, signatures: [{ keyid: 1 }, null, { keyid: "k", sig: "s" }] }),
    });
    expect(result.signatures).toEqual([{ keyid: "k", sig: "s" }]);
  });
});

describe("isSigned", () => {
  const entry: Entry = { name: "clsx", version: "2.1.1", integrity: C };
  const keys = new Map([
    [npm.keyid, npm.listed.key],
    [other.keyid, other.listed.key],
  ]);

  it("accepts a valid signature over name@version:integrity from a known key", () => {
    expect(isSigned(entry, [npm.sign(entry)], keys)).toBe(true);
  });

  it("accepts when any one of several signatures verifies", () => {
    expect(isSigned(entry, [{ keyid: "SHA256:gone", sig: "AAAA" }, npm.sign(entry)], keys)).toBe(true);
  });

  it("rejects a signature over another integrity, version or name", () => {
    expect(isSigned(entry, [npm.sign(entry, B)], keys)).toBe(false);
    expect(isSigned(entry, [npm.sign({ ...entry, version: "2.1.2" })], keys)).toBe(false);
    expect(isSigned(entry, [npm.sign({ ...entry, name: "clsy" })], keys)).toBe(false);
  });

  it("rejects an unknown key id, a signature made by another key, and garbage", () => {
    expect(isSigned(entry, [{ keyid: "SHA256:unknown", sig: npm.sign(entry).sig }], keys)).toBe(false);
    expect(isSigned(entry, [{ keyid: npm.keyid, sig: other.sign(entry).sig }], keys)).toBe(false);
    expect(isSigned(entry, [{ keyid: npm.keyid, sig: "not base64 at all" }], keys)).toBe(false);
    expect(isSigned(entry, [{ keyid: npm.keyid, sig: npm.sign(entry).sig }], new Map([[npm.keyid, "AAAA"]]))).toBe(
      false,
    );
  });

  it("uses node:crypto's own parsing of the published key", () => {
    expect(
      createPublicKey({ key: Buffer.from(npm.listed.key, "base64"), format: "der", type: "spki" }).asymmetricKeyType,
    ).toBe("ec");
  });
});

describe("check", () => {
  const entries = parseLockfile(LOCKFILE).entries;
  const find = (url: string) =>
    entries.find((e) => url.includes(e.name.replace("/", "%2F")) && url.endsWith(e.version));
  const mock = (answer: (e: Entry) => ReturnType<typeof document>) => async (url: string) => {
    if (url.endsWith("/-/npm/v1/keys")) return keysDocument(npm);
    const e = find(url);
    return e ? answer(e) : status(404);
  };

  it("passes when the registry signs exactly the lockfile's integrity", async () => {
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check({ ...parsed, malformed: [] }, "https://r", {
      ...fast,
      fetch: mock((e) => signedBy(npm, e)),
    });
    expect(failures).toEqual([]);
  });

  it("names every entry the lockfile has no sha512 for, and every one with no signature", async () => {
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check(parsed, "https://r", {
      ...fast,
      fetch: mock((e) => (e.name === "clsx" ? document({ integrity: e.integrity }) : signedBy(npm, e))),
    });
    expect(failures).toEqual([
      "broken@3.0.0: the lockfile records no sha512 integrity for it",
      "clsx@2.1.1: the registry gives no signature for it",
    ]);
  });

  it("fails when the version document and the signature disagree about the integrity", async () => {
    // A registry (or proxy) that reports the lockfile's tampered integrity in
    // the unsigned document, beside the signature over the real one. The
    // document agrees with the lockfile; the signature does not.
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check({ ...parsed, malformed: [] }, "https://r", {
      ...fast,
      fetch: mock((e) =>
        e.name === "clsx" ? document({ integrity: e.integrity, signatures: [npm.sign(e, B)] }) : signedBy(npm, e),
      ),
    });
    expect(failures).toEqual([
      `clsx@2.1.1: no registry signature verifies over the integrity pnpm-lock.yaml records, ${C}`,
    ]);
  });

  it("fails when the lockfile's integrity is not the signed one, and says what the registry reports", async () => {
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check({ ...parsed, malformed: [] }, "https://r", {
      ...fast,
      fetch: mock((e) => document({ integrity: B, signatures: [npm.sign(e, B)] })),
    });
    expect(failures).toEqual([
      `@pnpm/exe.linux-x64@12.8.1: pnpm-lock.yaml records ${A}, which no registry signature covers (the registry reports ${B})`,
      `clsx@2.1.1: pnpm-lock.yaml records ${C}, which no registry signature covers (the registry reports ${B})`,
    ]);
  });

  it("passes a lockfile integrity that is signed even when the unsigned document says otherwise", async () => {
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check({ ...parsed, malformed: [] }, "https://r", {
      ...fast,
      fetch: mock((e) => document({ integrity: B, signatures: [npm.sign(e)] })),
    });
    expect(failures).toEqual([]);
  });

  it("fails when a signature is by a key the registry does not list", async () => {
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check({ ...parsed, malformed: [] }, "https://r", {
      ...fast,
      fetch: mock((e) => document({ integrity: e.integrity, signatures: [other.sign(e)] })),
    });
    expect(failures).toHaveLength(3);
  });

  it("fails with one message when the registry's keys cannot be fetched", async () => {
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check({ ...parsed, malformed: [] }, "https://r", {
      ...fast,
      fetch: async () => status(503),
    });
    expect(failures).toEqual(["the registry's signing keys: the registry answered HTTP 503"]);
  });
});

describe("lockfile-integrity.ts", () => {
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  type Doc = { integrity?: string; signed?: string };

  /** `answer` gives, per request path, the integrity the document reports and the one the signature covers. */
  async function run(lockfile: string, answer: (path: string) => Doc | undefined) {
    server = createServer((req, res) => {
      const path = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      if (path === "/-/npm/v1/keys") return void res.end(JSON.stringify({ keys: [npm.listed] }));
      const doc = answer(path);
      if (!doc) return void res.writeHead(404).end("{}");
      const entry = parseLockfile(lockfile).entries.find((e) => path.includes(e.name.replace("/", "%2F")));
      const covered = doc.signed ?? entry?.integrity ?? "";
      const e = entry ?? { name: "", version: "", integrity: "" };
      res.end(JSON.stringify({ dist: { integrity: doc.integrity, signatures: [npm.sign(e, covered)] } }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    dir = mkdtempSync(join(tmpdir(), "lockfile-integrity-"));
    const file = join(dir, "pnpm-lock.yaml");
    writeFileSync(file, lockfile);
    const child = spawn("node", ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", SCRIPT, file], {
      env: { ...process.env, LOCKFILE_INTEGRITY_REGISTRY: `http://127.0.0.1:${port}`, LOCKFILE_INTEGRITY_BACKOFF: "0" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { status, output };
  }

  const signed = (path: string): Doc => ({ integrity: path.includes("clsx") ? C : path.includes("exe") ? A : B });

  it("exits 0 when every integrity is a signed one", async () => {
    const { status, output } = await run(VALID, signed);
    expect(output).toContain("all 3 integrity values");
    expect(status).toBe(0);
  });

  it("exits 1 and names the package when the signature covers another integrity", async () => {
    const { status, output } = await run(VALID, (path) => ({
      ...signed(path),
      signed: path.includes("clsx") ? B : undefined,
    }));
    expect(status).toBe(1);
    expect(output).toContain(
      `clsx@2.1.1: no registry signature verifies over the integrity pnpm-lock.yaml records, ${C}`,
    );
  });

  it("exits 1 when the document reports another integrity than the lockfile's and signs it", async () => {
    const { status, output } = await run(VALID, (path) =>
      path.includes("clsx") ? { integrity: B, signed: B } : signed(path),
    );
    expect(status).toBe(1);
    expect(output).toContain(`clsx@2.1.1: pnpm-lock.yaml records ${C}, which no registry signature covers`);
  });

  it("exits 1 on a lockfile with no registry package, rather than passing on nothing", async () => {
    const { status, output } = await run("lockfileVersion: '9.0'\n", signed);
    expect(status).toBe(1);
    expect(output).toContain("refusing to pass");
  });
});
