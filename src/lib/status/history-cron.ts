import { getFreshStatusBoard } from "./board";
import type { CloudflareEnv } from "./cloudflare-context";
import { ensureSchema, recordBoardSample } from "./history-store";

/**
 * The Cron Trigger's job: one fresh board sample per five-minute slot into
 * D1. Rethrows on failure so a broken run shows as failed in the dashboard's
 * cron events. The log line carries only the error's name and message.
 */
export async function runScheduledHistory(env: CloudflareEnv, scheduledTime: number): Promise<void> {
  try {
    const db = env.HISTORY_DB;
    if (!db) throw new Error("HISTORY_DB binding is missing");
    await ensureSchema(db);
    // Not allowStale: a sample must come from a load no older than the cache
    // TTL, and the fresh path never needs the request context's waitUntil.
    const board = await getFreshStatusBoard();
    const { slot, services, skipped } = await recordBoardSample(db, board, scheduledTime);
    console.log(JSON.stringify({ event: "history_recorded", slot, services, skipped }));
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ event: "history_failed", name, message }));
    throw error;
  }
}
