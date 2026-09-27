import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_RETRY_AFTER_SECONDS, respondWithBoard } from "./board-response";
import type { BoardSnapshot } from "./types";

const board: BoardSnapshot = {
  generatedAt: "2026-09-27T00:00:00.000Z",
  durationMs: 10,
  services: [],
  counts: { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 },
};

describe("respondWithBoard", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the board to the responder", async () => {
    const response = await respondWithBoard(
      async () => board,
      (loaded) => new Response(loaded.generatedAt, { status: 200 }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("2026-09-27T00:00:00.000Z");
  });

  it("answers 503 with Retry-After, uncached, when there is no board", async () => {
    const respond = vi.fn();
    const response = await respondWithBoard(() => Promise.reject(new Error("KV unavailable")), respond);

    expect(respond).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe(String(BOARD_RETRY_AFTER_SECONDS));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toHaveProperty("error");
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[0]?.[0]))).toEqual({
      event: "board_unavailable",
      message: "KV unavailable",
    });
  });
});
