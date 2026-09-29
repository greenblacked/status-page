import { healthLabel } from "./health";
import {
  emptyHistory,
  HISTORY_RETENTION_DAYS,
  type HistoryDay,
  oldestRetainedDate,
  type PublicHistory,
  parseHistory,
  utcDateString,
  worseHistoryHealth,
} from "./history";

/** How long the board waits for /api/history.json before treating it as empty. */
export const HISTORY_FETCH_TIMEOUT_MS = 8_000;

/**
 * Client fetch of the public history document. Same-origin on Node and
 * Workers; CORS is already open for cross-origin readers. By default any
 * failure, timeout, non-OK status or malformed body becomes an empty document
 * so the board still loads. With `throwOnError` the same failures reject
 * instead, for a caller (the query cache) that must keep its previous good
 * data rather than store an empty document. Uses parseHistory so only public
 * day fields survive.
 */
export async function fetchBoardHistory(
  fetchImpl: typeof fetch = fetch,
  options: { throwOnError?: boolean } = {},
): Promise<PublicHistory> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HISTORY_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl("/api/history.json", {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`History request failed: ${response.status}`);
      const body: unknown = await response.json();
      const history = parseHistory(body);
      if (!history) throw new Error("History document is malformed");
      return history;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (options.throwOnError) throw error;
    return emptyHistory(new Date(0).toISOString());
  }
}

/**
 * Days for one service, or [] when the id is missing / history is cold.
 * Never throws: a missing key is an empty strip, not a crash.
 */
export function serviceHistoryDays(history: PublicHistory | null | undefined, serviceId: string): HistoryDay[] {
  if (!history || typeof history.services !== "object" || history.services === null) return [];
  const entry = history.services[serviceId];
  if (!entry || !Array.isArray(entry.days) || entry.days.length === 0) return [];
  return entry.days;
}

export type HistorySlot = {
  date: string;
  day: HistoryDay | null;
};

/**
 * A fixed-length UTC calendar strip ending on `today` (YYYY-MM-DD). Days with
 * no sample stay as empty slots so the strip width is stable.
 */
export function historySlots(
  days: HistoryDay[],
  today: string,
  retentionDays: number = HISTORY_RETENTION_DAYS,
): HistorySlot[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
  const byDate = new Map<string, HistoryDay>();
  for (const day of days) {
    if (typeof day.date === "string") byDate.set(day.date, day);
  }
  const oldest = oldestRetainedDate(today, retentionDays);
  const slots: HistorySlot[] = [];
  const cursor = new Date(`${oldest}T00:00:00.000Z`);
  const end = new Date(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime()) || cursor > end) return [];
  const endTime = end.getTime();
  while (cursor.getTime() <= endTime) {
    const date = cursor.toISOString().slice(0, 10);
    slots.push({ date, day: byDate.get(date) ?? null });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return slots;
}

/** Sample-weighted operational fraction across the days that have samples. */
export function sampleWeightedUptime(days: HistoryDay[]): number | null {
  if (days.length === 0) return null;
  let weighted = 0;
  let samples = 0;
  for (const day of days) {
    if (!Number.isFinite(day.up) || !Number.isFinite(day.samples) || day.samples <= 0) continue;
    weighted += day.up * day.samples;
    samples += day.samples;
  }
  if (samples <= 0) return null;
  return weighted / samples;
}

export function formatUptimePercent(up: number): string {
  const pct = Math.max(0, Math.min(100, up * 100));
  if (pct >= 99.95) return "100%";
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

/** The day with the worst `worst` health in history ranking; ties keep the older day. */
export function worstHistoryDay(days: HistoryDay[]): HistoryDay | null {
  if (days.length === 0) return null;
  let worst: HistoryDay = days[0];
  for (let i = 1; i < days.length; i++) {
    const day = days[i];
    const ranked = worseHistoryHealth(worst.worst, day.worst);
    if (ranked === day.worst && day.worst !== worst.worst) worst = day;
  }
  return worst;
}

const HISTORY_DAY_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

/** A history day (YYYY-MM-DD, UTC) as a short label such as "Sep 26"; the input if unparseable. */
export function formatHistoryDay(date: string): string {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN;
  return Number.isFinite(time) ? HISTORY_DAY_FORMAT.format(time) : date;
}

/** UTC today as YYYY-MM-DD, or null when the clock is unusable. */
export function utcToday(nowMs: number = Date.now()): string | null {
  if (!Number.isFinite(nowMs)) return null;
  return utcDateString(new Date(nowMs).toISOString());
}

/**
 * Screen-reader text for the strip. The "N-day" label is the length of the
 * window the strip draws (`windowDays`), not the number of days that have a
 * record. Built only from public day fields and health labels — never probe text or vendor payloads.
 */
export function historyStripSummary(
  days: HistoryDay[],
  uptime: number | null,
  worst: HistoryDay | null,
  windowDays: number = HISTORY_RETENTION_DAYS,
): string {
  if (days.length === 0) return "";
  const parts: string[] = [`${windowDays}-day uptime history`];
  if (uptime !== null) parts.push(`${formatUptimePercent(uptime)} operational`);
  if (worst && worst.worst !== "operational") {
    parts.push(`worst day ${worst.date}: ${healthLabel(worst.worst)}`);
  }
  return parts.join(". ");
}

/** Short title for one slot; uses only date + public health label. */
export function historySlotTitle(slot: HistorySlot): string {
  if (!slot.day) return `${slot.date}: no samples`;
  return `${slot.day.date}: ${healthLabel(slot.day.worst)}`;
}
