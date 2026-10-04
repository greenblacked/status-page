import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../src/styles.css", import.meta.url)), "utf8");

// Tailwind finds the files to scan on its own and skips what .gitignore lists.
// The Docker build context has no .gitignore and no .git, so dist/ (written by
// the client pass) was scanned during the server pass: the two passes made
// different stylesheets under different hashes, and the page linked a file
// that dist/client did not hold. The scan has to be named here instead.
describe("stylesheet source scan", () => {
  it("names the directory Tailwind scans instead of leaving it to .gitignore", () => {
    expect(css).toMatch(/^@import "tailwindcss" source\("\.\/?"\);$/m);
  });

  it("leaves test files out, so a build with and without them is the same", () => {
    expect(css).toMatch(/^@source not "\.\/\*\*\/\*\.test\.ts";$/m);
    expect(css).toMatch(/^@source not "\.\/test";$/m);
  });
});
