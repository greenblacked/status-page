export const CACHE_TTL_MS = 45_000;
// A page load may be served a snapshot up to this long past the TTL while a
// fresh one is collected behind it, so the first visitor after a quiet spell
// does not wait on the slowest vendor. The board then refetches at once.
export const CACHE_MAX_STALE_MS = 75_000;
// Refresh inside this window reuses the last snapshot instead of sweeping
// every vendor again.
export const MIN_FORCED_REFRESH_MS = 15_000;
export const PULSE_INTERVAL_MS = 2 * 60 * 1000;
export const MAX_PULSES = 60;

export function lastPulseAt(now = Date.now()): number {
  return Math.floor(now / PULSE_INTERVAL_MS) * PULSE_INTERVAL_MS;
}

export function nextPulseAt(now = Date.now()): number {
  return lastPulseAt(now) + PULSE_INTERVAL_MS;
}

// The board refetches this long after each two-minute slot rather than on
// it: on Workers the cron writes the slot's snapshot a few seconds in, and
// a spread keeps every open tab from asking in the same second. Each page
// load picks one value and keeps it.
export const REFETCH_JITTER_MIN_MS = 5_000;
export const REFETCH_JITTER_MAX_MS = 20_000;

export function pickRefetchJitter(random: () => number = Math.random): number {
  return REFETCH_JITTER_MIN_MS + Math.floor(random() * (REFETCH_JITTER_MAX_MS - REFETCH_JITTER_MIN_MS));
}

/**
 * When the board next refetches: `jitterMs` past a slot, strictly after
 * `now`. The query schedules itself by this and the countdown counts down
 * to it, so "Next update 0:00" is the moment a fetch starts.
 */
export function nextRefetchAt(now: number, jitterMs: number): number {
  const candidate = lastPulseAt(now) + jitterMs;
  return candidate > now ? candidate : candidate + PULSE_INTERVAL_MS;
}

export function pulseProgress(now = Date.now()): number {
  const elapsed = now - lastPulseAt(now);
  return Math.min(1, Math.max(0, elapsed / PULSE_INTERVAL_MS));
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// The board refetches every slot, so a snapshot older than three of them
// has stopped moving: the server, its collector or this tab's network is
// stuck, and "Live" would be a claim the board cannot back.
export const STALE_AFTER_MS = 3 * PULSE_INTERVAL_MS;

/** False until mounted (`now` 0). A timestamp that cannot be read cannot be vouched for. */
export function isStale(generatedAt: string, now: number): boolean {
  if (now <= 0) return false;
  const at = parseTimestamp(generatedAt);
  return at === null || now - at > STALE_AFTER_MS;
}

/** An age in words a screen reader reads well: "7 min ago", "2 hours ago". */
export function formatStaleAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function formatSlotTime(slot: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(slot));
}

/** A vendor timestamp in ms, or null when it is missing or unreadable. */
export function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  // Vendor timestamps are not always parseable (see integrations.ts).
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => n.toString().padStart(2, "0");

/**
 * A moment as UTC clock time, "14:05 UTC", with the date first when it is
 * not on the same UTC day as `reference`: "26 Sep 14:05 UTC", and the year
 * too when that differs. Neither the browser's clock nor its locale enters
 * into it, so the server and the client render the same text.
 */
export function formatUtcTime(at: number, reference: number = at): string {
  const date = new Date(at);
  const ref = new Date(reference);
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  const sameDay =
    date.getUTCFullYear() === ref.getUTCFullYear() &&
    date.getUTCMonth() === ref.getUTCMonth() &&
    date.getUTCDate() === ref.getUTCDate();
  if (sameDay) return clock;
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return date.getUTCFullYear() === ref.getUTCFullYear()
    ? `${day} ${clock}`
    : `${day} ${date.getUTCFullYear()} ${clock}`;
}

export type Duration = {
  /** "2h 10m", for the eye. */
  short: string;
  /** "2 hours 10 minutes", for a screen reader. */
  long: string;
  /** "PT2H10M", for a <time dateTime>. */
  iso: string;
};

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** How long something has lasted, to the minute. Negative spans count as none. */
export function formatDuration(ms: number): Duration {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const iso = `PT${hours}H${minutes % 60}M`;
  if (minutes < 1) return { short: "under 1m", long: "under a minute", iso };
  if (hours < 1) return { short: `${minutes}m`, long: plural(minutes, "minute"), iso };
  if (days < 1) {
    const rest = minutes % 60;
    return rest
      ? { short: `${hours}h ${rest}m`, long: `${plural(hours, "hour")} ${plural(rest, "minute")}`, iso }
      : { short: `${hours}h`, long: plural(hours, "hour"), iso };
  }
  const rest = hours % 24;
  return rest
    ? { short: `${days}d ${rest}h`, long: `${plural(days, "day")} ${plural(rest, "hour")}`, iso }
    : { short: `${days}d`, long: plural(days, "day"), iso };
}
