import { ArrowUpRight } from "lucide-react";
import { useId, useState } from "react";
import { useServiceHistoryDays } from "@/components/status/board-history-provider";
import { HistoryStrip } from "@/components/status/history-strip";
import { PenLoop } from "@/components/status/pen";
import { ReleaseDetails } from "@/components/status/release-details";
import {
  ComponentRow,
  HealthyComponents,
  hostOf,
  IncidentSince,
  ListToggle,
  norm,
  penSeed,
  type ServiceCardProps,
  ServiceExtras,
  StarButton,
  StateWord,
} from "@/components/status/service-card-shared";
import { STATUS_TEXT, StatusGlyph } from "@/components/status/status-glyph";
import { Tag } from "@/components/ui/tag";
import { incidentLink, serviceAnchor } from "@/lib/status/layout";
import { parseTimestamp } from "@/lib/status/schedule";
import type { ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

/** How many broken component rows a card shows before it says "+N more". */
const MAX_ROWS = 6;

/**
 * A release tracker in the attention list is one with a release from the last
 * two weeks (the collectors mark the fresh channel on its component row or
 * the feed itself): its word is "New release", not a health.
 */
function isFreshTracker(service: ServiceSnapshot): boolean {
  return (
    service.category === "updates" &&
    (service.health === "maintenance" || service.components.some((component) => component.health === "maintenance"))
  );
}

/**
 * The card for a service that needs a look: in outage, degraded or in
 * maintenance. It says what state it is in and since when, gives the summary
 * as the vendor's own words, lists its broken components and open incidents,
 * and links to the incident or the status page. Every line should add something
 * the summary does not already say: vendors often repeat one incident as the
 * status description, the affected component and the incident title.
 *
 * `highlight` marks the board's most urgent service with `data-highlight`
 * alone (no caption, no wider card). It is an attribute on the one <article>,
 * never a wrapper, so a card that gains or loses it keeps its DOM node (and
 * the keyboard focus inside it).
 */
export function AttentionCard({
  service,
  highlight = false,
  emphasized = false,
  starred,
  onToggleStar,
  now,
}: ServiceCardProps) {
  const days = useServiceHistoryDays(service.id);
  const changelog = service.category === "updates";
  const summary = norm(service.summary);
  const outage = service.health === "outage";

  // Release channels and CS2 relays are the content of their cards, up or not;
  // for everything else only broken components earn a row.
  const allRows =
    changelog || service.id === "cs2-europe"
      ? service.components
      : service.components.filter((component) => component.health !== "operational");
  const [allShown, setAllShown] = useState(false);
  const rowsId = useId();
  const rows = allShown ? allRows : allRows.slice(0, MAX_ROWS);
  const moreRows = allRows.length - MAX_ROWS;
  // The working components go in the same dropdown a healthy row has, so a service that goes down
  // keeps its list. Changelog and relay cards already show everything they have above.
  const healthy =
    changelog || service.id === "cs2-europe"
      ? []
      : service.components.filter((component) => component.health === "operational");
  const healthyTotal =
    (service.componentCount ?? service.components.length) - (service.components.length - healthy.length);
  // The worst incident with a readable start says when this began; the summary
  // often is that incident's title, and then it has no row of its own.
  const startedIncident = changelog
    ? undefined
    : (service.incidents.find((incident) => norm(incident.title) === summary && parseTimestamp(incident.startedAt)) ??
      service.incidents.find((incident) => !incident.informational && parseTimestamp(incident.startedAt) !== null));
  // The worst incident with a page of its own; a vendor's generic dashboard is the source link, not an incident.
  const incidentUrl = changelog ? undefined : incidentLink(service);
  const checkedAt = Date.parse(service.checkedAt);
  const fresh = isFreshTracker(service);
  const mark = highlight && (service.health === "outage" || service.health === "degraded");

  return (
    <article
      id={serviceAnchor(service.id)}
      data-highlight={mark ? "true" : undefined}
      data-changed={emphasized ? "true" : undefined}
      // Focusable by script and by its #service-<id> link, never by Tab, so
      // a chip in the headline leaves the keyboard on the card it jumped to.
      tabIndex={-1}
      className="surface spotlight focus-ring relative scroll-mt-6 p-4"
    >
      {emphasized ? (
        // Changed: a 2px accent bar on the inline-start edge, fading in once. It has no hue of its own. A real
        // element, not a pseudo-element: ::before and ::after carry the Glass and Full sheen and glint. The
        // important position outweighs the Glass rule that makes a panel's children relative.
        <span
          aria-hidden
          className="absolute! inset-y-4 left-0 w-0.5 bg-accent opacity-100 transition-opacity duration-(--t-reveal) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-none"
        />
      ) : null}
      <div data-card-header className="flex items-start gap-3">
        <span className="relative mt-px shrink-0">
          <StatusGlyph health={service.health} size={22} className={cn("block", STATUS_TEXT[service.health])} />
          {outage ? <PenLoop seed={penSeed(service.id)} /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-row text-balance">{service.name}</h3>
          <p className="text-caption">
            {fresh ? <span className="font-semibold text-fg">New release</span> : <StateWord health={service.health} />}
            {startedIncident ? (
              <>
                {" "}
                <IncidentSince
                  startedAt={startedIncident.startedAt}
                  reference={checkedAt}
                  now={now}
                  className="text-muted"
                />
              </>
            ) : null}
            {emphasized ? (
              <>
                {" "}
                <Tag>
                  Changed<span className="sr-only"> since the last check</span>
                </Tag>
              </>
            ) : null}
          </p>
        </div>
        <StarButton
          name={service.name}
          starred={starred}
          onToggle={() => onToggleStar(service.id)}
          className="-mt-2 -mr-2"
        />
      </div>

      <p className="dynamic-text mt-2 ml-[34px] text-body text-fg [overflow-wrap:anywhere]">{service.summary}</p>

      {rows.length > 0 ? (
        <div className="mt-3 ml-[34px]" data-more-rows={moreRows > 0 ? "" : undefined}>
          <ul id={rowsId} aria-label="Components" className="flex flex-col gap-1.5">
            {rows.map((component, componentIndex) => (
              <ComponentRow
                // biome-ignore lint/suspicious/noArrayIndexKey: a vendor can list two components with one name; the index only breaks that tie.
                key={`${component.name}-${componentIndex}`}
                component={component}
                changelog={changelog}
                // A status summary often is the detail, word for word. A release
                // row's detail is its version, which the summary may quote but
                // the row still needs.
                showDetail={Boolean(component.detail) && (changelog || !summary.includes(norm(component.detail ?? "")))}
              />
            ))}
          </ul>
          {moreRows > 0 ? (
            <ListToggle
              expanded={allShown}
              onToggle={() => setAllShown(!allShown)}
              controls={rowsId}
              total={allRows.length}
              noun={changelog ? "releases" : service.id === "cs2-europe" ? "relays" : "components"}
            />
          ) : null}
        </div>
      ) : null}

      {healthy.length > 0 ? (
        <details className="row-details mt-2 ml-[34px]" data-healthy-components>
          <summary className="focus-ring flex min-h-11 items-center rounded-md text-caption text-muted focus-visible:-outline-offset-2! [&]:after:top-[calc(50%-0.25rem)]!">
            Working components · {healthyTotal}
          </summary>
          <HealthyComponents
            components={healthy}
            total={healthyTotal}
            label="Working components"
            sourceUrl={service.sourceUrl}
            className="pr-6 pb-2"
          />
        </details>
      ) : null}

      <ServiceExtras service={service} hideTitle={summary} now={now} className="mt-3 ml-[34px]" />

      {import.meta.env.VITE_STATUS_HISTORY === "1" && days.length > 0 && !changelog ? (
        <HistoryStrip days={days} nowMs={now} className="mt-4 ml-[34px]" />
      ) : null}

      <div className="mt-1 -mb-2 ml-[34px] flex items-center justify-between gap-3 text-caption">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4">
          <a
            href={incidentUrl ?? service.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="focus-ring pressable inline-flex min-h-11 min-w-0 items-center gap-1 text-accent"
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {incidentUrl ? "Incident details" : hostOf(service.sourceUrl, service.sourceName)}
            </span>
            <span className="sr-only"> for {service.name}</span>
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
          </a>
          {changelog ? <ReleaseDetails service={service} variant="button" /> : null}
        </div>
        <span className="whitespace-nowrap tabular-nums text-subtle" title="How long the vendor took to answer">
          <span aria-hidden>{`${service.latencyMs}\u202fms`}</span>
          <span className="sr-only">answered in {service.latencyMs} ms</span>
        </span>
      </div>
    </article>
  );
}
