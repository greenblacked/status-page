import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

type Fake = ReturnType<typeof fakeGithub>;
type Triage = {
  triage: (args: { github: Fake; context: unknown; core: { info: (m: string) => void } }) => Promise<void>;
  categorize: (workflow: string, job: string, step?: string) => string;
  MARKER: string;
};
const { triage, categorize, MARKER } = createRequire(import.meta.url)("./ci-triage.cjs") as Triage;

type Run = {
  id: number;
  name: string;
  run_number: number;
  status: string;
  conclusion: string | null;
  html_url: string;
};
type Job = {
  name: string;
  conclusion: string;
  html_url: string;
  steps: { name: string; number: number; conclusion: string }[];
};
type Comment = { id: number; body: string; user: { type: string } };

const HEAD = "abc1234def";
let runs: Run[];
let jobs: Record<number, Job[]>;
let comments: Comment[];
let labels: string[];
let prHead: string;

function fakeGithub() {
  return {
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => (await fn(params)).data,
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: [{ number: 7, state: "open" }] }) },
      pulls: {
        list: async () => ({ data: [] }),
        get: async () => ({
          data: { number: 7, state: "open", head: { sha: prHead }, labels: labels.map((name) => ({ name })) },
        }),
      },
      actions: {
        listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: runs } }),
        listJobsForWorkflowRun: async ({ run_id }: { run_id: number }) => ({ data: { jobs: jobs[run_id] ?? [] } }),
      },
      issues: {
        listComments: async () => ({ data: comments }),
        createComment: async ({ body }: { body: string }) => {
          comments.push({ id: comments.length + 1, body, user: { type: "Bot" } });
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          const comment = comments.find((c) => c.id === comment_id);
          if (comment) comment.body = body;
        },
        addLabels: async ({ labels: added }: { labels: string[] }) => {
          labels.push(...added);
        },
        removeLabel: async ({ name }: { name: string }) => {
          labels = labels.filter((l) => l !== name);
        },
      },
    },
  };
}

const context = {
  repo: { owner: "o", repo: "r" },
  payload: { workflow_run: { head_sha: HEAD, pull_requests: [{ number: 7 }] } },
};
const core = { info: () => {} };
const run = () => triage({ github: fakeGithub(), context, core });

const green = (id: number, name: string, n = 1): Run => ({
  id,
  name,
  run_number: n,
  status: "completed",
  conclusion: "success",
  html_url: `u/${id}`,
});

beforeEach(() => {
  runs = [];
  jobs = {};
  comments = [];
  labels = [];
  prHead = HEAD;
});

describe("ci triage", () => {
  it("stays silent on a PR that never failed", async () => {
    runs = [green(1, "CI"), green(2, "CodeQL"), green(3, "Dependency review")];
    await run();
    expect(comments).toHaveLength(0);
    expect(labels).toEqual([]);
  });

  it("reports the failing job, step and category, with a log link, and labels the PR", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "failure" }, green(2, "CodeQL")];
    jobs[1] = [
      {
        name: "verify (node 24)",
        conclusion: "failure",
        html_url: "https://gh/job/9",
        steps: [
          { name: "Run pnpm install", number: 5, conclusion: "success" },
          { name: "Run pnpm test", number: 7, conclusion: "failure" },
        ],
      },
    ];
    await run();
    expect(comments).toHaveLength(1);
    expect(comments[0].body.startsWith(MARKER)).toBe(true);
    expect(comments[0].body).toContain(
      "`verify (node 24)` → `Run pnpm test`: unit test failure, or coverage under its threshold",
    );
    expect(comments[0].body).toContain("https://gh/job/9#step:7:1");
    expect(labels).toEqual(["ci-failed"]);
  });

  it("edits the same comment on recovery and removes the label", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "failure" }];
    jobs[1] = [
      {
        name: "quality",
        conclusion: "failure",
        html_url: "j",
        steps: [{ name: "Repository hygiene", number: 3, conclusion: "failure" }],
      },
    ];
    await run();
    runs = [green(4, "CI", 2)];
    await run();
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Recovered");
    expect(labels).toEqual([]);
  });

  it("keeps the red report while a recovery run is still in flight", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "failure" }];
    jobs[1] = [
      {
        name: "quality",
        conclusion: "failure",
        html_url: "j",
        steps: [{ name: "Repository hygiene", number: 3, conclusion: "failure" }],
      },
    ];
    await run();
    runs = [{ ...green(4, "CI", 2), status: "in_progress", conclusion: null }];
    await run();
    expect(comments[0].body).toContain("CI failing");
    expect(labels).toEqual(["ci-failed"]);
  });

  it("ignores results for a commit the PR has moved past", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "failure" }];
    prHead = "newer000";
    await run();
    expect(comments).toHaveLength(0);
    expect(labels).toEqual([]);
  });

  it("keeps fork-controlled job and step names inert", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "failure" }];
    jobs[1] = [{ name: "x` @someone [click](http://evil)", conclusion: "failure", html_url: "j", steps: [] }];
    await run();
    expect(comments[0].body).toContain("`x  @someone [click](http://evil)`");
  });

  it("escapes pipes so a job name cannot leave its table cell", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "failure" }];
    jobs[1] = [{ name: "x | @org/team [link](http://evil)", conclusion: "failure", html_url: "j", steps: [] }];
    await run();
    expect(comments[0].body).toContain("`x \\| @org/team [link](http://evil)`");
  });

  it("escapes backslashes too, so a backslash cannot un-escape the pipe", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "failure" }];
    jobs[1] = [{ name: "a\\| @org/team", conclusion: "failure", html_url: "j", steps: [] }];
    await run();
    const row = comments[0].body.split("\n").find((line) => line.startsWith("| CI |")) ?? "";
    // Split as GitHub does: a backslash escapes the next character, and an
    // unescaped pipe ends a cell. The row must have exactly two cells.
    const cells = [""];
    for (let i = 0; i < row.length; i += 1) {
      if (row[i] === "\\") cells[cells.length - 1] += row[i] + (row[++i] ?? "");
      else if (row[i] === "|") cells.push("");
      else cells[cells.length - 1] += row[i];
    }
    expect(cells.slice(1, -1)).toHaveLength(2);
  });

  it("does not declare recovery when the re-run was cancelled", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "failure" }];
    jobs[1] = [
      {
        name: "quality",
        conclusion: "failure",
        html_url: "j",
        steps: [{ name: "Repository hygiene", number: 3, conclusion: "failure" }],
      },
    ];
    await run();
    runs = [{ ...green(4, "CI", 2), conclusion: "cancelled" }];
    await run();
    expect(comments[0].body).toContain("CI failing");
    expect(labels).toEqual(["ci-failed"]);
  });

  it("does not count a cancelled run as a failure", async () => {
    runs = [{ ...green(1, "CI"), conclusion: "cancelled" }];
    await run();
    expect(comments).toHaveLength(0);
  });

  it("categorizes the steps this repository actually has", () => {
    expect(categorize("CI", "verify (node pinned)", "Run pnpm run typecheck")).toBe("type error");
    expect(categorize("CI", "verify (node pinned)", "Smoke-test built preview")).toMatch(/SSR smoke/);
    expect(categorize("CI", "commit messages", "Check Conventional Commits")).toBe("commit message format");
    expect(categorize("Dependency review", "dependency-review", "Review dependency changes")).toMatch(/vulnerability/);
    expect(categorize("CI", "verify", undefined)).toMatch(/^infrastructure/);
    // The step names ci.yml uses.
    expect(categorize("CI", "lint", "Set up the toolchain (pnpm install)")).toMatch(/^dependency install/);
    expect(categorize("CI", "lint", "Verify registry signatures")).toMatch(/^dependency install.*signature check/);
    expect(categorize("CI", "lint", "pnpm pin in sync")).toBe("toolchain version");
    expect(categorize("Deploy", "build worker", "Pin pnpm")).toBe("toolchain version");
    expect(categorize("CI", "lint", "Lint and format (Biome)")).toMatch(/^lint or formatting/);
    expect(categorize("CI", "typecheck", "Typecheck")).toBe("type error");
    expect(categorize("CI", "test (node pinned)", "Unit tests with coverage (pnpm run test:coverage)")).toMatch(
      /^unit test failure/,
    );
    expect(categorize("CI", "test (node 24)", "Unit tests (pnpm test)")).toMatch(/^unit test failure/);
    expect(categorize("CI", "build (node pinned)", "Build (pnpm run build)")).toBe("build");
    expect(categorize("CI", "browser tests", "Browser tests (Playwright)")).toMatch(/^browser test failure/);
    expect(categorize("CI", "browser tests (iphone)", "Initialize containers")).toBe("infrastructure");
    expect(categorize("CI", "browser tests (iphone)", "Check the browser")).toMatch(/^browser build missing/);
    expect(categorize("CI", "lint", "Changelog covers package.json version")).toMatch(/^CHANGELOG/);
    expect(categorize("CI", "branch name", "Check the branch naming convention")).toBe("branch name");
    expect(categorize("CI", "workflow lint", "zizmor")).toBe("workflow security");
    expect(categorize("CI", "CI OK", "Check every job passed")).toMatch(/required job/);
  });
});
