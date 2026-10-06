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
  event: string;
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
const tested = (id: number, name = "browser tests (chromium-desktop)"): Job => ({
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
    expect(result.reason).toContain("browser tests (chromium-desktop)");
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

  it("does not re-run when only the aggregate job failed", () => {
    expect(decide({ run, jobs: [verdict] }).rerun).toBe(false);
  });
});

type Fake = ReturnType<typeof fakeGithub>;
let jobs: Job[];
let annotations: Record<number, Annotation[]>;
let runs: Run[];
let reruns: number[];
let asked: number[];

function fakeGithub() {
  return {
    paginate: async (
      fn: (p: { run_id?: number; check_run_id?: number }) => Promise<{ data: unknown }>,
      params: object,
    ) => (await fn(params)).data,
    rest: {
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }),
        listJobsForWorkflowRun: async () => ({ data: jobs }),
        reRunWorkflowFailedJobs: async ({ run_id }: { run_id: number }) => {
          reruns.push(run_id);
          return { data: {} };
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
});
