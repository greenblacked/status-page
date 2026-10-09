import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

type Step = { name: string; conclusion: string | null };
type Job = { id: number; name: string; conclusion: string; steps: Step[] };
type Annotation = { message: string };
type Run = {
  id: number;
  name: string;
  run_number: number;
  run_attempt: number;
  conclusion: string;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  event: string;
  pull_requests?: { number: number }[];
  head_repository?: { full_name: string };
};
type Verdict = { rerun: boolean; reason: string; jobs: { name: string; kind: string; why: string }[] };
type Rerun = {
  rerunInfra: (args: { github: Fake; context: unknown; core: { info: (m: string) => void } }) => Promise<void>;
  decide: (args: { run: Partial<Run>; jobs: Job[]; annotations?: Record<number, Annotation[]> }) => Verdict;
  classify: (job: Job, annotations?: Annotation[]) => { kind: string; why: string };
};
const { rerunInfra, decide, classify } = createRequire(import.meta.url)("./rerun-infra.cjs") as Rerun;

const NOT_ACQUIRED =
  "The job was not acquired by Runner of type hosted even after multiple attempts. Internal server error";
const CANCELED = "The operation was canceled.";

const setup: Step[] = [{ name: "Set up job", conclusion: "success" }];
const starved = (id: number, name = `browser tests (${id})`): Job => ({ id, name, conclusion: "failure", steps: [] });
const cancelled = (id: number, name = `job ${id}`): Job => ({ id, name, conclusion: "cancelled", steps: [] });
const tested = (id: number, name = "browser tests (windows)"): Job => ({
  id,
  name,
  conclusion: "failure",
  steps: [
    ...setup,
    { name: "Run actions/checkout", conclusion: "success" },
    { name: "Run the browser tests", conclusion: "failure" },
    { name: "Upload the report", conclusion: "success" },
  ],
});
const verdict: Job = {
  id: 99,
  name: "CI OK",
  conclusion: "failure",
  steps: [...setup, { name: "Check every job passed", conclusion: "failure" }],
};
const run: Run = {
  id: 500,
  name: "CI",
  run_number: 7,
  run_attempt: 1,
  conclusion: "failure",
  workflow_id: 1,
  head_branch: "dev",
  head_sha: "aaa",
  event: "push",
};
const said = (message: string): Annotation[] => [{ message }];

describe("classify", () => {
  it("calls a job the runner never acquired infrastructure", () => {
    expect(classify(starved(1), said(NOT_ACQUIRED)).kind).toBe("infra");
  });

  it("calls a job with no step beyond setup infrastructure even with no annotation", () => {
    expect(classify({ ...starved(1), steps: setup }).kind).toBe("infra");
  });

  it("takes lost communication and a shutdown signal as infrastructure, even mid-job", () => {
    const mid: Job = { ...tested(1), steps: [...setup, { name: "Run the tests", conclusion: "cancelled" }] };
    expect(classify(mid, said("The self-hosted runner lost communication with the server.")).kind).toBe("infra");
    expect(classify(mid, said("The runner has received a shutdown signal.")).kind).toBe("infra");
  });

  it("takes The operation was canceled as infrastructure only when no step of ours ran", () => {
    expect(classify(cancelled(1), said(CANCELED)).kind).toBe("infra");
    const midway: Job = {
      ...cancelled(2),
      steps: [
        ...setup,
        { name: "Run the tests", conclusion: "success" },
        { name: "Run more", conclusion: "cancelled" },
      ],
    };
    expect(classify(midway, said(CANCELED)).kind).toBe("real");
  });

  it("keeps a job somebody ended, or a rule refused, real even with no step beyond setup", () => {
    const manual = said("The run was canceled by @greenblacked.");
    const concurrency = said("Canceling since a higher priority waiting request for deploy-stage exists");
    const protection = said('Branch "x" is not allowed to deploy to production due to environment protection rules.');
    expect(classify(cancelled(1), manual).kind).toBe("real");
    expect(classify(cancelled(2), concurrency).kind).toBe("real");
    expect(classify({ ...starved(3, "deploy"), steps: [] }, protection).kind).toBe("real");
    expect(classify(cancelled(4), [...said(CANCELED), ...manual]).kind).toBe("real");
  });

  it("keeps a failed test step real", () => {
    expect(classify(tested(1), said("Process completed with exit code 1.")).kind).toBe("real");
    expect(classify(tested(1)).kind).toBe("real");
  });

  it("keeps a failed step real even when the runner message is present beside an exit code", () => {
    const annotations = [{ message: "Process completed with exit code 1." }, { message: NOT_ACQUIRED }];
    expect(classify(tested(1), annotations).kind).toBe("real");
  });

  it("keeps a job that timed out in a step real", () => {
    const timedOut: Job = {
      ...tested(1),
      conclusion: "cancelled",
      steps: [...setup, { name: "Run the tests", conclusion: "cancelled" }],
    };
    expect(classify(timedOut, said("The job has exceeded the maximum execution time of 40m0s")).kind).toBe("real");
  });

  it("ignores jobs that did not fail and recognises the aggregate job", () => {
    expect(classify({ ...starved(1), conclusion: "success" }).kind).toBe("ignore");
    expect(classify({ ...starved(1), conclusion: "skipped" }).kind).toBe("ignore");
    expect(classify(verdict).kind).toBe("aggregator");
  });

  it("classifies the aggregate job like any other when its own step never ran", () => {
    const aggregate: Job = { ...verdict, steps: [] };
    expect(classify(aggregate, said(NOT_ACQUIRED)).kind).toBe("infra");
    expect(classify({ ...aggregate, steps: setup }).kind).toBe("infra");
    expect(classify(aggregate, said("The run was canceled by @greenblacked.")).kind).toBe("real");
  });
});

describe("decide", () => {
  it("re-runs a run whose failed jobs were all lost to the runner", () => {
    const jobs = [starved(1), starved(2), cancelled(3), verdict, { ...starved(4), conclusion: "success" }];
    const annotations = { 1: said(NOT_ACQUIRED), 2: said(NOT_ACQUIRED), 3: said(CANCELED) };
    const result = decide({ run, jobs, annotations });
    expect(result.rerun).toBe(true);
    expect(result.jobs.map((j) => j.kind)).toEqual(["infra", "infra", "infra", "aggregator"]);
  });

  it("does not re-run when one job failed in a test among starved ones", () => {
    const jobs = [starved(1), tested(2), verdict];
    const annotations = { 1: said(NOT_ACQUIRED), 2: said("Process completed with exit code 1.") };
    const result = decide({ run, jobs, annotations });
    expect(result.rerun).toBe(false);
    expect(result.reason).toContain("browser tests (windows)");
  });

  it("does not re-run on attempt 2", () => {
    const result = decide({
      run: { ...run, run_attempt: 2 },
      jobs: [starved(1)],
      annotations: { 1: said(NOT_ACQUIRED) },
    });
    expect(result.rerun).toBe(false);
    expect(result.reason).toContain("attempt 2");
  });

  it("does not re-run a run that is not failed or cancelled", () => {
    expect(decide({ run: { ...run, conclusion: "success" }, jobs: [] }).rerun).toBe(false);
    expect(decide({ run: { ...run, conclusion: "action_required" }, jobs: [] }).rerun).toBe(false);
  });

  it("does not re-run when only the aggregate job failed in its own step", () => {
    expect(decide({ run, jobs: [verdict] }).rerun).toBe(false);
  });

  it("re-runs when only the aggregate job was starved", () => {
    const jobs = [
      { ...starved(1), conclusion: "success" },
      { ...verdict, steps: [] },
    ];
    const result = decide({ run, jobs, annotations: { 99: said(NOT_ACQUIRED) } });
    expect(result.rerun).toBe(true);
  });

  it("does not re-run a manual cancel, a concurrency cancel or an environment rejection", () => {
    const cases = [
      said("The run was canceled by @greenblacked."),
      said("Canceling since a higher priority waiting request for deploy-stage exists"),
      said("Branch is not allowed to deploy to production due to environment protection rules."),
    ];
    for (const annotations of cases) {
      const result = decide({ run, jobs: [cancelled(1)], annotations: { 1: annotations } });
      expect(result.rerun).toBe(false);
    }
  });
});

type Fake = ReturnType<typeof fakeGithub>;
let jobs: Job[];
let annotations: Record<number, Annotation[]>;
let runs: Run[];
let reruns: number[];
let asked: number[];
let listed: object[];
let head: string | undefined;

function fakeGithub() {
  return {
    paginate: async (
      fn: (p: { run_id?: number; check_run_id?: number }) => Promise<{ data: unknown }>,
      params: object,
    ) => (await fn(params)).data,
    rest: {
      actions: {
        listWorkflowRuns: async (params: object) => {
          listed.push(params);
          return { data: { workflow_runs: runs } };
        },
        listJobsForWorkflowRun: async () => ({ data: jobs }),
        reRunWorkflowFailedJobs: async ({ run_id }: { run_id: number }) => {
          reruns.push(run_id);
          return { data: {} };
        },
      },
      repos: {
        getBranch: async () => {
          if (head === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { commit: { sha: head } } };
        },
      },
      checks: {
        listAnnotations: async ({ check_run_id }: { check_run_id: number }) => {
          asked.push(check_run_id);
          return { data: annotations[check_run_id] ?? [] };
        },
      },
    },
  };
}

const call = (payload: Run) =>
  rerunInfra({
    github: fakeGithub(),
    context: { repo: { owner: "o", repo: "r" }, payload: { workflow_run: payload } },
    core: { info: () => undefined },
  });

describe("rerunInfra", () => {
  beforeEach(() => {
    jobs = [starved(1), starved(2), verdict];
    annotations = { 1: said(NOT_ACQUIRED), 2: said(NOT_ACQUIRED) };
    runs = [run];
    reruns = [];
    asked = [];
    listed = [];
    head = run.head_sha;
  });

  it("re-runs the failed jobs once when every one was lost to the runner", async () => {
    await call(run);
    expect(reruns).toEqual([500]);
    expect(asked).toEqual([1, 2]);
  });

  it("does nothing when a job failed in a test", async () => {
    jobs = [starved(1), tested(2), verdict];
    annotations = { 1: said(NOT_ACQUIRED), 2: said("Process completed with exit code 1.") };
    await call(run);
    expect(reruns).toEqual([]);
  });

  it("does nothing on attempt 2, without reading the API", async () => {
    await call({ ...run, run_attempt: 2 });
    expect(reruns).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("leaves a run that a newer run replaced", async () => {
    runs = [run, { ...run, id: 501, run_number: 8 }];
    await call(run);
    expect(reruns).toEqual([]);
  });

  it("leaves an older push run when a newer dispatched run exists", async () => {
    runs = [run, { ...run, id: 501, run_number: 8, event: "workflow_dispatch" }];
    await call(run);
    expect(reruns).toEqual([]);
  });

  const prRun: Run = { ...run, event: "pull_request", pull_requests: [{ number: 12 }] };

  it("re-runs a pull request run when a dispatched run is newer on the same branch", async () => {
    runs = [prRun, { ...run, id: 501, run_number: 8, event: "workflow_dispatch", pull_requests: [{ number: 12 }] }];
    await call(prRun);
    expect(reruns).toEqual([500]);
  });

  it("re-runs a pull request run when a push run is newer on the same branch", async () => {
    runs = [prRun, { ...run, id: 501, run_number: 8, event: "push", pull_requests: [{ number: 12 }] }];
    await call(prRun);
    expect(reruns).toEqual([500]);
  });

  it("re-runs a pull request run when a newer run belongs to another pull request", async () => {
    runs = [prRun, { ...prRun, id: 501, run_number: 8, pull_requests: [{ number: 13 }] }];
    await call(prRun);
    expect(reruns).toEqual([500]);
  });

  it("leaves a pull request run when a newer run of the same pull request exists", async () => {
    runs = [prRun, { ...prRun, id: 501, run_number: 8, head_sha: "bbb" }];
    await call(prRun);
    expect(reruns).toEqual([]);
  });

  it("matches a fork pull request run by head repository and branch", async () => {
    const fork: Run = { ...prRun, pull_requests: [], head_repository: { full_name: "f/r" } };
    runs = [fork, { ...fork, id: 501, run_number: 8, head_sha: "bbb" }];
    await call(fork);
    expect(reruns).toEqual([]);

    runs = [fork, { ...fork, id: 501, run_number: 8, head_repository: { full_name: "g/r" } }];
    await call(fork);
    expect(reruns).toEqual([500]);
  });

  it("asks only for pull request runs when it looks for a newer pull request run", async () => {
    await call(prRun);
    expect(listed).toEqual([expect.objectContaining({ event: "pull_request", branch: "dev" })]);
  });

  it("leaves a push run whose commit is no longer the branch head", async () => {
    head = "bbb";
    await call(run);
    expect(reruns).toEqual([]);
  });

  it("leaves a push run whose branch is gone", async () => {
    head = undefined;
    await call(run);
    expect(reruns).toEqual([]);
  });

  it("does not look at the branch head for a pull request run", async () => {
    head = "bbb";
    await call({ ...run, event: "pull_request" });
    expect(reruns).toEqual([500]);
  });

  it("asks the aggregate job why when it never ran its own step", async () => {
    jobs = [
      { ...starved(1), conclusion: "success" },
      { ...verdict, steps: [] },
    ];
    annotations = { 99: said(NOT_ACQUIRED) };
    await call(run);
    expect(asked).toEqual([99]);
    expect(reruns).toEqual([500]);
  });
});
