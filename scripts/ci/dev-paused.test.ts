import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL(".", import.meta.url));
let copy: string;

// Run a copy of the script next to a dev-paused file of the test's choosing
// (or none), so the real switch is never touched.
function paused(file: string | null, env: Record<string, string> = {}) {
  writeFileSync(join(copy, "dev-paused"), file ?? "");
  if (file === null) rmSync(join(copy, "dev-paused"));
  const { DEV_PAUSED: _unset, ...rest } = process.env;
  const result = spawnSync(join(copy, "dev-paused.sh"), [], { encoding: "utf8", env: { ...rest, ...env } });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
}

beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), "dev-paused-"));
  cpSync(join(DIR, "dev-paused.sh"), join(copy, "dev-paused.sh"));
});

afterEach(() => rmSync(copy, { recursive: true, force: true }));

describe("dev-paused.sh", () => {
  it("reads true and false from the file, ignoring comments", () => {
    expect(paused("# a comment\ntrue\n").out).toBe("true");
    expect(paused("# a comment\nfalse\n").out).toBe("false");
  });

  it("means paused when the file is missing", () => {
    expect(paused(null).out).toBe("true");
  });

  it("lets DEV_PAUSED in the environment override the file", () => {
    expect(paused("true\n", { DEV_PAUSED: "false" }).out).toBe("false");
    expect(paused("false\n", { DEV_PAUSED: "true" }).out).toBe("true");
  });

  it.each(["yes", "TRUE", "1"])("fails rather than guess on %s", (value) => {
    const result = paused(`${value}\n`);
    expect(result.status).toBe(1);
    expect(result.err).toContain("expected true or false");
    expect(paused("true\n", { DEV_PAUSED: value }).status).toBe(1);
  });

  it("means paused when the file holds only comments", () => {
    expect(paused("# nothing\n").out).toBe("true");
  });
});
