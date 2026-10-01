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

// Vendor payloads are not validated, so a field the types say is text can
// be some other type; only strings are cut.
function bound<T>(value: T, max: number): T {
  return typeof value === "string" ? (clip(value, max) as T) : value;
}

/** The snapshot with every vendor-sourced string held to its limit. */
export function boundSnapshot(snapshot: ServiceSnapshot): ServiceSnapshot {
  return {
    ...snapshot,
    summary: bound(snapshot.summary, MAX_TEXT_CHARS),
    components: snapshot.components.map((component) => {
      const next = { ...component, name: bound(component.name, MAX_NAME_CHARS) };
      if (component.detail !== undefined) next.detail = bound(component.detail, MAX_TEXT_CHARS);
      return next;
    }),
    incidents: snapshot.incidents.map((incident) => ({ ...incident, title: bound(incident.title, MAX_TITLE_CHARS) })),
    ...(snapshot.upcomingMaintenance
      ? {
          upcomingMaintenance: snapshot.upcomingMaintenance.map((item) => ({
            ...item,
            title: bound(item.title, MAX_TITLE_CHARS),
          })),
        }
      : {}),
    ...(snapshot.failure
      ? { failure: { ...snapshot.failure, message: bound(snapshot.failure.message, MAX_TEXT_CHARS) } }
      : {}),
  };
}
