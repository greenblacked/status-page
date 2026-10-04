// Fails when the built server holds more than one board cache.
//
//   node --experimental-strip-types scripts/ci/single-board-cache.ts [dist/server]
//
// TanStack Start splits every module that calls `createServerFn` into a
// separate server-function chunk and copies the module-level state of that
// module into it. A cache declared beside a server function is therefore
// built twice: the page's refetch reads one cache while the loader and the
// server routes (/api/*, /feed.xml, /metrics, badges) read another, and an
// isolate can run two vendor sweeps. The board cache lives in
// src/lib/status/board-cache.server.ts, away from any server function, so the
// build holds exactly one. This script counts where the built server
// constructs it and fails on any other number.
//
// The marker is `minForceIntervalMs:` as an object key: only the call that
// builds the board cache passes that option (the option's definition in
// ttl-cache.ts destructures it with `=`, which does not match), and a
// property key survives minifying. Zero matches fails as well, so a renamed
// option cannot turn the check into a pass that looks at nothing.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const MARKER = /\bminForceIntervalMs\s*:/g;

export type Finding = { file: string; count: number };

/** Every .js/.mjs/.cjs file under `dir` that constructs a board cache, with how often. */
export function findConstructions(dir: string): Finding[] {
  const found: Finding[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
        const count = readFileSync(path, "utf8").match(MARKER)?.length ?? 0;
        if (count > 0) found.push({ file: relative(dir, path), count });
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

/** An empty list when the build holds exactly one cache, otherwise what is wrong. */
export function problems(findings: Finding[]): string[] {
  const total = findings.reduce((sum, finding) => sum + finding.count, 0);
  if (total === 1) return [];
  const where = findings.map((finding) => `  ${finding.file}: ${finding.count}`).join("\n");
  if (total === 0) {
    return [
      "The built server never constructs the board cache (no `minForceIntervalMs:` key found). Was the build made, and is the marker in scripts/ci/single-board-cache.ts still the option the cache is built with?",
    ];
  }
  return [
    `The built server constructs the board cache ${total} times, expected once:\n${where}\nA module that calls createServerFn must not hold the cache; keep it in src/lib/status/board-cache.server.ts.`,
  ];
}

function main(): number {
  const dir = process.argv[2] ?? "dist/server";
  let findings: Finding[];
  try {
    findings = findConstructions(dir);
  } catch (error) {
    console.error(
      `Cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}. Run the build first.`,
    );
    return 1;
  }
  const errors = problems(findings);
  for (const error of errors) console.error(error);
  if (errors.length === 0) console.log(`One board cache in ${dir}: ${findings[0]?.file}.`);
  return errors.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
