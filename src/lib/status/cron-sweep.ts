import { collectBoard } from "./collect-board";
import { readSnapshot, writeSnapshot } from "./kv-snapshot-store";
import { MIN_FORCED_REFRESH_MS } from "./schedule";
import type { SnapshotKv } from "./kv-snapshot-store";

/**
 * The Cloudflare Cron Trigger handler (wrangler.jsonc's `triggers.crons`,
 * every 2 minutes): the only thing on Workers that ever calls the vendors.
 * Every request reads the snapshot this writes (board.cloudflare.ts) instead
 * of collecting itself, so vendor load stays at one sweep per tick no matter
 * how many isolates or colos are serving requests.
 */
export async function runScheduledSweep(kv: SnapshotKv, now: () => number = Date.now): Promise<void> {
  const existing = await readSnapshot(kv);
  if (existing) {
    const age = now() - Date.parse(existing.generatedAt);
    // Cloudflare cron triggers are at-least-once, and a manual trigger
    // (`wrangler triggers` or the dashboard) can land moments after a
    // scheduled one. Skip a sweep that would just repeat the last one,
    // reusing the same window the Refresh button used to throttle itself.
    if (age >= 0 && age < MIN_FORCED_REFRESH_MS) return;
  }
  const snapshot = await collectBoard();
  await writeSnapshot(kv, snapshot);
}
