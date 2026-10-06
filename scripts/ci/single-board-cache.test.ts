import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findConstructions, problems } from "./single-board-cache.ts";

const SCRIPT = fileURLToPath(new URL("./single-board-cache.ts", import.meta.url));

const DEFINITION = "function createTtlCache(load, ttlMs, { maxStaleMs = 0, minForceIntervalMs = 0 } = {}) {}\n";
const CONSTRUCTION =
  "const boardCache = createTtlCache(collectBoard, 45e3, {\n\tmaxStaleMs: 1,\n\tminForceIntervalMs: 2\n});\n";
const MINIFIED = "const a=n(c,45e3,{maxStaleMs:1,minForceIntervalMs:2});";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "single-board-cache-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function run(dir: string) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", SCRIPT, dir],
    {
      encoding: "utf8",
    },
  );
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("findConstructions", () => {
  it("counts the key in the construction and ignores the option's definition", () => {
    const dir = build({ "assets/ttl-cache.js": DEFINITION, "assets/board-cache.server.js": CONSTRUCTION });
    expect(findConstructions(dir)).toEqual([{ file: join("assets", "board-cache.server.js"), count: 1 }]);
  });

  it("reads minified output, nested folders and every script extension, and skips other files", () => {
    const dir = build({
      "index.js": MINIFIED,
      "assets/deep/a.mjs": MINIFIED + MINIFIED,
      "assets/b.cjs": MINIFIED,
      "assets/styles.css": CONSTRUCTION,
      "wrangler.json": CONSTRUCTION,
    });
    expect(findConstructions(dir).map((finding) => [finding.file, finding.count])).toEqual([
      [join("assets", "b.cjs"), 1],
      [join("assets", "deep", "a.mjs"), 2],
      ["index.js", 1],
    ]);
  });

  it("finds nothing in a build without the cache", () => {
    expect(findConstructions(build({ "index.js": DEFINITION }))).toEqual([]);
  });
});

describe("problems", () => {
  it("accepts exactly one construction", () => {
    expect(problems([{ file: "board-cache.server.js", count: 1 }])).toEqual([]);
  });

  it("rejects two copies in two chunks, naming both", () => {
    const [message] = problems([
      { file: "board.js", count: 1 },
      { file: "router.js", count: 1 },
    ]);
    expect(message).toContain("2 times");
    expect(message).toContain("board.js: 1");
    expect(message).toContain("router.js: 1");
  });

  it("rejects two copies in one chunk", () => {
    expect(problems([{ file: "router.js", count: 2 }])[0]).toContain("2 times");
  });

  it("rejects a build with no cache at all", () => {
    expect(problems([])[0]).toContain("never constructs the board cache");
  });
});

describe("single-board-cache.ts", () => {
  it("passes a build with one cache", () => {
    const result = run(build({ "assets/ttl-cache.js": DEFINITION, "assets/board-cache.server.js": CONSTRUCTION }));
    expect(result.code).toBe(0);
    expect(result.out).toContain("One board cache");
  });

  it("fails a build where the cache was copied into the server-function chunk", () => {
    const result = run(build({ "assets/router.js": CONSTRUCTION, "assets/board.js": CONSTRUCTION }));
    expect(result.code).toBe(1);
    expect(result.err).toContain("2 times");
  });

  it("fails a build with no cache", () => {
    expect(run(build({ "index.js": "export {};" })).code).toBe(1);
  });

  it("fails clearly when the build folder is missing", () => {
    const result = run(join(tmpdir(), "single-board-cache-missing-dir"));
    expect(result.code).toBe(1);
    expect(result.err).toContain("Run the build first");
  });
});
