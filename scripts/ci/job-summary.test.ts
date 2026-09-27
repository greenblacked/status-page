import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Asset, collectAssets, renderBundle, renderCoverage } from "./job-summary.ts";

describe("renderCoverage", () => {
  it("renders each metric with its percentage and counts", () => {
    const metric = (covered: number, total: number) => ({ covered, total, pct: (covered / total) * 100 });
    const markdown = renderCoverage({
      total: { lines: metric(65, 100), statements: metric(2, 3), functions: metric(1, 2), branches: metric(0, 4) },
    });
    expect(markdown).toContain("| Lines | 65.0% | 65 / 100 |");
    expect(markdown).toContain("| Statements | 66.7% | 2 / 3 |");
    expect(markdown).toContain("| Branches | 0.0% | 0 / 4 |");
  });
});

describe("renderBundle", () => {
  it("lists large files first and folds the small ones into one row", () => {
    const assets: Asset[] = [
      { path: "assets/small.css", bytes: 900, gzip: 400 },
      { path: "assets/main.js", bytes: 200_000, gzip: 60_000 },
      { path: "assets/route.js", bytes: 30_000, gzip: 9_000 },
      { path: "assets/tiny.js", bytes: 500, gzip: 300 },
    ];
    const lines = renderBundle(assets).split("\n");
    const main = lines.findIndex((line) => line.includes("assets/main.js"));
    const route = lines.findIndex((line) => line.includes("assets/route.js"));
    expect(main).toBeGreaterThan(-1);
    expect(main).toBeLessThan(route);
    expect(lines).toContain("| 2 smaller files | 1.4 KiB | 0.7 KiB |");
    expect(lines.some((line) => line.startsWith("| **Total** | **226.0 KiB**"))).toBe(true);
  });
});

describe("collectAssets", () => {
  it("finds JavaScript and CSS in nested folders and measures them gzipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-"));
    try {
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "assets", "a.js"), "x".repeat(4096));
      writeFileSync(join(dir, "assets", "b.css"), "body{}");
      writeFileSync(join(dir, "favicon.svg"), "<svg/>");
      const assets = collectAssets(dir).sort((a, b) => a.path.localeCompare(b.path));
      expect(assets.map((asset) => asset.path)).toEqual([join("assets", "a.js"), join("assets", "b.css")]);
      expect(assets[0].bytes).toBe(4096);
      expect(assets[0].gzip).toBeLessThan(4096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
