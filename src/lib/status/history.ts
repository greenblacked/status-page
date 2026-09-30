import type { BoardSnapshot, Health } from "./types";

export const HISTORY_SCHEMA = 1;
export const HISTORY_TIMEZONE = "UTC";
export const HISTORY_RETENTION_DAYS = 30;

/**
 * History severity: outage is worst, operational is best. The same order as
 * the board's card urgency in layout.ts (outage, degraded, maintenance,
 * unknown), and distinct from the overall-health rank in health.ts, where
 * unknown outranks degraded.
 */
const HISTORY_RANK: Record<Health, number> = {
  operational: 0,
  unknown: 1,
  maintenance: 2,
  degraded: 3,
  outage: 4,
};

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
 * Drops days older than the retention window and caps length at
 * HISTORY_RETENTION_DAYS so the public payload cannot grow without bound.
 */
function trimDays(days: HistoryDay[], oldest: string): HistoryDay[] {
  const kept = days
    .filter((day) => day.date >= oldest)
    .map(publicDay)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (kept.length <= HISTORY_RETENTION_DAYS) return kept;
  return kept.slice(kept.length - HISTORY_RETENTION_DAYS);
}

function mergeDay(existing: HistoryDay | undefined, date: string, health: Health): HistoryDay {
  if (!existing) {
    return publicDay({
      date,
      worst: health,
      samples: 1,
      up: health === "operational" ? 1 : 0,
    });
  }
  const samples = existing.samples + 1;
  const operationalSamples = existing.up * existing.samples + (health === "operational" ? 1 : 0);
  return publicDay({
    date,
    worst: worseHistoryHealth(existing.worst, health),
    samples,
    up: operationalSamples / samples,
  });
}

/**
 * Merges one board sample per service into the UTC day of `generatedAt`.
 * Reads only `id` and `health` from each service: never failure.message,
 * vendor bodies, probe payloads, tokens or other collector fields.
 * Safe to call twice for the same snapshot: each call bumps `samples` and
 * recomputes `worst` / `up`. Corrupt or missing history starts fresh. An
 * unparseable `generatedAt` leaves history unchanged (or empty).
 */
export function mergeBoardIntoHistory(
  existing: HistoryDocument | null,
  board: Pick<BoardSnapshot, "generatedAt" | "services">,
  updatedAt: string = board.generatedAt,
): HistoryDocument {
  const day = utcDateString(board.generatedAt);
  if (!day) {
    return existing ?? emptyHistory(updatedAt);
  }

  const base = existing ?? emptyHistory(updatedAt);
  const oldest = oldestRetainedDate(day, HISTORY_RETENTION_DAYS);
  const services: Record<string, HistoryService> = {};

  for (const [id, entry] of Object.entries(base.services)) {
    const days = trimDays(entry.days, oldest);
    if (days.length > 0) services[id] = { days };
  }

  for (const service of board.services) {
    // Explicit pick: id + health only. Do not spread the ServiceSnapshot.
    const id = service.id;
    const health = service.health;
    const prior = services[id]?.days ?? [];
    const withoutToday = prior.filter((item) => item.date !== day);
    const today = prior.find((item) => item.date === day);
    const days = trimDays([...withoutToday, mergeDay(today, day, health)], oldest);
    services[id] = { days };
  }

  return {
    schema: HISTORY_SCHEMA,
    updatedAt,
    timezone: HISTORY_TIMEZONE,
    retentionDays: HISTORY_RETENTION_DAYS,
    services,
  };
}

/**
 * Serializer for /api/history.json: only document
 * metadata and the four public day fields. Extra keys on in-memory days
 * are stripped even if a future merge kept them.
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
