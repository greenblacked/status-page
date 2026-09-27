import { CATEGORIES } from "./catalog.ts";
import type { CategoryId, ServiceId, ServiceSnapshot } from "./types.ts";

/** What the board's search box and filter buttons are set to. */
export type BoardFilters = {
  query: string;
  category: "all" | CategoryId;
  issuesOnly: boolean;
  starredOnly: boolean;
};

export const DEFAULT_FILTERS: BoardFilters = { query: "", category: "all", issuesOnly: false, starredOnly: false };

/**
 * The same filters as URL search params, so a filtered board can be
 * bookmarked or pasted into a chat: `/?q=gcp&category=cloud&issues=true&starred=true`.
 * A filter at its default is left out, which keeps the plain board at `/`.
 */
export type BoardSearch = {
  q?: string;
  category?: CategoryId;
  issues?: true;
  starred?: true;
};

const CATEGORY_IDS = new Set<string>(CATEGORIES.map((category) => category.id));

function isCategory(value: unknown): value is CategoryId {
  return typeof value === "string" && CATEGORY_IDS.has(value);
}

/**
 * The route's `validateSearch`: keeps what it understands and drops the
 * rest, so a hand-edited or stale link opens the board instead of an error.
 */
export function parseBoardSearch(raw: Record<string, unknown>): BoardSearch {
  const search: BoardSearch = {};
  // The router parses `?q=123` as a number; a search for it is still text.
  const q = typeof raw.q === "number" ? String(raw.q) : raw.q;
  if (typeof q === "string" && q.trim()) search.q = q.slice(0, 100);
  if (isCategory(raw.category)) search.category = raw.category;
  if (raw.issues === true || raw.issues === "true") search.issues = true;
  if (raw.starred === true || raw.starred === "true") search.starred = true;
  return search;
}

export function filtersFromSearch(search: BoardSearch): BoardFilters {
  return {
    query: search.q ?? "",
    category: search.category ?? "all",
    issuesOnly: search.issues === true,
    starredOnly: search.starred === true,
  };
}

export function searchFromFilters(filters: BoardFilters): BoardSearch {
  const search: BoardSearch = {};
  if (filters.query.trim()) search.q = filters.query;
  if (filters.category !== "all") search.category = filters.category;
  if (filters.issuesOnly) search.issues = true;
  if (filters.starredOnly) search.starred = true;
  return search;
}

/** `starred` is this browser's stars; a shared `starred=true` link shows the opener's own. */
export function matchesFilters(
  service: ServiceSnapshot,
  filters: BoardFilters,
  starred: ReadonlySet<ServiceId> = new Set(),
): boolean {
  if (filters.category !== "all" && service.category !== filters.category) return false;
  if (filters.issuesOnly && service.health === "operational") return false;
  if (filters.starredOnly && !starred.has(service.id)) return false;
  const needle = filters.query.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${service.name} ${service.shortName} ${service.summary} ${service.category}`.toLowerCase();
  return hay.includes(needle);
}

/** What the board says in place of cards when the filters leave none. */
export function emptyBoardMessage(filters: BoardFilters, starredCount: number): string {
  return filters.starredOnly && starredCount === 0
    ? "No starred services yet. Star a card to keep it here and at the top of the board."
    : "No services match that filter.";
}

/**
 * What the board's polite live region says once the filters settle, so a
 * screen reader user hears what a filter or search left on the board. An
 * empty board adds why in the same sentence: the empty-state paragraph is
 * not a live region of its own, which made two announcements race.
 */
export function resultsAnnouncement(shown: number, total: number, emptyMessage: string): string {
  const count = `${shown} of ${total} ${total === 1 ? "service" : "services"} shown`;
  return shown === 0 ? `${count}. ${emptyMessage}` : count;
}

/**
 * The filters that put `service` on the board, or null when it is already
 * there. The summary's attention chips link to cards, and a filtered board
 * has not rendered every card, so a chip for a hidden one clears the filters
 * before it jumps.
 */
export function filtersToReveal(
  service: ServiceSnapshot,
  filters: BoardFilters,
  starred: ReadonlySet<ServiceId> = new Set(),
): BoardFilters | null {
  return matchesFilters(service, filters, starred) ? null : DEFAULT_FILTERS;
}
