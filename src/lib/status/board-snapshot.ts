import { collectBoard } from "./collect-board";
import { readSnapshot, writeSnapshot } from "./kv-snapshot-store";
import type { SnapshotKv } from "./kv-snapshot-store";
import { READY_MAX_AGE_MS } from "./readiness";
import type { BoardSnapshot } from "./types";

// How long an isolate reuses its own last read before asking KV again. KV is
// eventually consistent and cheap but not free; a few seconds of staleness
// on top of the cron's own 2-minute cadence is not worth a read per request.
const ISOLATE_MEMO_MS = 5_000;
// How long an isolate serves its outage board (duringKvOutage below) before
// asking KV again. Much longer than ISOLATE_MEMO_MS: a retry can mean a
// full vendor sweep on the request path, not a cheap KV read, and a minute
// is still half the cron's own cadence.
const KV_OUTAGE_MEMO_MS = 60_000;

export type WaitUntil = (promise: Promise<unknown>) => void;

export type BoardSnapshotReader = {
  read(waitUntil: WaitUntil): Promise<BoardSnapshot>;
  refresh(waitUntil: WaitUntil): Promise<BoardSnapshot>;
};

/**
 * Reads the board snapshot the Cron Trigger writes to KV (cron-sweep.ts).
 * One of these is created per isolate (board.cloudflare.ts) and reused for
 * every request it serves, so the isolate memo below and KV's own request
 * are both shared instead of repeated per request.
 */
export function createBoardSnapshotReader(kv: SnapshotKv): BoardSnapshotReader {
  let cached: { at: number; ttlMs: number; value: BoardSnapshot } | null = null;
  let inflight: Promise<BoardSnapshot> | null = null;

  function loadFresh(waitUntil: WaitUntil): Promise<BoardSnapshot> {
    if (inflight) return inflight;

    inflight = (async (): Promise<{ value: BoardSnapshot; ttlMs: number }> => {
      let stored: BoardSnapshot | null;
      try {
        stored = await readSnapshot(kv);
      } catch (error) {
        return { value: await duringKvOutage(error), ttlMs: KV_OUTAGE_MEMO_MS };
      }
      if (stored) return { value: stored, ttlMs: ISOLATE_MEMO_MS };
      // Cold start: KV has nothing yet, either a fresh deploy or a namespace
      // that outran the first cron tick (up to 2 minutes). Collect once on
      // the request path so this visitor is not stuck waiting for the cron,
      // and hand the KV write to `waitUntil` so it is not lost if the Worker
      // is torn down right after the response is sent.
      const snapshot = await collectBoard();
      waitUntil(writeSnapshot(kv, snapshot).catch(() => {}));
      return { value: snapshot, ttlMs: ISOLATE_MEMO_MS };
    })()
      .then(({ value, ttlMs }) => {
        cached = { at: Date.now(), ttlMs, value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  }

  /**
   * KV answered with an error rather than a value (readSnapshot already
   * turns an unparseable value into null). The board this isolate already
   * holds is kept while it is young enough to stay under /readyz's
   * READY_MAX_AGE_MS for the whole outage memo: it came from KV or from an
   * earlier outage collect, and a sweep on the request path would cost
   * every vendor fetch for a board that is at best a little newer, and
   * worse when some vendors time out. Only a cold isolate, or one whose
   * board has grown too old (or has no parseable generatedAt), collects:
   * without that a cold isolate had nothing to show, and every route
   * answered 500 for as long as KV was down. Either way nothing is written
   * back: KV is what is failing, and the cron owns what is stored there.
   * The caller memoises the result for KV_OUTAGE_MEMO_MS, so an outage
   * costs each isolate a KV read a minute and a vendor sweep only when its
   * board is about to go stale.
   */
  async function duringKvOutage(error: unknown): Promise<BoardSnapshot> {
    console.warn(
      JSON.stringify({ event: "kv_read_failed", message: error instanceof Error ? error.message : String(error) }),
    );
    const kept = cached?.value;
    if (kept && Date.now() - Date.parse(kept.generatedAt) + KV_OUTAGE_MEMO_MS <= READY_MAX_AGE_MS) return kept;
    return collectBoard();
  }

  // `skipIsolateMemo` skips only the five-second memo of a KV read: an
  // outage memo still stands, so nothing gets to turn an outage back into a
  // KV read and a possible sweep per request.
  function serve(waitUntil: WaitUntil, skipIsolateMemo: boolean): Promise<BoardSnapshot> {
    if (cached && Date.now() - cached.at < cached.ttlMs && !(skipIsolateMemo && cached.ttlMs === ISOLATE_MEMO_MS)) {
      return Promise.resolve(cached.value);
    }
    // Each collector turns its own failure into an Unknown card, so
    // collectBoard() does not reject in practice; should it throw anyway, an
    // isolate that has shown a board keeps showing it rather than turning
    // every request into an error.
    return loadFresh(waitUntil).catch((error: unknown) => {
      if (cached) return cached.value;
      throw error;
    });
  }

  return {
    read(waitUntil: WaitUntil): Promise<BoardSnapshot> {
      return serve(waitUntil, false);
    },

    refresh(waitUntil: WaitUntil): Promise<BoardSnapshot> {
      // The Refresh button never sweeps vendors itself on Workers: doing so
      // synchronously on the request path risks the CPU-time limit a single
      // request gets (warm SSR alone measures 14-30ms locally, close to the
      // Free plan's 10ms budget), and the cron already refreshes every two
      // minutes from every colo's worth of clicks. Returning the newest KV
      // snapshot also doubles as the global throttle the button needs: every
      // isolate reads the one value the cron wrote, instead of each starting
      // its own sweep and its own 15-second timer.
      //
      // So a click is a normal read that skips the five-second memo: one KV
      // read, or, with KV empty or failing, the same cold-start collect or
      // outage board as any request, so Refresh works before the first cron
      // tick has landed and during an outage without reading KV twice.
      return serve(waitUntil, true);
    },
  };
}
