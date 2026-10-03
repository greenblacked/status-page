import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./commits.sh", import.meta.url));

function checkSubject(subject: string): { ok: boolean; output: string } {
  const result = spawnSync(SCRIPT, ["--subject", subject], { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

describe("commits.sh --subject", () => {
  it.each([
    "feat: add a feed",
    "fix(status): decode entities (#20)",
    "refactor!: drop the legacy route",
    "release: 0.6.0",
    "release: v0.6.0",
    "release: v0.6.0 (#110)",
  ])("accepts %s", (subject) => {
    expect(checkSubject(subject).ok).toBe(true);
  });

  it.each(["release(core): 0.6.0", "release!: 0.6.0", "release(core)!: 0.6.0"])(
    "rejects %s, since a release takes no scope and no !",
    (subject) => {
      const result = checkSubject(subject);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("release takes no scope and no !");
    },
  );

  it.each(["release: add a feed", "release:  0.6.0", "release: 0.6", "release: v0.6.0 now", "release: 0.6.0."])(
    "rejects %s, since release takes only a version",
    (subject) => {
      const result = checkSubject(subject);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("release takes only a version");
    },
  );

  it.each(["release 0.6.0", "release:", "Release: 0.6.0", "added: a feed", "release: added 0.6.0"])(
    "rejects %s",
    (subject) => {
      expect(checkSubject(subject).ok).toBe(false);
    },
  );

  it("lists release among the types in its error", () => {
    expect(checkSubject("nope: x").output).toContain("release");
  });
});
