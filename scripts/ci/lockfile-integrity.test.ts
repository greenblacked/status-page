import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { check, type Entry, parseLockfile, registryIntegrity } from "./lockfile-integrity.ts";

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

const fast = { attempts: 3, backoffMs: 0 };
const manifest = (integrity?: string) => ({ status: 200, json: async () => ({ dist: { integrity } }) });
const status = (code: number) => ({ status: code, json: async () => ({}) });

describe("registryIntegrity", () => {
  const entry: Entry = { name: "@scope/pkg", version: "1.2.3", integrity: A };

  it("asks the registry for that version's manifest, with a scoped name's slash encoded", async () => {
    const urls: string[] = [];
    const result = await registryIntegrity("https://registry.example/", entry, {
      ...fast,
      fetch: async (url) => {
        urls.push(url);
        return manifest(A);
      },
    });
    expect(result).toEqual({ integrity: A });
    expect(urls).toEqual(["https://registry.example/@scope%2Fpkg/1.2.3"]);
  });

  it("retries a 5xx, a 429 and a dropped connection, then answers", async () => {
    const answers = [
      () => status(503),
      () => status(429),
      () => Promise.reject(new Error("socket hang up")),
      () => manifest(A),
    ];
    let calls = 0;
    const result = await registryIntegrity("https://r", entry, {
      attempts: 4,
      backoffMs: 0,
      fetch: async () => answers[calls++]?.() as never,
    });
    expect(calls).toBe(4);
    expect(result).toEqual({ integrity: A });
  });

  it("gives up after its attempts and says why", async () => {
    let calls = 0;
    const result = await registryIntegrity("https://r", entry, {
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
    const missing = await registryIntegrity("https://r", entry, {
      ...fast,
      fetch: async () => {
        calls++;
        return status(404);
      },
    });
    expect(calls).toBe(1);
    expect(missing.error).toContain("no such version");
    expect((await registryIntegrity("https://r", entry, { ...fast, fetch: async () => manifest() })).error).toContain(
      "no integrity",
    );
  });
});

describe("check", () => {
  it("passes when the registry signs exactly the lockfile's integrity", async () => {
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check({ ...parsed, malformed: [] }, "https://r", {
      ...fast,
      fetch: async (url) => manifest(url.includes("clsx") ? C : url.includes("exe") ? A : B),
    });
    expect(failures).toEqual([]);
  });

  it("names every entry whose integrity differs, and every entry the lockfile has no sha512 for", async () => {
    const parsed = parseLockfile(LOCKFILE);
    const failures = await check(parsed, "https://r", { ...fast, fetch: async () => manifest(B) });
    expect(failures).toEqual([
      `@pnpm/exe.linux-x64@12.8.1: pnpm-lock.yaml records ${A}, but the registry signs ${B}`,
      `broken@3.0.0: the lockfile records no sha512 integrity for it`,
      `clsx@2.1.1: pnpm-lock.yaml records ${C}, but the registry signs ${B}`,
    ]);
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

  async function run(lockfile: string, answer: (path: string) => string | undefined) {
    server = createServer((req, res) => {
      const integrity = answer(req.url ?? "");
      res.writeHead(integrity ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ dist: { integrity } }));
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

  const signed = (path: string) => (path.includes("clsx") ? C : path.includes("exe") ? A : B);

  it("exits 0 when every integrity is the signed one", async () => {
    const { status, output } = await run(VALID, signed);
    expect(output).toContain("all 3 integrity values");
    expect(status).toBe(0);
  });

  it("exits 1 and names the package when one differs", async () => {
    const { status, output } = await run(VALID, (path) => (path.includes("clsx") ? B : signed(path)));
    expect(status).toBe(1);
    expect(output).toContain(`clsx@2.1.1: pnpm-lock.yaml records ${C}, but the registry signs ${B}`);
  });

  it("exits 1 on a lockfile with no registry package, rather than passing on nothing", async () => {
    const { status, output } = await run("lockfileVersion: '9.0'\n", signed);
    expect(status).toBe(1);
    expect(output).toContain("refusing to pass");
  });
});
