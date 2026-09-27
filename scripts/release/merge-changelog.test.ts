import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./merge-changelog.sh", import.meta.url));
let dir: string;

const HEAD = "# Changelog\n\nIntro.\n\n";
const LINKS = "\n[Unreleased]: https://example.com/compare/v0.4.0...HEAD\n";

// The file right after a release: nothing under Unreleased.
const BASE = `${HEAD}## [Unreleased]\n\n## [0.4.0] - 2026-09-26\n\n### Added\n\n- Metrics\n${LINKS}`;

// dev added a line under Unreleased.
const DEV = `${HEAD}## [Unreleased]\n\n### Added\n\n- Dev feature\n\n## [0.4.0] - 2026-09-26\n\n### Added\n\n- Metrics\n${LINKS}`;

// main released a hotfix: bump.sh moved its lines into a dated section.
const MAIN =
  `${HEAD}## [Unreleased]\n\n## [0.4.1] - 2026-09-27\n\n### Fixed\n\n- Hotfix\n\n` +
  `## [0.4.0] - 2026-09-26\n\n### Added\n\n- Metrics\n` +
  "\n[Unreleased]: https://example.com/compare/v0.4.1...HEAD\n[0.4.1]: https://example.com/compare/v0.4.0...v0.4.1\n";

function run(base: string, dev: string, main: string): { ok: boolean; out: string; err: string } {
  const paths = ["base", "dev", "main"].map((name) => join(dir, name));
  for (const [index, text] of [base, dev, main].entries()) writeFileSync(paths[index], text);
  const result = spawnSync(SCRIPT, paths, { encoding: "utf8" });
  return { ok: result.status === 0, out: result.stdout, err: result.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "merge-changelog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("merge-changelog.sh", () => {
  it("keeps main's release and links and puts dev's lines under Unreleased", () => {
    const result = run(BASE, DEV, MAIN);
    expect(result.ok).toBe(true);
    expect(result.out).toBe(
      `${HEAD}## [Unreleased]\n\n### Added\n\n- Dev feature\n\n## [0.4.1] - 2026-09-27\n\n### Fixed\n\n- Hotfix\n\n` +
        `## [0.4.0] - 2026-09-26\n\n### Added\n\n- Metrics\n` +
        "\n[Unreleased]: https://example.com/compare/v0.4.1...HEAD\n[0.4.1]: https://example.com/compare/v0.4.0...v0.4.1\n",
    );
  });

  it("reads its inputs from pipes, as the workflow passes them", () => {
    const paths = ["base", "dev", "main"].map((name) => join(dir, name));
    for (const [index, text] of [BASE, DEV, MAIN].entries()) writeFileSync(paths[index], text);
    const piped = spawnSync("bash", ["-c", `"${SCRIPT}" <(cat "$1") <(cat "$2") <(cat "$3")`, "_", ...paths], {
      encoding: "utf8",
    });
    expect(piped.status).toBe(0);
    expect(piped.stdout).toBe(run(BASE, DEV, MAIN).out);
  });

  it("gives main's file unchanged when dev added nothing", () => {
    const result = run(BASE, BASE, MAIN);
    expect(result.ok).toBe(true);
    expect(result.out).toBe(MAIN);
  });

  it("refuses when dev changed a released section", () => {
    const result = run(BASE, DEV.replace("- Metrics", "- Metrics, reworded"), MAIN);
    expect(result.ok).toBe(false);
    expect(result.err).toContain("outside Unreleased");
  });

  it("refuses when main still has Unreleased lines", () => {
    const result = run(BASE, DEV, MAIN.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Pending on main\n"));
    expect(result.ok).toBe(false);
    expect(result.err).toContain("main has Unreleased lines");
  });

  it("refuses when the merge base already had Unreleased lines, which main has now released", () => {
    const pending = BASE.replace("## [Unreleased]\n", "## [Unreleased]\n\n- Pending\n");
    const result = run(pending, DEV.replace("- Dev feature", "- Pending\n- Dev feature"), MAIN);
    expect(result.ok).toBe(false);
    expect(result.err).toContain("merge base has Unreleased lines");
  });

  it("refuses a file with no Unreleased heading", () => {
    expect(run(BASE, DEV, MAIN.replace("## [Unreleased]", "## Unreleased")).ok).toBe(false);
  });
});
