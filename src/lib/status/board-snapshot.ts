import { collectBoard } from "./collect-board";
import { readSnapshot, writeSnapshot } from "./kv-snapshot-store";
import type { SnapshotKv } from "./kv-snapshot-store";
import type { BoardSnapshot } from "./types";

// How long an isolate reuses its own last read before asking KV again. KV is
// eventually consistent and cheap but not free; a few seconds of staleness
// on top of the cron's own 2-minute cadence is not worth a read per request.
const ISOLATE_MEMO_MS = 5_000;

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
  let cached: { at: number; value: BoardSnapshot } | null = null;
  let inflight: Promise<BoardSnapshot> | null = null;

  function loadFresh(waitUntil: WaitUntil): Promise<BoardSnapshot> {
    if (inflight) return inflight;

    inflight = (async () => {
      const stored = await readSnapshot(kv);
      if (stored) return stored;
      // Cold start: KV has nothing yet, either a fresh deploy or a namespace
      // that outran the first cron tick (up to 2 minutes). Collect once on
      // the request path so this visitor is not stuck waiting for the cron,
      // and hand the KV write to `waitUntil` so it is not lost if the Worker
      // is torn down right after the response is sent.
      const snapshot = await collectBoard();
      waitUntil(writeSnapshot(kv, snapshot).catch(() => {}));
      return snapshot;
    })()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  }

  return {
    read(waitUntil: WaitUntil): Promise<BoardSnapshot> {
      if (cached && Date.now() - cached.at < ISOLATE_MEMO_MS) return Promise.resolve(cached.value);
      return loadFresh(waitUntil);
    },

    async refresh(waitUntil: WaitUntil): Promise<BoardSnapshot> {
      // The Refresh button never sweeps vendors itself on Workers: doing so
      // synchronously on the request path risks the CPU-time limit a single
      // request gets (warm SSR alone measures 14-30ms locally, close to the
      // Free plan's 10ms budget), and the cron already refreshes every two
      // minutes from every colo's worth of clicks. Returning the newest KV
      // snapshot also doubles as the global throttle the button needs: every
      // isolate reads the one value the cron wrote, instead of each starting
      // its own sweep and its own 15-second timer.
      const stored = await readSnapshot(kv);
      if (stored) {
        cached = { at: Date.now(), value: stored };
        return stored;
      }
      // KV still empty: fall back to the same cold-start path as a normal
      // read, so Refresh works even before the first cron tick has landed.
      return this.read(waitUntil);
    },
  };
}
