import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { useServiceHistoryDays } from "@/components/status/board-history-provider";
import { HistoryStrip } from "@/components/status/history-strip";
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
 * the state (green for a recovery, the accent for unknown). It uses ::after
 * because ::before draws the row's separator.
 */
export function RowFrame({
  service,
  emphasized,
  starred,
  onToggleStar,
  lead,
  children,
}: Pick<ServiceCardProps, "service" | "emphasized" | "starred" | "onToggleStar"> & {
  lead: ReactNode;
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
          CHANGED_BAR.row[service.health],
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
export function RowHeader({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div data-card-header className="min-w-0 py-2">
      <h3 className="text-row text-balance">{name}</h3>
      <p className="text-caption text-subtle">{children}</p>
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
  const header = (
    <RowHeader name={service.name}>
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
      {extras ? ` · ${upcoming ? "Maintenance planned" : "Notice"}` : null}
      {emphasized ? (
        <>
          {" "}
          <ChangedTag />
        </>
      ) : null}
    </RowHeader>
  );
  const withDetails = !unread && (service.components.length > 0 || extras);
  // The 30-day uptime strip, in a build that collects history: under the row's own line, so the row
  // stays as it is until there are days to draw. A release tracker (the changelog category) has none.
  const historyBuild = import.meta.env.VITE_STATUS_HISTORY === "1";
  const days = useServiceHistoryDays(service.id);
  const strip =
    historyBuild && days.length > 0 && service.category !== "updates" ? (
      <HistoryStrip days={days} nowMs={now} className="pt-1 pb-3" />
    ) : null;

  const body = withDetails ? (
    // The chevron (styles.css) sits at the summary's middle line, which is the row's, not its top.
    <details className="row-details min-w-0 [&>summary]:after:top-[calc(50%-0.25rem)]!">
      <summary className="focus-ring flex min-h-(--row-h) items-center rounded-md focus-visible:-outline-offset-2!">
        {header}
      </summary>
      <div className="flex flex-col gap-3 pr-6 pb-3">
        <ServiceExtras service={service} now={now} />
        <HealthyComponents
          components={service.components}
          total={service.componentCount ?? service.components.length}
          sourceUrl={service.sourceUrl}
        />
      </div>
    </details>
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
