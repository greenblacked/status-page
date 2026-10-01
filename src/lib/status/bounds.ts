import { fingerprint } from "./fingerprint.ts";
import type { ServiceSnapshot } from "./types.ts";

/**
 * Longest text a snapshot may carry, per kind. A vendor payload is bounded
 * only by the 4 MiB body cap, and these strings go on into the server-rendered
 * page, /api/status.json, /feed.xml, notifications and localStorage, so a
 * single runaway title would be copied into all of them. Real vendor text is
 * a fraction of these: they are ceilings, not targets.
 */
export const MAX_NAME_CHARS = 120;
export const MAX_TITLE_CHARS = 300;
export const MAX_TEXT_CHARS = 500;
export const MAX_ID_CHARS = 200;
export const MAX_URL_CHARS = 2000;

// Meta values that hold a title (the newest release's headline); the rest of
// meta (version maps, counters) gets the general text limit.
const TITLE_LIKE_META = new Set(["latest"]);

/**
 * `text` cut to at most `max` characters (UTF-16 units, the unit of
 * `String.length`), the last of them "…" when anything was cut. The cut never
 * lands inside a surrogate pair, so an emoji at the boundary is dropped whole
 * instead of leaving half of it behind.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * An id within MAX_ID_CHARS. A longer one keeps its start and ends in a
 * fingerprint of the whole, so two long ids that share a start stay different
 * and the same one is the same on every sweep (the feed's entry ids and the
 * board's diffing key on it).
 */
export function boundId(id: string): string {
  if (id.length <= MAX_ID_CHARS) return id;
  const suffix = `~${fingerprint(id)}`;
  let end = MAX_ID_CHARS - suffix.length;
  const last = id.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${id.slice(0, end)}${suffix}`;
}

// A link that is too long is dropped, not cut: half a URL points nowhere.
function boundUrl(url: string | undefined): string | undefined {
  return typeof url === "string" && url.length > MAX_URL_CHARS ? undefined : url;
}

// Vendor payloads are not validated, so a field the types say is text can
// be some other type; only strings are cut.
function bound<T>(value: T, max: number): T {
  return typeof value === "string" ? (clip(value, max) as T) : value;
}

// Ids are built from vendor text, so they may not be text at all.
function boundIdOf<T>(id: T): T {
  return typeof id === "string" ? (boundId(id) as T) : id;
}

function boundMeta(meta: Record<string, string | number>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => [
      key,
      bound(value, TITLE_LIKE_META.has(key) ? MAX_TITLE_CHARS : MAX_TEXT_CHARS),
    ]),
  );
}

// A collector often sets the summary to the worst incident's title. The board
// matches the two by text to print that incident once, so a summary that is an
// incident's title must be cut exactly as the title is: held to the longer
// summary limit it would no longer equal the clipped title, and the incident
// would be listed a second time under it. The comparison is the board's own
// (trimmed, case-folded); a match takes the clipped title itself, which also
// settles whitespace at the cut.
function boundSummary(snapshot: ServiceSnapshot): string {
  const { summary } = snapshot;
  if (typeof summary !== "string") return summary;
  const wanted = summary.trim().toLowerCase();
  const match = snapshot.incidents.find(
    (incident) => typeof incident.title === "string" && incident.title.trim().toLowerCase() === wanted,
  );
  if (match && match.title.length > MAX_TITLE_CHARS) return clip(match.title, MAX_TITLE_CHARS);
  return clip(summary, MAX_TEXT_CHARS);
}

/** The snapshot with every vendor-sourced string held to its limit. */
export function boundSnapshot(snapshot: ServiceSnapshot): ServiceSnapshot {
  return {
    ...snapshot,
    summary: boundSummary(snapshot),
    components: snapshot.components.map((component) => {
      const next = { ...component, name: bound(component.name, MAX_NAME_CHARS) };
      if (component.detail !== undefined) next.detail = bound(component.detail, MAX_TEXT_CHARS);
      return next;
    }),
    incidents: snapshot.incidents.map((incident) => {
      const next = { ...incident, id: boundIdOf(incident.id), title: bound(incident.title, MAX_TITLE_CHARS) };
      if (incident.url !== undefined) next.url = boundUrl(incident.url);
      return next;
    }),
    ...(snapshot.upcomingMaintenance
      ? {
          upcomingMaintenance: snapshot.upcomingMaintenance.map((item) => {
            const next = { ...item, id: boundIdOf(item.id), title: bound(item.title, MAX_TITLE_CHARS) };
            if (item.url !== undefined) next.url = boundUrl(item.url);
            return next;
          }),
        }
      : {}),
    ...(snapshot.meta ? { meta: boundMeta(snapshot.meta) } : {}),
    ...(snapshot.failure
      ? { failure: { ...snapshot.failure, message: bound(snapshot.failure.message, MAX_TEXT_CHARS) } }
      : {}),
  };
}
