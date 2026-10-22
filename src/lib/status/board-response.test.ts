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

  it("gives the answer an ETag and answers a repeat that sends it with 304, given the request", async () => {
    const respond = (loaded: BoardSnapshot) => Response.json(loaded, { headers: { "Cache-Control": "public" } });
    const url = "https://status.example.com/api/status.json";
    const first = await respondWithBoard(async () => board, respond, new Request(url));
    const etag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"/);
    await expect(first.json()).resolves.toEqual(board);

    const repeat = await respondWithBoard(
      async () => board,
      respond,
      new Request(url, { headers: { "If-None-Match": etag ?? "" } }),
    );
    expect(repeat.status).toBe(304);
    expect(repeat.body).toBeNull();
    expect(repeat.headers.get("ETag")).toBe(etag);
    expect(repeat.headers.get("Cache-Control")).toBe("public");
  });

  it("sends no ETag without the request", async () => {
    const response = await respondWithBoard(
      async () => board,
      (loaded) => Response.json(loaded),
    );
    expect(response.headers.has("ETag")).toBe(false);
  });

  it("answers 503 with Retry-After, uncached, when there is no board", async () => {
    const respond = vi.fn();
    const response = await respondWithBoard(
      () => Promise.reject(new Error("collect failed")),
      respond,
      new Request("https://status.example.com/feed.xml", { headers: { "If-None-Match": "*" } }),
    );

    expect(respond).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe(String(BOARD_RETRY_AFTER_SECONDS));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.has("ETag")).toBe(false);
    await expect(response.json()).resolves.toHaveProperty("error");
    expect(JSON.parse(String(vi.mocked(console.error).mock.calls[0]?.[0]))).toEqual({
      event: "board_unavailable",
      message: "collect failed",
    });
  });
});
