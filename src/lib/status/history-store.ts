import {
  emptyHistory,
  HISTORY_RETENTION_DAYS,
  type HistoryDay,
  type HistoryDocument,
  type HistoryService,
  oldestRetainedDate,
  type PublicHistory,
  publicHistory,
} from "./history";
import type { BoardSnapshot, Health } from "./types";

/**
 * The slice of a D1 database this module uses, so tests can stand in a
 * node:sqlite fake and the Node build never needs the Workers types. A real
 * D1Database satisfies it (checked in history-store.test.ts).
 */
export type HistoryValue = string | number | null;

export interface HistoryStatement {
  bind(...values: HistoryValue[]): HistoryStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface HistoryDb {
  prepare(query: string): HistoryStatement;
  batch(statements: HistoryStatement[]): Promise<unknown[]>;
  exec(query: string): Promise<unknown>;
}

/** One board sample every five minutes, on the cron's own clock. */
export const HISTORY_SLOT_MS = 300_000;
const SLOTS_PER_DAY = 86_400_000 / HISTORY_SLOT_MS;

/**
 * Storage order of `worst`, worst last. It mirrors the private HISTORY_RANK in
 * history.ts (operational, unknown, maintenance, degraded, outage), and
 * history-store.test.ts checks it against worseHistoryHealth so the two
 * cannot drift apart.
 */
export const HISTORY_ORDER: readonly Health[] = ["operational", "unknown", "maintenance", "degraded", "outage"];

/**
 * One row per service per UTC day. `last_slot` makes the upsert idempotent: a
 * retried or out-of-order cron run for a slot that is already counted (or
 * older) changes nothing. WITHOUT ROWID keeps the table to its primary key.
 */
const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS history_day_v1 (day TEXT NOT NULL, service_id TEXT NOT NULL, samples INTEGER NOT NULL, up_samples INTEGER NOT NULL, worst INTEGER NOT NULL, last_slot INTEGER NOT NULL, PRIMARY KEY (day, service_id)) WITHOUT ROWID";

const UPSERT =
  "INSERT INTO history_day_v1 (day, service_id, samples, up_samples, worst, last_slot) VALUES (?1, ?2, 1, ?3, ?4, ?5) " +
  "ON CONFLICT(day, service_id) DO UPDATE SET samples = samples + 1, up_samples = up_samples + excluded.up_samples, " +
  "worst = max(worst, excluded.worst), last_slot = excluded.last_slot WHERE history_day_v1.last_slot < excluded.last_slot";

const PRUNE = "DELETE FROM history_day_v1 WHERE day < ?1";

const SELECT_SINCE =
  "SELECT day, service_id, samples, up_samples, worst, last_slot FROM history_day_v1 WHERE day >= ?1 ORDER BY service_id, day";

const schemaReady = new WeakMap<object, Promise<void>>();

/**
 * Creates the table when missing. Only the cron path calls it, and at most
 * once per isolate per database; a failure is not remembered, so the next run
 * tries again. Deliberately a prepared statement, not `exec`, which D1 splits
 * per line.
 */
export function ensureSchema(db: HistoryDb): Promise<void> {
  const known = schemaReady.get(db);
  if (known) return known;
  const pending = db
    .prepare(CREATE_TABLE)
    .run()
    .then(() => undefined);
  schemaReady.set(db, pending);
  pending.catch(() => {
    if (schemaReady.get(db) === pending) schemaReady.delete(db);
  });
  return pending;
}

export type RecordResult = { slot: number; services: number; skipped: number };

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Counts one board sample per service into the UTC day of the cron slot.
 *
 * - Services whose collector failed are skipped: a broken collector is not
 *   vendor downtime. If every service failed, no sample is written.
 * - "updates" (changelog) services are skipped: their cards show no strip,
 *   so they would only occupy rows.
 * - The slot comes from the cron's scheduledTime, not from the board's clock,
 *   so a retried run of the same slot is a no-op.
 * - Reads only id, health, category and failure from each service.
 * - On the first slot of a UTC day, days outside the window are deleted in
 *   the same batch.
 */
export async function recordBoardSample(
  db: HistoryDb,
  board: Pick<BoardSnapshot, "services">,
  scheduledTime: number,
): Promise<RecordResult> {
  if (!Number.isFinite(scheduledTime)) throw new Error("scheduledTime must be a finite number");
  const slot = Math.floor(scheduledTime / HISTORY_SLOT_MS);
  const day = utcDay(slot * HISTORY_SLOT_MS);

  const statements: HistoryStatement[] = [];
  let skipped = 0;
  for (const service of board.services) {
    if (service.category === "updates" || service.failure) {
      skipped++;
      continue;
    }
    const up = service.health === "operational" ? 1 : 0;
    const worst = HISTORY_ORDER.indexOf(service.health);
    statements.push(db.prepare(UPSERT).bind(day, service.id, up, worst, slot));
  }
  const services = statements.length;

  if (slot % SLOTS_PER_DAY === 0) {
    statements.push(db.prepare(PRUNE).bind(oldestRetainedDate(day, HISTORY_RETENTION_DAYS)));
  }
  if (statements.length > 0) await db.batch(statements);
  return { slot, services, skipped };
}

type HistoryRow = {
  day: string;
  service_id: string;
  samples: number;
  up_samples: number;
  worst: number;
  last_slot: number;
};

function isRow(value: unknown): value is HistoryRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.day) &&
    typeof row.service_id === "string" &&
    row.service_id.length > 0 &&
    Number.isInteger(row.samples) &&
    (row.samples as number) > 0 &&
    Number.isInteger(row.up_samples) &&
    (row.up_samples as number) >= 0 &&
    Number.isInteger(row.worst) &&
    (row.worst as number) >= 0 &&
    (row.worst as number) < HISTORY_ORDER.length &&
    Number.isFinite(row.last_slot)
  );
}

/**
 * Stored rows to the internal history document. Rows that are malformed or
 * outside the 30-day window ending on `now`'s UTC day are dropped. `updatedAt`
 * is the newest sample's slot start, or `now` when there is none.
 */
export function rowsToHistory(rows: readonly unknown[], now: number = Date.now()): HistoryDocument {
  const nowIso = new Date(now).toISOString();
  const oldest = oldestRetainedDate(nowIso.slice(0, 10), HISTORY_RETENTION_DAYS);
  const services: Record<string, HistoryService> = {};
  let newestSlot = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    if (!isRow(row) || row.day < oldest) continue;
    const entry = services[row.service_id] ?? { days: [] };
    const day: HistoryDay = {
      date: row.day,
      worst: HISTORY_ORDER[row.worst],
      samples: row.samples,
      up: Math.min(1, row.up_samples / row.samples),
    };
    entry.days.push(day);
    services[row.service_id] = entry;
    newestSlot = Math.max(newestSlot, row.last_slot);
  }
  for (const entry of Object.values(services)) {
    entry.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const document = emptyHistory(
    Number.isFinite(newestSlot) ? new Date(newestSlot * HISTORY_SLOT_MS).toISOString() : nowIso,
  );
  document.services = services;
  return document;
}

function isMissingTable(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; cause && depth < 4; depth++) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/no such table/i.test(message)) return true;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return false;
}

/**
 * The public history document, read from D1. No binding, or a table the cron
 * has not created yet, reads as an empty document; any other database error
 * propagates so the route can answer 5xx rather than cache a wrong "no
 * history".
 */
export async function readPublicHistory(db: HistoryDb | undefined, now: number = Date.now()): Promise<PublicHistory> {
  if (!db) return publicHistory(rowsToHistory([], now));
  const oldest = oldestRetainedDate(utcDay(now), HISTORY_RETENTION_DAYS);
  try {
    const { results } = await db.prepare(SELECT_SINCE).bind(oldest).all();
    return publicHistory(rowsToHistory(results, now));
  } catch (error) {
    if (isMissingTable(error)) return publicHistory(rowsToHistory([], now));
    throw error;
  }
}
