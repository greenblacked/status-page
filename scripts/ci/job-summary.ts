// Markdown for a GitHub Actions job summary, so a run's page shows the
// numbers a reviewer would otherwise dig out of the log.
//
//   node --experimental-strip-types scripts/ci/job-summary.ts coverage [coverage/coverage-summary.json]
//   node --experimental-strip-types scripts/ci/job-summary.ts bundle [dist/client]
//
// Appends to $GITHUB_STEP_SUMMARY when it is set, and prints to stdout
// otherwise, so the same command shows the table locally.

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

type Metric = { total: number; covered: number; pct: number };
export type CoverageSummary = { total: Record<"lines" | "statements" | "functions" | "branches", Metric> };

const METRICS = ["lines", "statements", "functions", "branches"] as const;

export function renderCoverage(summary: CoverageSummary): string {
  const rows = METRICS.map((name) => {
    const { pct, covered, total } = summary.total[name];
    return `| ${name[0].toUpperCase()}${name.slice(1)} | ${pct.toFixed(1)}% | ${covered} / ${total} |`;
  });
  return ["### Unit test coverage", "", "| Metric | Covered | Count |", "| --- | ---: | ---: |", ...rows, ""].join(
    "\n",
  );
}

export type Asset = { path: string; bytes: number; gzip: number };

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** The largest files first; everything under 1 KiB gzipped is summed as one row. */
export function renderBundle(assets: Asset[]): string {
  const sorted = [...assets].sort((a, b) => b.gzip - a.gzip);
  const shown = sorted.filter((asset) => asset.gzip >= 1024);
  const rest = sorted.filter((asset) => asset.gzip < 1024);
  const rows = shown.map((asset) => `| \`${asset.path}\` | ${kib(asset.bytes)} | ${kib(asset.gzip)} |`);
  if (rest.length) {
    const bytes = rest.reduce((sum, asset) => sum + asset.bytes, 0);
    const gzip = rest.reduce((sum, asset) => sum + asset.gzip, 0);
    rows.push(`| ${rest.length} smaller files | ${kib(bytes)} | ${kib(gzip)} |`);
  }
  const bytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const gzip = assets.reduce((sum, asset) => sum + asset.gzip, 0);
  return [
    "### Client bundle",
    "",
    "| File | Size | Gzipped |",
    "| --- | ---: | ---: |",
    ...rows,
    `| **Total** | **${kib(bytes)}** | **${kib(gzip)}** |`,
    "",
  ].join("\n");
}

/** JavaScript and CSS under `dir`, the files a browser downloads to run the board. */
export function collectAssets(dir: string): Asset[] {
  const assets: Asset[] = [];
  const walk = (current: string) => {
    // The directory entry says what it is, so there is no separate stat
    // that the file could change between.
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(js|css)$/.test(entry.name)) {
        const content = readFileSync(path);
        assets.push({ path: relative(dir, path), bytes: content.length, gzip: gzipSync(content).length });
      }
    }
  };
  walk(dir);
  return assets;
}

function main(): number {
  const [kind, input] = process.argv.slice(2);
  let markdown: string;
  if (kind === "coverage") {
    markdown = renderCoverage(JSON.parse(readFileSync(input ?? "coverage/coverage-summary.json", "utf8")));
  } else if (kind === "bundle") {
    markdown = renderBundle(collectAssets(input ?? "dist/client"));
  } else {
    console.error("usage: job-summary.ts coverage [summary.json] | bundle [dir]");
    return 2;
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else console.log(markdown);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
