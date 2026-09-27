import { collectBoard } from "./collect-board";
import { readSnapshot, writeSnapshot } from "./kv-snapshot-store";
import type { SnapshotKv } from "./kv-snapshot-store";
import type { BoardSnapshot } from "./types";

// How long an isolate reuses its own last read before asking KV again. KV is
// eventually consistent and cheap but not free; a few seconds of staleness
// on top of the cron's own 2-minute cadence is not worth a read per request.
const ISOLATE_MEMO_MS = 5_000;
// How long an isolate reuses a board it collected itself because KV failed
// (collectDuringKvOutage below). Much longer than ISOLATE_MEMO_MS: each
// retry is a full vendor sweep on the request path, not a cheap KV read,
// and a minute is still half the cron's own cadence.
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
        return { value: await collectDuringKvOutage(error), ttlMs: KV_OUTAGE_MEMO_MS };
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

  function read(waitUntil: WaitUntil): Promise<BoardSnapshot> {
    if (cached && Date.now() - cached.at < cached.ttlMs) return Promise.resolve(cached.value);
    // Only reached when KV and the collect behind it both failed: an isolate
    // that has shown a board keeps showing it rather than turning every
    // request into an error.
    return loadFresh(waitUntil).catch((error: unknown) => {
      if (cached) return cached.value;
      throw error;
    });
  }

  return {
    read,

    async refresh(waitUntil: WaitUntil): Promise<BoardSnapshot> {
      // The Refresh button never sweeps vendors itself on Workers: doing so
      // synchronously on the request path risks the CPU-time limit a single
      // request gets (warm SSR alone measures 14-30ms locally, close to the
      // Free plan's 10ms budget), and the cron already refreshes every two
      // minutes from every colo's worth of clicks. Returning the newest KV
      // snapshot also doubles as the global throttle the button needs: every
      // isolate reads the one value the cron wrote, instead of each starting
      // its own sweep and its own 15-second timer.
      let stored: BoardSnapshot | null = null;
      try {
        stored = await readSnapshot(kv);
      } catch {
        // KV is failing: read() below serves this isolate's outage board,
        // collected at most once a minute, instead of failing the click.
      }
      if (stored) {
        cached = { at: Date.now(), ttlMs: ISOLATE_MEMO_MS, value: stored };
        return stored;
      }
      // KV empty or failing: the same path as a normal read, so Refresh
      // works before the first cron tick has landed and during an outage.
      return read(waitUntil);
    },
  };
}

/**
 * KV answered with an error rather than a value (readSnapshot already turns
 * an unparseable value into null). Without this a cold isolate had nothing
 * to show, and every route answered 500 for as long as KV was down. Collect
 * the board here instead, but never write it back: KV is what is failing,
 * and the cron owns what is stored there. The caller memoises the result
 * for KV_OUTAGE_MEMO_MS, so an outage costs each isolate one vendor sweep a
 * minute, not one per request.
 */
async function collectDuringKvOutage(error: unknown): Promise<BoardSnapshot> {
  console.warn(
    JSON.stringify({ event: "kv_read_failed", message: error instanceof Error ? error.message : String(error) }),
  );
  return collectBoard();
}
