import { urgencyOf } from "./health.ts";
import type { BoardSnapshot, Health, Incident, ServiceSnapshot } from "./types.ts";
import { verdict } from "./verdict.ts";

// Severity is the one order in health.ts (SEVERITY_ORDER), so the cards, the
// headline, the overall health and a history day's worst state never disagree.

/** When a service's most recently started incident began, as epoch ms; -Infinity if none has a readable start. */
function latestIncidentStart(service: ServiceSnapshot): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const incident of service.incidents) {
    const at = incident.startedAt ? Date.parse(incident.startedAt) : Number.NaN;
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}

/** Newer first; two services with no readable start tie (subtracting two -Infinity values would be NaN). */
function newerFirst(a: number, b: number): number {
  if (a === b) return 0;
  return b > a ? 1 : -1;
}

/**
 * Services by urgency: severity first (outage, degraded, unknown,
 * maintenance, operational), then the most recently started incident. Anything
 * still tied keeps the order it came in (a stable sort): catalog order, with
 * starred services first, as the board passes them. A pure sort of a copy,
 * run on every snapshot, so the first entry is always the current most
 * urgent service.
 */
export function sortByUrgency(services: ServiceSnapshot[]): ServiceSnapshot[] {
  return [...services].sort(
    (a, b) => urgencyOf(a.health) - urgencyOf(b.health) || newerFirst(latestIncidentStart(a), latestIncidentStart(b)),
  );
}

/** When an incident began (else last changed), as epoch ms; -Infinity if neither is readable. */
function incidentTime(incident: Incident): number {
  for (const text of [incident.startedAt, incident.updatedAt]) {
    const at = text ? Date.parse(text) : Number.NaN;
    if (Number.isFinite(at)) return at;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * A service's incidents by urgency: real problems before informational
 * notices, then severity (`SEVERITY_ORDER`), then the most recently started
 * first. Ties keep the vendor's order (a stable sort). Collectors sort
 * before they derive a summary or a health, and the card slices the front of
 * the list, so the first entry is always the worst current incident.
 */
export function sortIncidents(incidents: Incident[]): Incident[] {
  return [...incidents].sort(
    (a, b) =>
      Number(a.informational === true) - Number(b.informational === true) ||
      urgencyOf(a.health) - urgencyOf(b.health) ||
      newerFirst(incidentTime(a), incidentTime(b)),
  );
}

/** Same page: scheme, host, path (minus a trailing slash) and query match; a fragment does not count. */
function samePage(a: string, b: string): boolean {
  try {
    const first = new URL(a);
    const second = new URL(b);
    // Not `replace(/\/+$/, "")`: that rescans a run of slashes from every
    // position in it, which is quadratic on a hostile path.
    const path = (url: URL) => {
      let end = url.pathname.length;
      while (end > 0 && url.pathname[end - 1] === "/") end -= 1;
      return url.pathname.slice(0, end);
    };
    return first.origin === second.origin && path(first) === path(second) && first.search === second.search;
  } catch {
    return a === b;
  }
}

/**
 * The link to the worst incident that has a page of its own, or undefined.
 * A vendor whose incidents all point at its generic dashboard (AWS's
 * Health Dashboard, Apple's System Status) has no incident page: that URL is
 * the card's source link, so it is not offered as "View incident".
 */
export function incidentLink(service: ServiceSnapshot): string | undefined {
  return sortIncidents(service.incidents).find((incident) => incident.url && !samePage(incident.url, service.sourceUrl))
    ?.url;
}

export type BoardGroups = {
  /**
   * Something a person should open: outage, degraded or maintenance, most
   * urgent first (see `sortByUrgency`). Its first outage or degraded entry is the board's highlight.
   */
  attention: ServiceSnapshot[];
  /**
   * Sources that could not be read (health unknown). That says nothing about
   * the vendor, so they never sit among the problems, are never counted as
   * "issues" and never win the highlight.
   */
  unread: ServiceSnapshot[];
  /** Operational status services. */
  operational: ServiceSnapshot[];
  /** Operational release trackers (the Releases category). */
  releases: ServiceSnapshot[];
};

export function groupServices(services: ServiceSnapshot[]): BoardGroups {
  const attention = sortByUrgency(
    services.filter((service) => service.health !== "operational" && service.health !== "unknown"),
  );
  const unread = services.filter((service) => service.health === "unknown");
  const healthy = services.filter((service) => service.health === "operational");
  return {
    attention,
    unread,
    operational: healthy.filter((service) => service.category !== "updates"),
    releases: healthy.filter((service) => service.category === "updates"),
  };
}

export function serviceAnchor(id: ServiceSnapshot["id"]): string {
  return `service-${id}`;
}

/**
 * The one sentence at the top of the board, and the tone of the mark beside it
 * (`verdict`, which owns the wording). Kept here because the JSON API and the
 * floating bar read it as a headline.
 */
export function boardHeadline(board: BoardSnapshot): { tone: Health; title: string } {
  const { tone, title } = verdict(board);
  return { tone, title };
}

/**
 * Browser tab title: how many services are down or degraded, if any. Only
 * confirmed trouble counts; a source that could not be read, and planned
 * maintenance, do not put a number in the tab.
 */
export function documentTitle(board: BoardSnapshot, appName: string): string {
  const trouble = board.services.filter(
    (service) => service.health === "outage" || service.health === "degraded",
  ).length;
  return trouble ? `(${trouble}) ${appName}` : appName;
}

/**
 * Whether focus arrived the way :focus-visible marks it, by keyboard
 * rather than a click. A browser without :focus-visible throws on the
 * selector; focus then counts as keyboard focus, the safe side for a
 * keyboard user.
 */
export function keyboardFocus(target: unknown): boolean {
  if (typeof target !== "object" || target === null || !("matches" in target)) return false;
  const { matches } = target as { matches: unknown };
  if (typeof matches !== "function") return false;
  try {
    return matches.call(target, ":focus-visible") === true;
  } catch {
    return true;
  }
}

/**
 * How far the search field has travelled into the bar, 0 to 1, from the page's
 * scroll position. It starts to move at `start` and arrives `range` pixels of
 * scrolling later. Clamped, so an overscroll bounce at either end never moves
 * it past its two poses.
 */
export function dockProgress(scrollY: number, start: number, range: number): number {
  const linear = Math.min(1, Math.max(0, (scrollY - start) / range));
  return linear * linear * (3 - 2 * linear);
}

/**
 * Whether the floating bar is up at `scrollY`: from `start` on, and once up it
 * stays until the page is `hysteresis` px above that, so a finger hovering at
 * the threshold cannot flicker it.
 */
export function barShownAt(scrollY: number, start: number, shown: boolean, hysteresis = 8): boolean {
  return scrollY >= (shown ? start - hysteresis : start);
}
