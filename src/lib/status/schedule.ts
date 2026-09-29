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
// it: a spread keeps open tabs from asking the Worker at the same second.
// Each isolate caches its own collection for 45 seconds; a slow vendor
// may cause a tab to see a new snapshot on its next refetch.
export const REFETCH_JITTER_MIN_MS = 15_000;
export const REFETCH_JITTER_MAX_MS = 30_000;

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

/** Where the board stands in the period that ends at its next refetch. */
export type PeriodPhase = {
  /** The next refetch, as `nextRefetchAt` gives it: unique to this period. */
  endsAt: number;
  /** How far into the period, in ms, rounded down to `stepMs` when given. */
  elapsedMs: number;
  /** `elapsedMs` as a share of the period, from 0 up to (not reaching) 1. */
  progress: number;
};

/**
 * The period the countdown counts down: the same end, the same jitter, so
 * the period dial and "Next update" never disagree. A `stepMs` coarsens it,
 * for a dial that must not move more often than that.
 */
export function periodPhase(now: number, jitterMs: number, stepMs = 0): PeriodPhase {
  const endsAt = nextRefetchAt(now, jitterMs);
  const exact = PULSE_INTERVAL_MS - (endsAt - now);
  const elapsedMs = stepMs > 0 ? Math.floor(exact / stepMs) * stepMs : exact;
  return { endsAt, elapsedMs, progress: Math.min(1, Math.max(0, elapsedMs / PULSE_INTERVAL_MS)) };
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

// The board refetches every slot, so a snapshot that has not moved for
// three of them has stopped: the server, its collector or this tab's
// network is stuck, and "Live" would be a claim the board cannot back.
export const STALE_AFTER_MS = 3 * PULSE_INTERVAL_MS;

/**
 * The snapshot on screen and when, by this browser's clock, the board first
 * showed it. Staleness is timed from here rather than from `generatedAt`:
 * that is the server's clock, and a browser whose clock ran seven minutes
 * ahead called every snapshot stale the moment it arrived.
 */
export type SnapshotSeen = { generatedAt: string; seenAt: number };

/**
 * A snapshot this old by the server's own timestamp, on the page's first
 * sight of it, is stale whatever the browser's clock says: no real clock
 * skew comes near half an hour, and without this a board that stopped
 * hours ago would read "Live" for its first six minutes on screen.
 */
export const STALE_ON_ARRIVAL_MS = 30 * 60_000;

/**
 * `previous`, or a new record when `generatedAt` has moved on. Only a newer
 * snapshot counts: an older one, from a cache that lags, is no sign of life.
 * Nothing is recorded before mount (`now` 0).
 */
export function noteSnapshot(previous: SnapshotSeen | null, generatedAt: string, now: number): SnapshotSeen | null {
  if (now <= 0) return previous;
  if (!previous) {
    const at = parseTimestamp(generatedAt);
    // Timed from the server's clock only when the gap dwarfs any skew.
    const arrivedStale = at !== null && now - at > STALE_ON_ARRIVAL_MS;
    return { generatedAt, seenAt: arrivedStale ? at : now };
  }
  if (previous.generatedAt === generatedAt) return previous;
  // Both timestamps come from the server, so comparing them is safe.
  const before = parseTimestamp(previous.generatedAt);
  const after = parseTimestamp(generatedAt);
  if (before !== null && after !== null && after <= before) return previous;
  return { generatedAt, seenAt: now };
}

/** Whether the snapshot first seen at `seenAt` has sat unchanged too long. False until mounted. */
export function isStale(seenAt: number, now: number): boolean {
  if (now <= 0 || seenAt <= 0) return false;
  return now - seenAt > STALE_AFTER_MS;
}

/**
 * What the live signal shows: a check running, a board that has stopped
 * updating, or a live one. Checking wins, since it may yet bring a fresh
 * snapshot, which is also why the board is not called stale while it runs.
 */
export type LiveState = "checking" | "stale" | "live";

export function liveState(fetching: boolean, stale: boolean): LiveState {
  if (fetching) return "checking";
  return stale ? "stale" : "live";
}

/** How fresh the board on screen is, shared by the live bar and the live signals. */
export type Freshness = {
  /** Timed by this browser's clock, from when it first showed this snapshot. */
  ageMs: number;
  stale: boolean;
  state: LiveState;
};

/**
 * The freshness of the snapshot this browser first showed at `seen`. A
 * check in flight may yet bring it back, so it is not called stale while
 * one runs.
 */
export function freshnessOf(seen: SnapshotSeen | null, fetching: boolean, now: number): Freshness {
  const seenAt = seen?.seenAt ?? 0;
  const stale = !fetching && isStale(seenAt, now);
  return { ageMs: now - seenAt, stale, state: liveState(fetching, stale) };
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
  // UTC like every other time on the board, and the same text on the server
  // and in the browser, so the log never disagrees with itself on hydration.
  return formatUtcTime(slot);
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

/**
 * How long something has lasted, to the minute. Null for a negative span:
 * something that has not started has lasted no time at all, not "under 1m".
 */
export function formatDuration(ms: number): Duration | null {
  if (!(ms >= 0)) return null;
  const minutes = Math.floor(ms / 60_000);
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

export type IncidentStart = { upcoming: boolean; duration: Duration | null };

/**
 * How a card words an incident's start. Vendors list planned maintenance
 * with a start still ahead (Apple's upcoming events), which read as "since
 * 22:00 UTC · under 1m" at 14:00. A start after now is `upcoming` and has
 * no duration. Before mount (`now` 0) the snapshot's check time stands in
 * for now and there is no duration, so the server and the first client
 * render agree.
 */
export function incidentStart(at: number, now: number, checkedAt: number): IncidentStart {
  if (now <= 0) return { upcoming: at > checkedAt, duration: null };
  return at > now ? { upcoming: true, duration: null } : { upcoming: false, duration: formatDuration(now - at) };
}
