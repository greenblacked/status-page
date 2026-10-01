import type { PulseChange } from "./diff.ts";
import type { Pulse } from "./pulse.ts";

/** How many of the latest checks the list reads back. */
export const RECENT_LIMIT = 8;

/** One line of "Recent changes": what happened at a check (or a run of quiet ones), and the state of the board then. */
export type RecentRow = {
  /** Stable across renders, for a React key: the newest check the row covers. */
  key: number;
  /** The newest check the row covers, as a slot in epoch ms. */
  at: number;
  text: string;
  /** "12 of 15 up", with the names or the reason after it when something changed. */
  caption: string;
  /** How many checks the row stands for; more than one only for a run with no change. */
  checks: number;
  /** Nothing changed at these checks. */
  quiet: boolean;
};

/**
 * One service's change as a sentence: "Steam is now degraded", "Steam is back",
 * "Couldn't read Grok". A release tracker whose newest version moved keeps its
 * own words ("RouterOS: RouterOS 7.21 stable"), since its health did not.
 */
export function describeChange(change: PulseChange): string {
  if (change.from === change.to) return `${change.name}: ${change.summary}`;
  switch (change.to) {
    case "operational":
      return `${change.name} is back`;
    case "degraded":
      return `${change.name} is now degraded`;
    case "outage":
      return `${change.name} is now down`;
    case "maintenance":
      return `${change.name} is now in maintenance`;
    default:
      return `Couldn't read ${change.name}`;
  }
}

/** "12 of 15 up": the services in operation out of all the check counted. */
export function upCaption(counts: Pulse["counts"]): string {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return `${counts.operational} of ${total} up`;
}

function rowFor(pulse: Pulse): RecentRow {
  const base = { key: pulse.slot, at: pulse.slot, checks: 1, quiet: false };
  const up = upCaption(pulse.counts);
  if (pulse.opening) return { ...base, text: "First check", caption: up };
  const [only] = pulse.changes;
  if (pulse.changes.length === 1) {
    const detail = only.from !== only.to && only.summary ? ` · ${only.summary}` : "";
    return { ...base, text: describeChange(only), caption: `${up}${detail}` };
  }
  return {
    ...base,
    text: `${pulse.changes.length} services changed`,
    caption: `${up} · ${pulse.changes.map((change) => change.name).join(", ")}`,
  };
}

/**
 * The last `limit` checks as rows, newest first. A run of checks with nothing
 * changed is one row, "Nothing changed · 6 checks", stamped with the newest of
 * them, so a quiet hour does not push the one change out of the list.
 */
export function recentRows(pulses: Pulse[], limit: number = RECENT_LIMIT): RecentRow[] {
  const rows: RecentRow[] = [];
  for (const pulse of pulses.slice(0, limit)) {
    const quiet = !pulse.opening && pulse.changes.length === 0;
    const last = rows.at(-1);
    if (quiet && last?.quiet) {
      const checks = last.checks + 1;
      rows[rows.length - 1] = { ...last, checks, text: `Nothing changed · ${checks} checks` };
      continue;
    }
    rows.push(
      quiet
        ? {
            key: pulse.slot,
            at: pulse.slot,
            checks: 1,
            quiet,
            text: "Nothing changed",
            caption: upCaption(pulse.counts),
          }
        : rowFor(pulse),
    );
  }
  return rows;
}
