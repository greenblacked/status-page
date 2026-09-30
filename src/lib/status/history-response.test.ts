import { describe, expect, it, vi } from "vitest";
import { emptyHistory, type PublicHistory } from "./history";
import { createHistoryResponder, HISTORY_MEMO_MS } from "./history-response";

function doc(updatedAt: string): PublicHistory {
  return {
    ...emptyHistory(updatedAt),
    services: { gcp: { days: [{ date: "2026-09-30", worst: "degraded", samples: 3, up: 2 / 3 }] } },
  };
}

describe("createHistoryResponder", () => {
  it("serves the document with the public headers", async () => {
    const value = doc("2026-09-30T12:00:00.000Z");
    const respond = createHistoryResponder(
      async () => value,
      () => 1000,
    );
    const response = await respond();
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=60");
    expect(await response.json()).toEqual(value);
  });

  it("reuses one read within 60 seconds and refreshes after", async () => {
    let now = 0;
    const read = vi.fn(async () => doc(`t${now}`));
    const respond = createHistoryResponder(read, () => now);
    await respond();
    now = HISTORY_MEMO_MS - 1;
    const cached = await respond();
    expect(read).toHaveBeenCalledTimes(1);
    expect(((await cached.json()) as PublicHistory).updatedAt).toBe("t0");
    now = HISTORY_MEMO_MS;
    const fresh = await respond();
    expect(read).toHaveBeenCalledTimes(2);
    expect(((await fresh.json()) as PublicHistory).updatedAt).toBe(`t${HISTORY_MEMO_MS}`);
  });

  it("shares one in-flight read between concurrent requests", async () => {
    const read = vi.fn(async () => doc("x"));
    const respond = createHistoryResponder(read, () => 0);
    await Promise.all([respond(), respond(), respond()]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers 503 no-store without leaking the error, and does not memoize it", async () => {
    const read = vi
      .fn<() => Promise<PublicHistory>>()
      .mockRejectedValueOnce(new Error("D1_ERROR: secret detail"))
      .mockResolvedValueOnce(doc("ok"));
    const respond = createHistoryResponder(read, () => 0);
    const failed = await respond();
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(failed.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({ error: "history unavailable" });
    expect(text).not.toMatch(/secret|D1_ERROR/);
    const recovered = await respond();
    expect(recovered.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
