// Checks that every integrity pnpm-lock.yaml records is one the npm registry
// signed for that package version.
//
//   node --experimental-strip-types scripts/ci/lockfile-integrity.ts [pnpm-lock.yaml]
//
// `pnpm audit signatures` verifies the registry's signature over the
// integrity the registry itself reports for a version. It does not compare
// that integrity with the lockfile's, so a lockfile line edited to point at
// other bytes would still audit clean. `npm audit signatures` did compare,
// because it verified the signature over the integrity of the installed
// package. This script closes that gap: for each lockfile entry it verifies,
// with node:crypto and the registry's published signing keys
// (/-/npm/v1/keys), a signature of the version document over
// `<name>@<version>:<the lockfile's own integrity>`. It does not trust the
// version document's unsigned `dist.integrity`, which a registry, mirror or
// proxy could set apart from the signature. Run after `pnpm install` has
// checked the tarballs it downloaded against the lockfile, it makes the
// lockfile's integrity a signed one. scripts/ci/audit-signatures.sh runs
// the two together.
//
// A key's `expires` is not checked: packages published before a key was
// rotated out keep their signatures, and a version published with an expired
// key must still verify. The signing keys are fetched from the same registry
// as the signatures, as `npm audit signatures` does.
//
// Every YAML document of the file is read (this repository's has one: see
// pmOnFail in pnpm-workspace.yaml). Entries that do not come from the
// registry (a git or tarball URL) are listed and skipped, as
// `npm audit signatures` skipped them.
//
// LOCKFILE_INTEGRITY_REGISTRY points it at another registry (tests do), and
// LOCKFILE_INTEGRITY_BACKOFF sets the first retry wait in seconds (default 2).

import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Entry = { name: string; version: string; integrity: string };
export type Signature = { keyid: string; sig: string };
export type Keys = Map<string, string>;
export type Parsed = { entries: Entry[]; skipped: string[]; malformed: string[] };

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The `packages:` entries of every YAML document in a pnpm-lock.yaml. */
export function parseLockfile(text: string): Parsed {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  const skipped: string[] = [];
  const malformed: string[] = [];
  for (const doc of text.split(/^---$/m)) {
    const lines = doc.split("\n");
    const start = lines.indexOf("packages:");
    if (start === -1) continue;
    let key: string | undefined;
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break; // the next top-level key, such as `snapshots:`
      const heading = /^ {2}(\S.*):$/.exec(line);
      if (heading) {
        key = heading[1]?.replace(/^'(.*)'$/, "$1");
        continue;
      }
      const resolution = /^ {4}resolution: \{(.*)\}$/.exec(line);
      if (!resolution || key === undefined) continue;
      const at = key.lastIndexOf("@");
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      const fields = resolution[1] ?? "";
      const integrity = /(?:^|, )integrity: (\S+?)(?:,|$)/.exec(fields)?.[1];
      if (at <= 0 || !SEMVER.test(version) || /(?:^|, )(?:tarball|type|repo|commit|directory): /.test(fields)) {
        skipped.push(key);
      } else if (!integrity?.startsWith("sha512-")) {
        malformed.push(key);
      } else if (!seen.has(key)) {
        seen.add(key);
        entries.push({ name, version, integrity });
      }
    }
  }
  return { entries, skipped, malformed };
}

type Fetch = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
type Options = { fetch?: Fetch; attempts?: number; backoffMs?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET a JSON document, retrying a 429, a 5xx and a dropped connection. */
async function getJson(url: string, options: Options): Promise<{ body?: unknown; error?: string; missing?: true }> {
  const doFetch = options.fetch ?? ((u: string) => fetch(u, { headers: { accept: "application/json" } }));
  const attempts = options.attempts ?? 4;
  const backoff = options.backoffMs ?? 2000;
  let error = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await doFetch(url);
      if (response.status === 404) return { missing: true, error: "the registry has no such version" };
      if (response.status === 429 || response.status >= 500) {
        error = `the registry answered HTTP ${response.status}`;
      } else if (response.status !== 200) {
        return { error: `the registry answered HTTP ${response.status}` };
      } else {
        return { body: await response.json() };
      }
    } catch (cause) {
      error = `could not reach the registry: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (attempt < attempts) await sleep(backoff * attempt);
  }
  return { error };
}

const base = (registry: string) => registry.replace(/\/$/, "");

/** The registry's signing keys: key id to base64 DER public key. */
export async function registryKeys(registry: string, options: Options = {}): Promise<{ keys?: Keys; error?: string }> {
  const { body, error } = await getJson(`${base(registry)}/-/npm/v1/keys`, options);
  if (error) return { error };
  const list = (body as { keys?: unknown } | undefined)?.keys;
  const keys: Keys = new Map();
  if (Array.isArray(list)) {
    for (const item of list as { keyid?: unknown; key?: unknown }[]) {
      if (typeof item?.keyid === "string" && typeof item.key === "string") keys.set(item.keyid, item.key);
    }
  }
  return keys.size > 0 ? { keys } : { error: "the registry lists no signing keys" };
}

/** What the registry says about one version: its (unsigned) integrity and its signatures. */
export async function registryVersion(
  registry: string,
  entry: Entry,
  options: Options = {},
): Promise<{ integrity?: string; signatures?: Signature[]; error?: string }> {
  const url = `${base(registry)}/${entry.name.replace("/", "%2F")}/${entry.version}`;
  const { body, error } = await getJson(url, options);
  if (error) return { error };
  const dist = (body as { dist?: { integrity?: unknown; signatures?: unknown } } | undefined)?.dist;
  if (typeof dist?.integrity !== "string") return { error: "the registry reports no integrity" };
  const signatures: Signature[] = [];
  if (Array.isArray(dist.signatures)) {
    for (const item of dist.signatures as { keyid?: unknown; sig?: unknown }[]) {
      if (typeof item?.keyid === "string" && typeof item.sig === "string") {
        signatures.push({ keyid: item.keyid, sig: item.sig });
      }
    }
  }
  return { integrity: dist.integrity, signatures };
}

/** Whether one of the signatures is a valid signature, by a known key, of `name@version:integrity`. */
export function isSigned(entry: Entry, signatures: Signature[], keys: Keys): boolean {
  const message = Buffer.from(`${entry.name}@${entry.version}:${entry.integrity}`);
  return signatures.some(({ keyid, sig }) => {
    const der = keys.get(keyid);
    if (der === undefined) return false;
    try {
      const key = createPublicKey({ key: Buffer.from(der, "base64"), format: "der", type: "spki" });
      return verify("sha256", message, key, Buffer.from(sig, "base64"));
    } catch {
      return false;
    }
  });
}

export async function check(
  parsed: Parsed,
  registry: string,
  options: Options & { concurrency?: number } = {},
): Promise<string[]> {
  const failures = parsed.malformed.map((key) => `${key}: the lockfile records no sha512 integrity for it`);
  const { keys, error: keysError } = await registryKeys(registry, options);
  if (!keys) return [...failures, `the registry's signing keys: ${keysError}`].sort();
  const queue = [...parsed.entries];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const id = `${entry.name}@${entry.version}`;
      const { integrity, signatures, error } = await registryVersion(registry, entry, options);
      if (error) {
        failures.push(`${id}: ${error}`);
      } else if (!signatures?.length) {
        failures.push(`${id}: the registry gives no signature for it`);
      } else if (!isSigned(entry, signatures, keys)) {
        failures.push(
          integrity === entry.integrity
            ? `${id}: no registry signature verifies over the integrity pnpm-lock.yaml records, ${entry.integrity}`
            : `${id}: pnpm-lock.yaml records ${entry.integrity}, which no registry signature covers (the registry reports ${integrity})`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? 12 }, worker));
  return failures.sort();
}

async function main(): Promise<number> {
  const file = process.argv[2] ?? "pnpm-lock.yaml";
  const registry = process.env.LOCKFILE_INTEGRITY_REGISTRY ?? "https://registry.npmjs.org";
  const backoffMs = Number(process.env.LOCKFILE_INTEGRITY_BACKOFF ?? "2") * 1000;
  const parsed = parseLockfile(readFileSync(file, "utf8"));
  if (parsed.entries.length === 0) {
    console.error(
      `::error file=${file}::no registry package found in ${file}; refusing to pass on an empty or unreadable lockfile`,
    );
    return 1;
  }
  for (const key of parsed.skipped) console.log(`lockfile-integrity: ${key} is not from the registry; skipped`);
  const failures = await check(parsed, registry, { backoffMs });
  for (const failure of failures) console.error(`::error file=${file}::${failure}`);
  if (failures.length > 0) {
    console.error(
      `lockfile-integrity: ${failures.length} of ${parsed.entries.length} entries are not signed by the registry`,
    );
    return 1;
  }
  console.log(
    `lockfile-integrity: all ${parsed.entries.length} integrity values in ${file} carry a valid registry signature`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
