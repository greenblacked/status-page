// Checks that every integrity pnpm-lock.yaml records is the one the npm
// registry signs for that package version.
//
//   node --experimental-strip-types scripts/ci/lockfile-integrity.ts [pnpm-lock.yaml]
//
// `pnpm audit signatures` verifies the registry's signature over the
// integrity the registry itself reports for a version. It does not compare
// that integrity with the lockfile's, so a lockfile line edited to point at
// other bytes would still audit clean. `npm audit signatures` did compare,
// because it verified the signature over the integrity of the installed
// package. This script closes that gap: run after `pnpm install` has checked
// every tarball against the lockfile, and after `pnpm audit signatures` has
// checked the registry's signature, it makes the lockfile's integrity equal
// the signed one, so the tarball that was installed is the one that was
// signed. scripts/ci/audit-signatures.sh runs the three together.
//
// Every YAML document of the file is read (this repository's has one: see
// pmOnFail in pnpm-workspace.yaml). Entries that do not come from the
// registry (a git or tarball URL) are listed and skipped, as
// `npm audit signatures` skipped them.
//
// LOCKFILE_INTEGRITY_REGISTRY points it at another registry (tests do), and
// LOCKFILE_INTEGRITY_BACKOFF sets the first retry wait in seconds (default 2).

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Entry = { name: string; version: string; integrity: string };
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the registry signs for one version: `dist.integrity` of its manifest. */
export async function registryIntegrity(
  registry: string,
  entry: Entry,
  options: { fetch?: Fetch; attempts?: number; backoffMs?: number } = {},
): Promise<{ integrity?: string; error?: string }> {
  const doFetch = options.fetch ?? ((url: string) => fetch(url, { headers: { accept: "application/json" } }));
  const attempts = options.attempts ?? 4;
  const backoff = options.backoffMs ?? 2000;
  const url = `${registry.replace(/\/$/, "")}/${entry.name.replace("/", "%2F")}/${entry.version}`;
  let error = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await doFetch(url);
      if (response.status === 404) return { error: "the registry has no such version" };
      if (response.status === 429 || response.status >= 500) {
        error = `the registry answered HTTP ${response.status}`;
      } else if (response.status !== 200) {
        return { error: `the registry answered HTTP ${response.status}` };
      } else {
        const manifest = (await response.json()) as { dist?: { integrity?: unknown } };
        const integrity = manifest.dist?.integrity;
        return typeof integrity === "string" ? { integrity } : { error: "the registry reports no integrity" };
      }
    } catch (cause) {
      error = `could not reach the registry: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (attempt < attempts) await sleep(backoff * attempt);
  }
  return { error };
}

export async function check(
  parsed: Parsed,
  registry: string,
  options: { fetch?: Fetch; backoffMs?: number; concurrency?: number } = {},
): Promise<string[]> {
  const failures = parsed.malformed.map((key) => `${key}: the lockfile records no sha512 integrity for it`);
  const queue = [...parsed.entries];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const { integrity, error } = await registryIntegrity(registry, entry, options);
      if (error) {
        failures.push(`${entry.name}@${entry.version}: ${error}`);
      } else if (integrity !== entry.integrity) {
        failures.push(
          `${entry.name}@${entry.version}: pnpm-lock.yaml records ${entry.integrity}, but the registry signs ${integrity}`,
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
      `lockfile-integrity: ${failures.length} of ${parsed.entries.length} entries do not match what the registry signs`,
    );
    return 1;
  }
  console.log(
    `lockfile-integrity: all ${parsed.entries.length} integrity values in ${file} are the ones the registry signs`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
