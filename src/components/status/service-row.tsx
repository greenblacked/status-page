import { ArrowUpRight } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useServiceHistoryDays } from "@/components/status/board-history-provider";
import { HistoryStrip } from "@/components/status/history-strip";
import { ReleaseFeedLine } from "@/components/status/release-line";
import {
  HealthyComponents,
  type ServiceCardProps,
  ServiceExtras,
  StarButton,
  StateWord,
} from "@/components/status/service-card-shared";
import { CHANGED_BAR, STATUS_TEXT, StatusGlyph } from "@/components/status/status-glyph";
import { Tag } from "@/components/ui/tag";
import { serviceAnchor } from "@/lib/status/layout";
import { releaseFeedOf } from "@/lib/status/release-details";
import { cn } from "@/lib/utils";

/** The leading mark sits on the row's middle line, whatever the row's height (56 on a phone, 52 on desktop). */
export const ROW_LEAD = "mt-[calc((var(--row-h)-1.25rem)/2)]";

/** "Changed", the same small tag the attention cards wear, so a recovery is as visible as a failure. */
export function ChangedTag() {
  return (
    <Tag>
      Changed<span className="sr-only"> since the last check</span>
    </Tag>
  );
}

/**
 * The frame every list row shares: a 20px lead, the content, and the star and
 * the status-page link at 44px each. One <article id="service-x"> per service,
 * whatever it holds, because the FLIP glide and the chips find a service by it.
 * It sits in an <li> of a `.card-list` (board-sections.tsx), which draws the
 * hairline between rows.
 *
 * Changed: a 2px bar on the inline-start edge, fading in once, in the colour of
 * the state (green for a recovery, the accent for unknown), or in `bar` when a
 * row has no state of its own to show (a release tracker). It uses ::after
 * because ::before draws the row's separator.
 */
export function RowFrame({
  service,
  emphasized,
  starred,
  onToggleStar,
  lead,
  bar,
  children,
}: Pick<ServiceCardProps, "service" | "emphasized" | "starred" | "onToggleStar"> & {
  lead: ReactNode;
  /** The Changed bar's colour class, when it is not the colour of the service's health. */
  bar?: string;
  children: ReactNode;
}) {
  return (
    <article
      id={serviceAnchor(service.id)}
      data-changed={emphasized ? "true" : undefined}
      // Focusable by script and by its #service-<id> link, never by Tab. The list clips its own edge, so the ring goes inside.
      tabIndex={-1}
      className={cn(
        "row focus-ring grid min-h-(--row-h) scroll-mt-6 grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 pl-4 focus-visible:-outline-offset-2!",
        emphasized && [
          "after:absolute after:inset-y-3 after:left-0 after:w-0.5 after:opacity-100 after:transition-opacity after:duration-(--t-reveal) after:ease-(--ease-out) after:content-[''] after:starting:opacity-0 motion-reduce:after:transition-none forced-colors:after:bg-[CanvasText] forced-colors:after:forced-color-adjust-none",
          bar ?? CHANGED_BAR.row[service.health],
        ],
      )}
    >
      {lead}
      {children}
      <div className="flex min-h-(--row-h) items-center pr-2">
        <StarButton name={service.name} starred={starred} onToggle={() => onToggleStar(service.id)} />
        <a
          href={service.sourceUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`${service.name} status page`}
          className="focus-ring pressable grid size-11 shrink-0 place-items-center rounded-md text-subtle hover:text-fg"
        >
          <ArrowUpRight className="size-[18px]" strokeWidth={1.7} aria-hidden />
        </a>
      </div>
    </article>
  );
}

/** The name and the line under it, the part of a row that is also the summary of its <details>. */
export function RowHeader({
  name,
  children,
  className,
  after,
}: {
  name: string;
  children: ReactNode;
  /** Extra classes for the header; a release row makes it `relative` so its Details button can cover it. */
  className?: string;
  /** A further line under the first (a status card's release line). */
  after?: ReactNode;
}) {
  return (
    <div data-card-header className={cn("min-w-0 py-2", className)}>
      <h3 className="text-row text-balance">{name}</h3>
      <p className="text-caption text-subtle">{children}</p>
      {after}
    </div>
  );
}

/**
 * A row with a component list. Whether or not it has a release line, it is one structure: a wrapper holding the
 * <details>, then (with a feed) the line and the list. A release feed joins a board after the status sweep, so a
 * row gains or loses its feed between boards; the same elements stay at the same places, and the <details> is
 * never replaced: an open row stays open, and the focus in its summary stays.
 *
 * Without a feed the <details> holds the summary and the list, as it always did. With one it holds the summary
 * alone, then the line, then the list: a button may not sit inside a <summary> (axe: nested-interactive), and
 * what follows a summary inside a shut <details> is hidden by the engine in a way that differs between browsers,
 * so the line is a plain sibling and always shows. The list is hidden while the row is shut, and the page can
 * still find what is in it: Ctrl+F or a text fragment to a component name opens the row, as it does for a list
 * inside a shut <details>.
 *
 * Before the page hydrates, and in an engine without `hidden="until-found"` (Safari), the list is hidden by CSS
 * from the `open` attribute (`[details:not([open])~&]:hidden`). Where the engine has `beforematch`, this takes
 * over: the list wears `hidden="until-found"` while the row is shut (React has no prop for that value, so it is
 * set here and follows the details' `toggle` event), the CSS rule steps aside (`data-until-found`), and a match
 * inside the list opens the row (`beforematch`). The effect runs while there is a feed and is undone when the
 * feed goes.
 */
function RowWithComponents({
  summaryClass,
  header,
  line,
  panel,
}: {
  summaryClass: string;
  header: ReactNode;
  /** The release line, or null for a row without a feed. */
  line: ReactNode;
  panel: ReactNode;
}) {
  const hasFeed = line !== null;
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const details = detailsRef.current;
    const list = listRef.current;
    if (!hasFeed || !details || !list || !("onbeforematch" in list)) return;
    const sync = () => {
      if (details.open) list.removeAttribute("hidden");
      else list.setAttribute("hidden", "until-found");
    };
    const reveal = () => {
      details.open = true;
    };
    sync();
    list.dataset.untilFound = "";
    details.addEventListener("toggle", sync);
    list.addEventListener("beforematch", reveal);
    return () => {
      details.removeEventListener("toggle", sync);
      list.removeEventListener("beforematch", reveal);
      list.removeAttribute("hidden");
      delete list.dataset.untilFound;
    };
  }, [hasFeed]);
  return (
    <div className="min-w-0">
      {/* With a feed the chevron is at the middle of the summary (50%): the line under it takes the bottom padding. */}
      <details
        ref={detailsRef}
        className={cn(
          "row-details min-w-0",
          hasFeed ? "row-details-feed [&>summary]:after:top-1/2!" : "[&>summary]:after:top-[calc(50%-0.25rem)]!",
        )}
      >
        <summary className={cn(summaryClass, !hasFeed && "min-h-(--row-h)")}>{header}</summary>
        {hasFeed ? null : panel}
      </details>
      {hasFeed ? <div className="pr-6 pb-2">{line}</div> : null}
      {hasFeed ? (
        <div ref={listRef} data-row-components className="[details:not([open])~&:not([data-until-found])]:hidden">
          {panel}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A service in the compact list. Healthy: an outline glyph, the name, and
 * "Operational · 142 ms" in the light tone, with nothing else to read; a
 * service that lists components opens to them (<details>). One that could not
 * be read ("No data") looks the same with the unknown glyph and the reason in
 * place of the latency; it is not a claim about the vendor.
 */
export function ServiceRow({ service, emphasized, starred, onToggleStar, now }: ServiceCardProps) {
  const unread = service.health === "unknown";
  // A notice or planned maintenance is worth a flag even while everything is up; the detail is one tap away.
  const upcoming = (service.upcomingMaintenance ?? []).length > 0;
  const extras = !unread && (upcoming || service.incidents.length > 0);
  // "Notice" is only for vendor notices with no impact. An incident that is a problem is never called one,
  // whatever the card's health (a collector keeps an operational card free of them, but the label does not rely on it).
  const problems = service.incidents.filter((incident) => !incident.informational).length;
  const extra =
    problems > 0
      ? problems === 1
        ? "Incident"
        : `${problems} incidents`
      : upcoming
        ? "Maintenance planned"
        : "Notice";
  const withDetails = !unread && (service.components.length > 0 || extras);
  // The vendor's release line is the third line of the row, under the health line. A plain row holds it in its
  // header. A row with a list cannot: a button may not sit inside a <summary> (axe: nested-interactive), and
  // anything after a summary inside the <details> is hidden by the engine while the row is shut, in a way that
  // differs between browsers. So the <details> holds the summary alone (it still owns the open state, the
  // chevron and the keyboard), and the line and the list follow it as plain siblings: the line is always
  // rendered, and the list is hidden while the row is shut (see RowWithComponents).
  const feedLine = releaseFeedOf(service) ? <ReleaseFeedLine service={service} /> : null;
  const header = (
    <RowHeader
      name={service.name}
      after={withDetails ? undefined : feedLine}
      // The line follows the summary directly, so the summary gives up its bottom padding to it.
      className={withDetails && feedLine ? "pb-0" : undefined}
    >
      <StateWord health={service.health} />
      {unread ? (
        // The kind-mapped sentence from the collector; it wraps, since it is the reason.
        service.summary ? (
          <>
            {" · "}
            <span className="[overflow-wrap:anywhere]">{service.summary}</span>
          </>
        ) : null
      ) : (
        <>
          {" · "}
          <span
            className="tabular-nums"
            title="How long the vendor took to answer"
          >{`${service.latencyMs}\u202fms`}</span>
        </>
      )}
      {extras ? ` · ${extra}` : null}
      {emphasized ? (
        <>
          {" "}
          <ChangedTag />
        </>
      ) : null}
    </RowHeader>
  );
  // The 30-day uptime strip, in a build that collects history: under the row's own line, so the row
  // stays as it is until there are days to draw. A release tracker (the changelog category) has none.
  const historyBuild = import.meta.env.VITE_STATUS_HISTORY === "1";
  const days = useServiceHistoryDays(service.id);
  const strip =
    historyBuild && days.length > 0 && service.category !== "updates" ? (
      <HistoryStrip days={days} nowMs={now} className="pt-1 pb-3" />
    ) : null;

  // The extras and the components, what a row opens to.
  const panel = (
    <div className="flex flex-col gap-3 pr-6 pb-3">
      <ServiceExtras service={service} now={now} />
      <HealthyComponents
        components={service.components}
        total={service.componentCount ?? service.components.length}
        sourceUrl={service.sourceUrl}
      />
    </div>
  );
  const summaryClass = "focus-ring flex items-center rounded-md focus-visible:-outline-offset-2!";
  // The chevron (styles.css) sits at the middle of the name and health lines. In a summary with padding on
  // both sides that is its middle (50% less the chevron's half height).
  const body = withDetails ? (
    <RowWithComponents summaryClass={summaryClass} header={header} line={feedLine} panel={panel} />
  ) : (
    <div className="flex min-h-(--row-h) min-w-0 items-center">{header}</div>
  );

  return (
    <RowFrame
      service={service}
      emphasized={emphasized}
      starred={starred}
      onToggleStar={onToggleStar}
      lead={
        <StatusGlyph health={service.health} size={20} className={cn("block", STATUS_TEXT[service.health], ROW_LEAD)} />
      }
    >
      {historyBuild ? (
        // One structure whether or not there are days yet: when the history arrives the strip mounts beside
        // the body, and an open row keeps its <details> and the focus in it.
        <div className="min-w-0">
          {body}
          {strip}
        </div>
      ) : (
        body
      )}
    </RowFrame>
  );
}
