import type { Health } from "./types";

export const HISTORY_SCHEMA = 1;
export const HISTORY_TIMEZONE = "UTC";
export const HISTORY_RETENTION_DAYS = 30;

/**
 * History severity, best first and worst last: outage is worst, operational is
 * best. The same order as the board's card urgency in layout.ts (outage,
 * degraded, maintenance, unknown), and distinct from the overall-health rank in
 * health.ts, where unknown outranks degraded. The D1 store persists a day's
 * worst health as an index into this list, so never reorder it: append only,
 * or add a new schema version.
 */
export const HISTORY_ORDER: readonly Health[] = ["operational", "unknown", "maintenance", "degraded", "outage"];

const HISTORY_RANK = Object.fromEntries(HISTORY_ORDER.map((health, rank) => [health, rank])) as Record<Health, number>;

const HEALTHS = new Set<string>(Object.keys(HISTORY_RANK));

/** Public day fields only. Only these fields may reach /api/history.json. */
export type HistoryDay = {
  date: string;
  worst: Health;
  samples: number;
  /** Fraction of samples that day with health `operational` (0–1). */
  up: number;
};

export type HistoryService = {
  days: HistoryDay[];
};

export type HistoryDocument = {
  schema: typeof HISTORY_SCHEMA;
  updatedAt: string;
  timezone: typeof HISTORY_TIMEZONE;
  retentionDays: typeof HISTORY_RETENTION_DAYS;
  services: Record<string, HistoryService>;
};

/** Public API body: document metadata plus public day fields only. */
export type PublicHistory = HistoryDocument;

export function emptyHistory(updatedAt: string): HistoryDocument {
  return {
    schema: HISTORY_SCHEMA,
    updatedAt,
    timezone: HISTORY_TIMEZONE,
    retentionDays: HISTORY_RETENTION_DAYS,
    services: {},
  };
}

/** The worse of two healths by history severity, for a day's worst health. */
export function worseHistoryHealth(a: Health, b: Health): Health {
  return HISTORY_RANK[a] >= HISTORY_RANK[b] ? a : b;
}

/** YYYY-MM-DD for an ISO-8601 instant, or null when the stamp is unusable. */
export function utcDateString(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Oldest YYYY-MM-DD still inside a `retentionDays`-long UTC window ending on `today`. */
export function oldestRetainedDate(today: string, retentionDays: number): string {
  const start = new Date(`${today}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - (retentionDays - 1));
  return start.toISOString().slice(0, 10);
}

function isHealth(value: unknown): value is Health {
  return typeof value === "string" && HEALTHS.has(value);
}

/**
 * Copies only the four public day fields. Extra keys on an in-memory day
 * are dropped before the public API.
 */
export function publicDay(day: HistoryDay): HistoryDay {
  return {
    date: day.date,
    worst: day.worst,
    samples: day.samples,
    up: day.up,
  };
}

function isHistoryDay(value: unknown): value is HistoryDay {
  if (typeof value !== "object" || value === null) return false;
  const day = value as Partial<HistoryDay>;
  return (
    typeof day.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
    isHealth(day.worst) &&
    typeof day.samples === "number" &&
    Number.isFinite(day.samples) &&
    day.samples > 0 &&
    typeof day.up === "number" &&
    Number.isFinite(day.up) &&
    day.up >= 0 &&
    day.up <= 1
  );
}

/**
 * Accepts a stored value or returns null when it is unusable. A partial
 * document keeps only well-formed service days; corrupt entries are dropped
 * without failing parsing. Wrong schema or a non-object resets to null.
 * Day objects are re-projected to public fields.
 */
export function parseHistory(value: unknown): HistoryDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<HistoryDocument>;
  if (candidate.schema !== HISTORY_SCHEMA) return null;
  if (typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) {
    return null;
  }
  if (candidate.timezone !== HISTORY_TIMEZONE) return null;
  if (candidate.retentionDays !== HISTORY_RETENTION_DAYS) return null;
  if (typeof candidate.services !== "object" || candidate.services === null || Array.isArray(candidate.services)) {
    return null;
  }

  const services: Record<string, HistoryService> = {};
  for (const [id, entry] of Object.entries(candidate.services)) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof entry !== "object" || entry === null || !Array.isArray((entry as HistoryService).days)) continue;
    const days = (entry as HistoryService).days.filter(isHistoryDay).map(publicDay);
    if (days.length === 0) continue;
    services[id] = { days };
  }

  return {
    schema: HISTORY_SCHEMA,
    updatedAt: candidate.updatedAt,
    timezone: HISTORY_TIMEZONE,
    retentionDays: HISTORY_RETENTION_DAYS,
    services,
  };
}

/**
 * Serializer for /api/history.json: only document metadata and the four
 * public day fields. Extra keys on a day are stripped, whatever produced it.
 */
export function publicHistory(document: HistoryDocument): PublicHistory {
  const services: Record<string, HistoryService> = {};
  for (const [id, entry] of Object.entries(document.services)) {
    services[id] = { days: entry.days.map(publicDay) };
  }
  return {
    schema: HISTORY_SCHEMA,
    updatedAt: document.updatedAt,
    timezone: HISTORY_TIMEZONE,
    retentionDays: HISTORY_RETENTION_DAYS,
    services,
  };
}
