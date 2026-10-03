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
// with node:crypto and npm's signing keys, a signature of the version
// document over `<name>@<version>:<the lockfile's own integrity>`. It does
// not trust the version document's unsigned `dist.integrity`, which a
// registry, mirror or proxy could set apart from the signature. Run after
// `pnpm install` has checked the tarballs it downloaded against the
// lockfile, it makes the lockfile's integrity a signed one.
// scripts/ci/audit-signatures.sh runs the two together.
//
// Keys. For registry.npmjs.org the script uses only the two keys pinned in
// NPM_KEYS below, so a registry, mirror or proxy cannot bring its own keys
// along with signatures it made. (The npm CLI gets the same keys from
// Sigstore's TUF repository and falls back to /-/npm/v1/keys; this script has
// no TUF client, so the pin stands in for it. When npm rotates its keys,
// update NPM_KEYS from https://registry.npmjs.org/-/npm/v1/keys.) For any other
// registry (LOCKFILE_INTEGRITY_REGISTRY: a mirror, or a test double) the keys
// are fetched from that registry, unauthenticated, so that case defends only
// against an edited lockfile, not against a dishonest registry.
//
// Expiry follows the npm CLI (pacote): a signature made by a key that has an
// `expires` date counts only for a version published before that date, so the
// retired key does not vouch for anything published after it was retired. The
// publish time is the packument's `time[version]`, fetched only when it is
// needed.
//
// The parser fails closed. Every entry under `packages:` ends up verified,
// skipped or reported as unreadable, and the totals are printed. Only an entry
// whose key's version part is not a semver version (a git, URL or file spec,
// which needs a matching package.json specifier change to get into the
// lockfile) is skipped, as `npm audit signatures` skipped it. Any other entry
// whose resolution is missing, unrecognised or not a plain registry tarball
// fails the run. Every YAML document of the file is read (this repository's
// has one: see pmOnFail in pnpm-workspace.yaml).
//
// LOCKFILE_INTEGRITY_REGISTRY points it at another registry (tests do), and
// LOCKFILE_INTEGRITY_BACKOFF sets the first retry wait in seconds (default 2).

import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Entry = { name: string; version: string; integrity: string; tarball?: string };
export type Signature = { keyid: string; sig: string };
export type Key = { key: string; expires?: string };
export type Keys = Map<string, Key>;
export type Parsed = { entries: Entry[]; skipped: string[]; malformed: string[] };

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Resolution fields that mean the package is not a plain registry tarball. */
const NOT_REGISTRY = ["type", "repo", "commit", "directory", "path"];

const unquote = (text: string) => text.replace(/^(['"])(.*)\1$/, "$2");

/** The fields of one entry's `resolution:`, in flow style (`{a: b, c: d}`) or block style; undefined if neither. */
function resolutionOf(block: string[]): Record<string, string> | undefined {
  const at = block.findIndex((line) => /^ {4}resolution:(?: |$)/.test(line));
  if (at === -1) return undefined;
  const rest = (block[at] ?? "").slice("    resolution:".length).trim();
  const fields: Record<string, string> = {};
  let parts: string[];
  if (rest === "") {
    parts = [];
    for (const line of block.slice(at + 1)) {
      if (line.trim() === "") continue;
      if (!/^ {5}/.test(line)) break; // the entry's next field
      parts.push(line.trim());
    }
  } else if (rest.startsWith("{") && rest.endsWith("}")) {
    parts = rest.slice(1, -1).split(/, (?=[A-Za-z]\w*: )/);
  } else {
    return undefined;
  }
  for (const part of parts) {
    const field = /^([A-Za-z]\w*): (.*)$/.exec(part.trim());
    if (!field?.[1]) return undefined;
    fields[field[1]] = unquote((field[2] ?? "").trim());
  }
  return fields;
}

/**
 * The `packages:` entries of every YAML document in a pnpm-lock.yaml. Each
 * heading ends up in exactly one of the three lists: verified as an entry,
 * skipped (its version part is not semver: a git, URL or file spec), or
 * malformed (anything this parser cannot read, which fails the run).
 */
export function parseLockfile(text: string): Parsed {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  const skipped = new Set<string>();
  const malformed = new Set<string>();

  const read = (rawKey: string, block: string[]) => {
    const key = unquote(rawKey);
    const at = key.lastIndexOf("@");
    if (at <= 0 || /['"]/.test(key)) return void malformed.add(rawKey);
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!SEMVER.test(version)) return void skipped.add(key);
    const fields = resolutionOf(block);
    const integrity = fields?.integrity;
    if (!fields || !integrity?.startsWith("sha512-") || NOT_REGISTRY.some((field) => field in fields)) {
      return void malformed.add(key);
    }
    const id = `${key}\0${integrity}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ name, version, integrity, ...(fields.tarball === undefined ? {} : { tarball: fields.tarball }) });
  };

  for (const doc of text.replace(/\r\n?/g, "\n").split(/^---$/m)) {
    const lines = doc.split("\n");
    const start = lines.indexOf("packages:");
    if (start === -1) continue;
    let heading: string | undefined;
    let block: string[] = [];
    const flush = () => {
      if (heading !== undefined) read(heading, block);
      heading = undefined;
      block = [];
    };
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break; // the next top-level key, such as `snapshots:`
      const found = /^ {2}(\S.*):$/.exec(line);
      if (found) {
        flush();
        heading = found[1];
      } else if (/^ {2}[^\s#]/.test(line)) {
        flush();
        malformed.add(line.trim()); // an entry heading this parser does not understand
      } else {
        block.push(line);
      }
    }
    flush();
  }
  return { entries, skipped: [...skipped], malformed: [...malformed] };
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

/** npm's registry signing keys (https://registry.npmjs.org/-/npm/v1/keys), pinned: see the header. */
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const NPM_KEYS: Keys = new Map([
  [
    "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA",
    {
      key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==",
      expires: "2025-01-29T00:00:00.000Z",
    },
  ],
  [
    "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
    {
      key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==",
    },
  ],
]);

/**
 * The keys to trust for a registry: npm's pinned keys for registry.npmjs.org
 * (nothing is fetched), otherwise the list that registry publishes, which is
 * only as trustworthy as the registry.
 */
export async function registryKeys(registry: string, options: Options = {}): Promise<{ keys?: Keys; error?: string }> {
  if (base(registry) === NPM_REGISTRY) return { keys: NPM_KEYS };
  const { body, error } = await getJson(`${base(registry)}/-/npm/v1/keys`, options);
  if (error) return { error };
  const list = (body as { keys?: unknown } | undefined)?.keys;
  const keys: Keys = new Map();
  if (Array.isArray(list)) {
    for (const item of list as { keyid?: unknown; key?: unknown; expires?: unknown }[]) {
      if (typeof item?.keyid === "string" && typeof item.key === "string") {
        keys.set(item.keyid, {
          key: item.key,
          ...(typeof item.expires === "string" ? { expires: item.expires } : {}),
        });
      }
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

/** The keys of which one of the signatures is a valid signature of `name@version:integrity`. */
export function verifyingKeys(entry: Entry, signatures: Signature[], keys: Keys): Key[] {
  const message = Buffer.from(`${entry.name}@${entry.version}:${entry.integrity}`);
  const verified: Key[] = [];
  for (const { keyid, sig } of signatures) {
    const known = keys.get(keyid);
    if (known === undefined) continue;
    try {
      const key = createPublicKey({ key: Buffer.from(known.key, "base64"), format: "der", type: "spki" });
      if (verify("sha256", message, key, Buffer.from(sig, "base64"))) verified.push(known);
    } catch {
      // a key or signature that does not parse verifies nothing
    }
  }
  return verified;
}

/** Whether one of the signatures is a valid signature, by a known key, of `name@version:integrity`. */
export const isSigned = (entry: Entry, signatures: Signature[], keys: Keys): boolean =>
  verifyingKeys(entry, signatures, keys).length > 0;

/** The registry's canonical tarball URL for a version. */
export const canonicalTarball = (registry: string, { name, version }: Entry) =>
  `${base(registry)}/${name}/-/${name.split("/").pop()}-${version}.tgz`;

/** When each version of a package was published (the packument's `time`), by name, fetched once. */
function publishTimes(registry: string, options: Options) {
  const cache = new Map<string, Promise<{ time?: Record<string, unknown>; error?: string }>>();
  return (name: string) => {
    let pending = cache.get(name);
    if (!pending) {
      pending = getJson(`${base(registry)}/${name.replace("/", "%2F")}`, options).then(({ body, error }) => {
        if (error) return { error };
        const time = (body as { time?: unknown } | undefined)?.time;
        return typeof time === "object" && time !== null
          ? { time: time as Record<string, unknown> }
          : { error: "the registry gives no publish times" };
      });
      cache.set(name, pending);
    }
    return pending;
  };
}

export async function check(
  parsed: Parsed,
  registry: string,
  options: Options & { concurrency?: number } = {},
): Promise<string[]> {
  const failures = parsed.malformed.map(
    (key) => `${key}: not a plain registry entry with a sha512 integrity, so its signature cannot be checked`,
  );
  const { keys, error: keysError } = await registryKeys(registry, options);
  if (!keys) return [...failures, `the registry's signing keys: ${keysError}`].sort();
  const timesOf = publishTimes(registry, options);
  const queue = [...parsed.entries];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const id = `${entry.name}@${entry.version}`;
      const canonical = canonicalTarball(registry, entry);
      if (entry.tarball !== undefined && entry.tarball !== canonical) {
        failures.push(`${id}: pnpm-lock.yaml gives the tarball ${entry.tarball}, not the registry's ${canonical}`);
        continue;
      }
      const { integrity, signatures, error } = await registryVersion(registry, entry, options);
      if (error) {
        failures.push(`${id}: ${error}`);
        continue;
      }
      if (!signatures?.length) {
        failures.push(`${id}: the registry gives no signature for it`);
        continue;
      }
      const verified = verifyingKeys(entry, signatures, keys);
      if (verified.length === 0) {
        const unknown = signatures.filter(({ keyid }) => !keys.has(keyid)).map(({ keyid }) => keyid);
        failures.push(
          unknown.length === signatures.length
            ? `${id}: signed only by key ${unknown.join(", ")}, which is not one of the trusted registry keys`
            : integrity === entry.integrity
              ? `${id}: no registry signature verifies over the integrity pnpm-lock.yaml records, ${entry.integrity}`
              : `${id}: pnpm-lock.yaml records ${entry.integrity}, which no registry signature covers (the registry reports ${integrity})`,
        );
      } else if (!verified.some((key) => key.expires === undefined)) {
        // Every key that verifies expires: the version must have been published before one of them did.
        const { time, error: timeError } = await timesOf(entry.name);
        const published = Date.parse(String(time?.[entry.version]));
        if (timeError || Number.isNaN(published)) {
          failures.push(
            `${id}: cannot tell when it was published: ${timeError ?? "the registry gives no publish time"}`,
          );
        } else if (!verified.some((key) => published < Date.parse(key.expires ?? ""))) {
          const expired = verified.map((key) => key.expires).join(", ");
          failures.push(
            `${id}: signed only by a key that expired (${expired}) before it was published (${new Date(published).toISOString()})`,
          );
        }
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
  if (parsed.entries.length === 0 && parsed.malformed.length === 0) {
    console.error(
      `::error file=${file}::no registry package found in ${file}; refusing to pass on an empty or unreadable lockfile`,
    );
    return 1;
  }
  for (const key of parsed.skipped) {
    console.log(`lockfile-integrity: ${key} is not a registry version (not semver); skipped`);
  }
  const failures = await check(parsed, registry, { backoffMs });
  for (const failure of failures) console.error(`::error file=${file}::${failure}`);
  if (failures.length > 0) {
    console.error(
      `lockfile-integrity: ${failures.length} problem(s) in ${parsed.entries.length} verified, ${parsed.malformed.length} unreadable and ${parsed.skipped.length} skipped entries`,
    );
    return 1;
  }
  console.log(
    `lockfile-integrity: all ${parsed.entries.length} integrity values in ${file} carry a valid registry signature (${parsed.skipped.length} non-registry entries skipped)`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
