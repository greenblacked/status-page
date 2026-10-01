import { type PulseChange, releaseChange } from "./diff.ts";
import type { BoardSnapshot, Health, ServiceId } from "./types.ts";

export type AlertMessage = { title: string; body: string; tag: string };

/** One sentence shape for a state a service moved into: "Grok is degraded", "Steam is down". */
function alertTitle(name: string, to: Health): string {
  switch (to) {
    case "degraded":
      return `${name} is degraded`;
    case "outage":
      return `${name} is down`;
    case "maintenance":
      return `${name} is in maintenance`;
    case "unknown":
      return `Couldn't read ${name}`;
    default:
      return `${name} is back`;
  }
}

/**
 * The browser notification for one change between two boards. `tag` is the
 * service id, so a newer alert for the same service replaces the older one
 * instead of stacking.
 */
export function alertFor(change: PulseChange): AlertMessage {
  const title =
    change.from === change.to
      ? `New release: ${change.name}`
      : change.to === "operational"
        ? `${change.name} is back`
        : alertTitle(change.name, change.to);
  return { title, body: change.summary, tag: `status-bar:${change.id}` };
}

/** How many consecutive board updates a change to or from Unknown must hold before it raises an alert. */
export const UNKNOWN_CONFIRMATIONS = 2;

/**
 * What the alert filter remembers between board updates. `settled` is the
 * health each service was last alerted about (or first seen at); `pending` is
 * a change to or from Unknown that has been seen but not yet confirmed.
 */
export type AlertDebounce = {
  settled: Partial<Record<ServiceId, Health>>;
  pending: Partial<Record<ServiceId, { to: Health; seen: number }>>;
};

export function emptyAlertDebounce(): AlertDebounce {
  return { settled: {}, pending: {} };
}

/**
 * The changes between two consecutive boards that deserve a browser alert.
 *
 * A real outage, degradation, maintenance or recovery alerts at once. A
 * change to or from Unknown does not: an unreadable source is very often a
 * single failed request, so it only alerts once the same change has held for
 * `UNKNOWN_CONFIRMATIONS` consecutive updates. A blip (outage, unknown, then
 * outage again) never alerts at all, because the service is back at the
 * state it was last alerted about. `from` is that last alerted state, so the
 * message never speaks of a state nobody was told about.
 *
 * Pure: returns the next `AlertDebounce` instead of keeping any. Feed it every
 * board update, including those it will not alert for, so the counts are of
 * consecutive updates.
 */
export function alertChanges(
  state: AlertDebounce,
  before: BoardSnapshot,
  next: BoardSnapshot,
): { changes: PulseChange[]; state: AlertDebounce } {
  const settled = { ...state.settled };
  const pending = { ...state.pending };
  const previousById = new Map(before.services.map((service) => [service.id, service]));
  const changes: PulseChange[] = [];
  for (const service of next.services) {
    const previous = previousById.get(service.id);
    if (!previous) continue;
    const base = settled[service.id] ?? previous.health;
    const release = releaseChange(previous, service);
    const at = (from: Health, to: Health, summary: string): PulseChange => ({
      id: service.id,
      name: service.name,
      from,
      to,
      summary,
    });
    if (service.health === base) {
      delete pending[service.id];
      settled[service.id] = base;
      if (release) changes.push(at(base, base, release));
      continue;
    }
    const involvesUnknown = base === "unknown" || service.health === "unknown";
    const held = pending[service.id];
    const seen = involvesUnknown ? (held?.to === service.health ? held.seen + 1 : 1) : UNKNOWN_CONFIRMATIONS;
    if (seen >= UNKNOWN_CONFIRMATIONS) {
      changes.push(at(base, service.health, release || service.summary));
      settled[service.id] = service.health;
      delete pending[service.id];
    } else {
      pending[service.id] = { to: service.health, seen };
      settled[service.id] = base;
      if (release) changes.push(at(base, base, release));
    }
  }
  return { changes, state: { settled, pending } };
}
