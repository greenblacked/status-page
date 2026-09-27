import { ArrowUpRight } from "lucide-react";
import { useServiceHistoryDays } from "@/components/status/board-history-provider";
import { HealthDot } from "@/components/status/health-dot";
import { HistoryStrip } from "@/components/status/history-strip";
import {
  CATEGORY_ICON,
  ComponentRow,
  ICON_TONE,
  IncidentSince,
  norm,
  StarButton,
} from "@/components/status/service-card-shared";
import { Badge } from "@/components/ui/badge";
import { healthLabel } from "@/lib/status/health";
import type { HistoryDay } from "@/lib/status/history";
import { serviceAnchor } from "@/lib/status/layout";
import type { ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

/**
 * The full card, for services that need attention and for the release
 * trackers. Every line should add something the summary does not already
 * say: vendors often repeat one incident as the status description, the
 * affected component and the incident title.
 */
export function ServiceCard({
  service,
  index,
  emphasized = false,
  starred,
  onToggleStar,
  now,
  historyDays = [],
}: {
  service: ServiceSnapshot;
  index: number;
  emphasized?: boolean;
  starred: boolean;
  onToggleStar: (id: ServiceSnapshot["id"]) => void;
  /** The client clock (0 until mounted), for how long an incident has run. */
  now: number;
  /** Public history days for this service; empty when cold or missing. */
  historyDays?: HistoryDay[];
}) {
  const contextDays = useServiceHistoryDays(service.id);
  const days = historyDays.length > 0 ? historyDays : contextDays;
  const Icon = CATEGORY_ICON[service.category];
  const changelog = service.category === "updates";
  const summary = norm(service.summary);

  // Release channels and CS2 pops are the content of their cards. Elsewhere
  // only broken components earn a row.
  const rows = (
    changelog || service.id === "cs2-europe"
      ? service.components
      : service.components.filter((component) => component.health !== "operational")
  ).slice(0, 6);
  const incidents = service.incidents.filter((incident) => norm(incident.title) !== summary).slice(0, 2);
  // An incident whose title is the summary has no row of its own, so its
  // start goes under the summary instead.
  const summaryIncident = changelog
    ? undefined
    : service.incidents.find((incident) => norm(incident.title) === summary);
  const incidentUrl = changelog ? undefined : service.incidents.find((incident) => incident.url)?.url;
  const checkedAt = Date.parse(service.checkedAt);

  return (
    <article
      id={serviceAnchor(service.id)}
      // Focusable by script and by its #service-<id> link, never by Tab, so
      // an attention chip leaves the keyboard on the card it jumped to.
      tabIndex={-1}
      className={cn(
        "focus-ring spotlight group relative flex scroll-mt-6 flex-col rounded-3xl glass p-4 transition-[box-shadow,transform] duration-[var(--motion-fast)] ease-[var(--ease-smooth-out)] hover:shadow-[var(--shadow-border-hover)] stagger-in",
        emphasized && (service.health === "outage" ? "service-card-changed is-down" : "service-card-changed"),
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms`, viewTransitionName: `vt-${service.id}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-2xl glass-inset",
              ICON_TONE[service.health],
            )}
            aria-hidden
          >
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h3 className="font-display text-lg font-medium leading-tight tracking-[-0.03em] text-balance">
              {service.name}
            </h3>
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">
              {service.shortName}
              {emphasized ? " · changed" : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Badge tone={service.health} className="gap-1.5 pr-2.5 pl-2">
            <HealthDot health={service.health} />
            {healthLabel(service.health)}
          </Badge>
          <StarButton
            name={service.name}
            starred={starred}
            onToggle={() => onToggleStar(service.id)}
            className="-my-2 -mr-2"
          />
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-muted text-pretty [overflow-wrap:anywhere]">{service.summary}</p>
      {summaryIncident ? (
        <IncidentSince startedAt={summaryIncident.startedAt} reference={checkedAt} now={now} className="mt-1" />
      ) : null}

      {rows.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-1.5">
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
      ) : null}

      {incidents.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {incidents.map((incident, incidentIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a vendor can repeat an incident id; the index only breaks that tie.
            <li key={`${incident.id}-${incidentIndex}`} className="text-sm text-fg [overflow-wrap:anywhere]">
              <span className={ICON_TONE[incident.health]}>{healthLabel(incident.health)}</span>
              <span className="text-subtle"> · </span>
              {incident.title}
              <IncidentSince startedAt={incident.startedAt} reference={checkedAt} now={now} />
            </li>
          ))}
        </ul>
      ) : null}

      {days.length > 0 ? <HistoryStrip days={days} nowMs={now} className="mt-4" /> : null}

      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <p className="font-mono text-[11px] tabular-nums text-subtle" title="Time the official source took to answer">
          {service.latencyMs} ms
        </p>
        <a
          href={incidentUrl ?? service.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="focus-ring inline-flex min-h-11 min-w-0 items-center gap-1 rounded-full px-2 text-xs text-muted transition-colors duration-[var(--motion-quick)] hover:text-fg"
        >
          <span className="truncate">{incidentUrl ? "View incident" : service.sourceName}</span>
          <ArrowUpRight className="size-3.5 shrink-0" />
        </a>
      </div>
    </article>
  );
}
