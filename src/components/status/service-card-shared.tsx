import { Star } from "lucide-react";
import { LocalTime } from "@/components/status/local-time";
import { STATUS_TEXT, StatusGlyph } from "@/components/status/status-glyph";
import { CATALOG } from "@/lib/status/catalog";
import { healthLabel } from "@/lib/status/health";
import { incidentStart, parseTimestamp } from "@/lib/status/schedule";
import type { ComponentHealth, Health, ServiceId, ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

export const norm = (text: string) => text.trim().toLowerCase();

/** What every card and row takes: the service, and the board's view of it. */
export type ServiceCardProps = {
  service: ServiceSnapshot;
  /** Ignored: kept so a caller that still passes its position compiles. */
  index?: number;
  /**
   * The board's most urgent service. It carries `data-highlight` (and only while it is in outage or
   * degraded), with no visual: the card stays the one <article>, never a wrapper, so a card that gains
   * or loses it keeps its DOM node and the keyboard focus inside it.
   */
  highlight?: boolean;
  /** The service changed in the latest check: a "Changed" tag and an accent bar. */
  emphasized?: boolean;
  starred: boolean;
  onToggleStar: (id: ServiceSnapshot["id"]) => void;
  /** The client clock (0 until mounted), for how long an incident has run. */
  now: number;
};

/**
 * The word beside a status glyph. `healthLabel` says "No data" for a source that
 * could not be read once the copy pass lands; until then this keeps the board
 * from calling an unread source "Unknown".
 */
export function stateWord(health: Health): string {
  return health === "unknown" ? "No data" : healthLabel(health);
}

/**
 * A status as a coloured word, weighted by how much it asks of a person: what
 * is fine is light and quiet (text-subtle, 450), what is wrong is semibold in
 * its own colour. The glyph beside it is aria-hidden, so this word is the
 * status for a screen reader.
 */
export function StateWord({ health, className }: { health: Health; className?: string }) {
  return (
    <span
      className={cn(
        health === "operational" ? "font-[450] text-subtle" : STATUS_TEXT[health],
        health === "degraded" || health === "outage" || health === "maintenance" ? "font-semibold" : "font-[450]",
        className,
      )}
    >
      {stateWord(health)}
    </span>
  );
}

/** Which of the pen's three hands a service's loop takes: by its place in the catalog, so it never changes between checks. */
export function penSeed(id: ServiceId): 0 | 1 | 2 {
  const at = CATALOG.findIndex((entry) => entry.id === id);
  return (at < 0 ? 0 : at % 3) as 0 | 1 | 2;
}

/** The host of a source page, "steamstat.us", for a link that says where it goes; the whole name if the URL is unreadable. */
export function hostOf(url: string, fallback: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return fallback;
  }
}

/**
 * When an incident began, as "since 14:05 UTC (2h 10m)", and after hydration
 * the time in the viewer's own zone and how long it has run. A start still
 * ahead, such as planned maintenance, reads "scheduled for 22:00 UTC"
 * instead. The start is the same text on the server and in the first client
 * render (LocalTime); the duration needs the visitor's clock, so it waits for
 * `now`.
 *
 * With `scheduled`, the item is one the vendor still reports as not started
 * (upcoming maintenance). It never reads "since" or shows a running
 * duration, which would contradict its label: once the time has passed it
 * reads "was due 22:00 UTC".
 *
 * `lineStart` is for a line of its own, where the sentence begins with a
 * capital: "Since 14:05 UTC", "Scheduled for 22:00 UTC", "Was due 22:00 UTC".
 */
export function IncidentSince({
  startedAt,
  reference,
  now,
  scheduled = false,
  lineStart = false,
  className,
}: {
  startedAt: string | undefined;
  /** When the card was checked; a start on another day shows its date. */
  reference: number;
  now: number;
  /** The vendor has not started this yet: no "since", no running duration. */
  scheduled?: boolean;
  /** The line begins with this text, so it starts with a capital. */
  lineStart?: boolean;
  className?: string;
}) {
  const at = parseTimestamp(startedAt);
  if (at === null) return null;
  const { upcoming, duration } = incidentStart(at, now, reference);
  const lead = upcoming ? "scheduled for " : scheduled ? "was due " : "since ";
  return (
    <span className={cn("text-subtle", className)}>
      {lineStart ? `${lead.charAt(0).toUpperCase()}${lead.slice(1)}` : lead}
      <LocalTime at={at} reference={Number.isFinite(reference) ? reference : at} />
      {duration && !scheduled ? (
        <>
          {" "}
          <span className="whitespace-nowrap tabular-nums">
            (
            <time dateTime={duration.iso}>
              <span aria-hidden>{duration.short}</span>
              <span className="sr-only">{duration.long}</span>
            </time>
            )
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * One component of a service that needs a look: its name, what the vendor
 * says about it (a footnote), and its status as a coloured word. A component
 * that is fine says nothing; a release channel that is fresh says "New".
 */
export function ComponentRow({
  component,
  changelog,
  showDetail,
}: {
  component: ComponentHealth;
  changelog: boolean;
  showDetail: boolean;
}) {
  const word = changelog ? (
    component.health === "maintenance" ? (
      <span className="font-semibold text-fg">New</span>
    ) : null
  ) : component.health !== "operational" ? (
    <StateWord health={component.health} />
  ) : null;

  return (
    <li
      data-component-row
      className="inset grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 rounded-md px-3 py-2"
    >
      {/* The name wraps rather than truncates: it is what the row is about. */}
      <span className="min-w-0 text-caption text-fg [overflow-wrap:anywhere]" title={component.name}>
        {component.name}
      </span>
      {word ? <span className="col-start-2 row-start-1 text-caption">{word}</span> : null}
      {showDetail ? (
        <span
          className="col-span-2 line-clamp-2 min-w-0 text-footnote text-subtle [overflow-wrap:anywhere]"
          title={component.detail}
        >
          {component.detail}
        </span>
      ) : null}
    </li>
  );
}

/** How many component names a healthy row names before it says "+N more". */
export const HEALTHY_COMPONENTS_SHOWN = 6;

/**
 * The components of a service with nothing to report, as a short list under
 * its row: a small status glyph for the eye, the status in words for a screen
 * reader. Anything past the first few is counted, not dropped silently.
 * Renders nothing when the vendor lists no components, since there is nothing
 * true to say.
 */
export function HealthyComponents({
  components,
  total = components.length,
  className,
}: {
  components: ComponentHealth[];
  /** The vendor's true component count, when the snapshot kept fewer than it lists. */
  total?: number;
  className?: string;
}) {
  if (components.length === 0) return null;
  // A stray non-operational component still leads the list.
  const ordered = [...components].sort(
    (a, b) => Number(a.health === "operational") - Number(b.health === "operational"),
  );
  const shown = ordered.slice(0, HEALTHY_COMPONENTS_SHOWN);
  const more = Math.max(total, ordered.length) - shown.length;
  return (
    <ul aria-label="Components" className={cn("flex flex-col gap-1.5", className)}>
      {shown.map((component, componentIndex) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: a vendor can list two components with one name; the index only breaks that tie.
          key={`${component.name}-${componentIndex}`}
          className="flex max-w-full min-w-0 items-baseline gap-2 text-caption text-muted"
        >
          <StatusGlyph
            health={component.health}
            size={14}
            className={cn("self-center", STATUS_TEXT[component.health])}
          />
          <span className="[overflow-wrap:anywhere]" title={component.name}>
            {component.name}
          </span>
          {component.detail ? <span className="text-footnote text-subtle">{component.detail}</span> : null}
          <span className="sr-only">{stateWord(component.health)}</span>
        </li>
      ))}
      {more > 0 ? (
        <li className="text-footnote text-subtle" data-more-components>
          <span aria-hidden>+{more} more</span>
          <span className="sr-only">{more} more components</span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Stars a service so it sorts first and shows under the Starred filter. It is
 * a preference, not a status, so it stays neutral rather than taking a
 * status colour. The star fills in 150ms when toggled (.star-toggle).
 */
export function StarButton({
  name,
  starred,
  onToggle,
  className,
}: {
  name: string;
  starred: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={starred}
      aria-label={`Star ${name}`}
      title={starred ? `Unpin ${name}` : `Pin ${name} to the top`}
      className={cn(
        "star-toggle grid size-11 shrink-0 place-items-center rounded-md focus-ring pressable",
        starred ? "text-fg" : "text-subtle hover:text-fg",
        className,
      )}
    >
      <Star className={cn("size-[18px]", starred && "fill-current")} strokeWidth={1.7} />
    </button>
  );
}

/** How many incident lines a service shows before it says "+N more". */
export const MAX_INCIDENTS = 2;

/**
 * What else a service has open besides its components: incident lines (a
 * notice is labelled a Notice, never a health) and planned maintenance. Both
 * arrive worst or soonest first, so a cut keeps the ones that matter, and the
 * cut is counted, never silent. `hideTitle` leaves out the incident whose
 * title the card already prints as its summary. A release tracker has no planned maintenance.
 * Nothing when there is nothing to say.
 */
export function ServiceExtras({
  service,
  hideTitle = "",
  now,
  className,
}: {
  service: ServiceSnapshot;
  /** A normalised title to leave out (the summary the card already shows). */
  hideTitle?: string;
  now: number;
  className?: string;
}) {
  const all = service.incidents.filter((incident) => !hideTitle || norm(incident.title) !== hideTitle);
  const incidents = all.slice(0, MAX_INCIDENTS);
  const more = all.length - incidents.length;
  const upcoming = service.category === "updates" ? [] : (service.upcomingMaintenance ?? []);
  if (incidents.length === 0 && upcoming.length === 0) return null;
  const checkedAt = Date.parse(service.checkedAt);

  return (
    <div className={cn("dynamic-text flex flex-col gap-3 text-caption", className)}>
      {incidents.length > 0 ? (
        <ul aria-label="Incidents" className="space-y-2">
          {incidents.map((incident, incidentIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a vendor can repeat an incident id; the index only breaks that tie.
            <li key={`${incident.id}-${incidentIndex}`} className="text-fg [overflow-wrap:anywhere]">
              {/* A notice reports no impact, so it is not labelled with a health. */}
              <span
                className={
                  incident.informational ? "font-[450] text-subtle" : cn("font-semibold", STATUS_TEXT[incident.health])
                }
              >
                {incident.informational ? "Notice" : stateWord(incident.health)}
              </span>
              <span className="text-subtle"> · </span>
              {incident.title}
              <IncidentSince
                startedAt={incident.startedAt}
                reference={checkedAt}
                now={now}
                lineStart
                className="block text-footnote"
              />
            </li>
          ))}
          {more > 0 ? (
            <li className="text-footnote text-subtle" data-more-incidents>
              <span aria-hidden>+{more} more</span>
              <span className="sr-only">{more} more incidents</span>
            </li>
          ) : null}
        </ul>
      ) : null}

      {upcoming.length > 0 ? (
        <ul aria-label="Upcoming maintenance" className="space-y-2" data-upcoming-maintenance>
          {upcoming.map((item, upcomingIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a vendor can repeat an event id; the index only breaks that tie.
            <li key={`${item.id}-${upcomingIndex}`} className="text-fg [overflow-wrap:anywhere]">
              <span className={cn("font-semibold", STATUS_TEXT.maintenance)}>Upcoming</span>
              <span className="text-subtle"> · </span>
              {item.title}
              <IncidentSince
                startedAt={item.scheduledFor}
                reference={checkedAt}
                now={now}
                scheduled
                lineStart
                className="block text-footnote"
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
