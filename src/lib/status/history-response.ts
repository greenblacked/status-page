import type { PublicHistory } from "./history";
import { PUBLIC_HEADERS } from "./integrations";

/** How long one isolate or process reuses a history read before asking the database again. */
export const HISTORY_MEMO_MS = 300_000;

/**
 * Builds the GET /api/history.json handler around a `read` function. A good
 * read is kept for five minutes per isolate (the data changes once per cron
 * tick and the strip moves by day), so a busy page costs the database one
 * read per five minutes, not one per visitor. Concurrent requests on a cold
 * memo each read: a shared in-flight promise could outlive a cancelled
 * request, and the memo already bounds the load. A failed read is never kept:
 * the next request tries again. Any error answers 503 with a fixed body and
 * `no-store`; the error itself is never sent to the client. Takes the reader
 * and the clock as arguments, so it needs no Worker or database to test.
 */
export function createHistoryResponder(read: () => Promise<PublicHistory>, clock: () => number = Date.now) {
  let memo: { at: number; value: PublicHistory } | null = null;

  async function load(): Promise<PublicHistory> {
    if (memo && clock() - memo.at < HISTORY_MEMO_MS) return memo.value;
    const value = await read();
    memo = { at: clock(), value };
    return value;
  }

  return async function respond(): Promise<Response> {
    try {
      return Response.json(await load(), { headers: PUBLIC_HEADERS });
    } catch {
      return Response.json(
        { error: "history unavailable" },
        { status: 503, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
      );
    }
  };
}
