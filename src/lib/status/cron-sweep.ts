import { collectBoard } from "./collect-board";
import { mergeBoardIntoHistory } from "./history";
import type { SnapshotKv } from "./kv-snapshot-store";
import { readHistory, readSnapshot, writeHistory, writeSnapshot } from "./kv-snapshot-store";
import { MIN_FORCED_REFRESH_MS } from "./schedule";

/**
 * The Cloudflare Cron Trigger handler (wrangler.jsonc's `triggers.crons`,
 * every 2 minutes): the only thing on Workers that ever calls the vendors.
 * Every request reads the snapshot this writes (board.cloudflare.ts) instead
 * of collecting itself, so vendor load stays at one sweep per tick no matter
 * how many isolates or colos are serving requests.
 *
 * After a successful board write it also merges one sample per service into
 * the rolling `history:v1` document (UTC day buckets, 30-day retention).
 * Requests never write either key.
 *
 * Each run ends in exactly one JSON log line, `sweep_completed` or
 * `sweep_failed`, so Workers Logs (observability in wrangler.jsonc) can be
 * queried and alerted on by `event` without parsing prose: a run of
 * `sweep_failed`, or `sweep_completed` with `unknown` equal to `services`,
 * is a board that has stopped updating even though every request still
 * answers.
 */
export async function runScheduledSweep(kv: SnapshotKv, now: () => number = Date.now): Promise<void> {
  const started = now();
  try {
    const existing = await readSnapshot(kv);
    if (existing) {
      const age = now() - Date.parse(existing.generatedAt);
      // Cloudflare cron triggers are at-least-once, and a manual trigger
      // (`wrangler triggers` or the dashboard) can land moments after a
      // scheduled one. Skip a sweep that would just repeat the last one,
      // reusing the same window the Refresh button used to throttle itself.
      if (age >= 0 && age < MIN_FORCED_REFRESH_MS) {
        console.log(
          JSON.stringify({
            event: "sweep_completed",
            durationMs: now() - started,
            services: existing.services.length,
            unknown: existing.counts.unknown ?? 0,
            bytes: 0,
            historyBytes: 0,
            skipped: true,
          }),
        );
        return;
      }
    }
    const snapshot = await collectBoard();
    const bytes = await writeSnapshot(kv, snapshot);
    // History is best-effort for the log line, but a merge/put failure still
    // fails the sweep: the board write already landed, and the next tick
    // retries the merge from whatever is stored (corrupt history recovers).
    let historyBytes = 0;
    try {
      const prior = await readHistory(kv);
      const history = mergeBoardIntoHistory(prior, snapshot);
      historyBytes = await writeHistory(kv, history);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "history_merge_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
    console.log(
      JSON.stringify({
        event: "sweep_completed",
        durationMs: now() - started,
        services: snapshot.services.length,
        unknown: snapshot.counts.unknown,
        bytes,
        historyBytes,
        skipped: false,
      }),
    );
  } catch (error) {
    // Logged here and rethrown: the rethrow is what marks the cron run as
    // failed in the dashboard (server.cloudflare.ts awaits this), and the
    // line is what a log query can find.
    console.error(
      JSON.stringify({ event: "sweep_failed", message: error instanceof Error ? error.message : String(error) }),
    );
    throw error;
  }
}
