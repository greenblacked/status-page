import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Fake } from "@/test/d1-fake";
import { board, service } from "@/test/fixtures";
import type { CloudflareEnv } from "./cloudflare-context";
import { runScheduledHistory } from "./history-cron";

const getFreshStatusBoard = vi.hoisted(() => vi.fn());
vi.mock("./board", () => ({ getFreshStatusBoard }));
// The Worker entry builds TanStack's request handler at import; a stub keeps
// this test on the entry's own wiring.
vi.mock("@tanstack/react-start/server", () => ({
  createStartHandler: () => () => new Response("ok"),
  defaultStreamHandler: () => new Response("stream"),
}));

const NOON = Date.UTC(2026, 8, 25, 12, 0, 0);
let db: D1Fake;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = new D1Fake();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  getFreshStatusBoard.mockReset();
  getFreshStatusBoard.mockResolvedValue(
    board([service("aws"), service("gcp", { failure: { kind: "http", message: "secret body", status: 500 } })]),
  );
});

afterEach(() => {
  db.close();
  log.mockRestore();
});

describe("runScheduledHistory", () => {
  it("creates the table, records the board and logs one JSON line", async () => {
    await runScheduledHistory({ HISTORY_DB: db }, NOON);
    expect(db.rows()).toEqual([
      { day: "2026-09-25", service_id: "aws", samples: 1, up_samples: 1, worst: 0, last_slot: NOON / 300_000 },
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: "history_recorded",
      slot: NOON / 300_000,
      services: 1,
      skipped: 1,
    });
  });

  it("logs only the error's name and message, then rethrows", async () => {
    getFreshStatusBoard.mockRejectedValue(new TypeError("vendor sweep failed"));
    await expect(runScheduledHistory({ HISTORY_DB: db }, NOON)).rejects.toThrow("vendor sweep failed");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: "history_failed",
      name: "TypeError",
      message: "vendor sweep failed",
    });
    expect(db.rows()).toEqual([]);
  });

  it("fails loudly when the binding is missing", async () => {
    await expect(runScheduledHistory({}, NOON)).rejects.toThrow("HISTORY_DB");
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ event: "history_failed" });
  });

  it("logs a thrown non-Error as a plain message", async () => {
    getFreshStatusBoard.mockRejectedValue("nope");
    await expect(runScheduledHistory({ HISTORY_DB: db }, NOON)).rejects.toBe("nope");
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: "history_failed",
      name: "Error",
      message: "nope",
    });
  });
});

describe("Worker entry", () => {
  it("exports fetch and a scheduled handler that samples the board at the tick's time", async () => {
    const worker = (await import("@/server.cloudflare")).default;
    expect(typeof worker.fetch).toBe("function");
    const env: CloudflareEnv = { HISTORY_DB: db };
    const controller: ScheduledController = { scheduledTime: NOON, cron: "*/5 * * * *", noRetry() {} };
    await worker.scheduled(controller, env);
    expect(db.rows()).toHaveLength(1);
    expect(db.rows()[0]).toMatchObject({ service_id: "aws", last_slot: NOON / 300_000 });
  });
});
