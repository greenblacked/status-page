import { ArrowUpRight } from "lucide-react";
import { useServiceHistoryDays } from "@/components/status/board-history-provider";
import { HistoryStrip } from "@/components/status/history-strip";
import {
  CATEGORY_ICON,
  ComponentRow,
  HealthyComponents,
  ICON_TONE,
  IncidentSince,
  norm,
  StarButton,
} from "@/components/status/service-card-shared";
import { Badge } from "@/components/ui/badge";
import { healthLabel } from "@/lib/status/health";
import { serviceAnchor, serviceIndex } from "@/lib/status/layout";
import type { Health, ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

/**
 * The badge in a card's header, or none. A changelog has no operational
 * state, so a release feed that read fine says nothing ("Operational" would
 * be a placeholder) and one with a release from the last two weeks says
 * "New release". Anything else (an unreadable source, or a health the feed
 * never sets today) is real information and keeps the ordinary badge.
 */
function headerBadgeFor(service: ServiceSnapshot): { tone: Health; label: string } | null {
  if (service.category === "updates" && (service.health === "operational" || service.health === "maintenance")) {
    // The collectors mark the fresh channel or OS on its component row and keep the feed itself operational.
    const fresh = service.health === "maintenance" || service.components.some((c) => c.health === "maintenance");
    return fresh ? { tone: "maintenance", label: "New release" } : null;
  }
  return { tone: service.health, label: healthLabel(service.health) };
}

/**
 * The full card, for every service and the release trackers. A service that
 * needs attention lists its broken components; a healthy one names its
 * components on one quiet line. Every line should add something the summary
 * does not already say: vendors often repeat one incident as the status
 * description, the affected component and the incident title.
 *
 * `highlight` marks the board's most urgent service: the card spans both
 * columns on wide screens under a plain "Most urgent" caption. It is a prop
 * on the one <article>, never a wrapper, so a card that gains or loses it
 * keeps its DOM node (and the keyboard focus inside it).
 */
export function ServiceCard({
  service,
  index,
  highlight = false,
  emphasized = false,
  starred,
  onToggleStar,
  now,
}: {
  service: ServiceSnapshot;
  index: number;
  /** The board's most urgent service: wider on wide screens, under a "Most urgent" caption. */
  highlight?: boolean;
  emphasized?: boolean;
  starred: boolean;
  onToggleStar: (id: ServiceSnapshot["id"]) => void;
  /** The client clock (0 until mounted), for how long an incident has run. */
  now: number;
}) {
  const days = useServiceHistoryDays(service.id);
  const Icon = CATEGORY_ICON[service.category];
  const changelog = service.category === "updates";
  const summary = norm(service.summary);

  // Release channels and CS2 pops are the content of their cards. A service
  // that is up names its components in one compact line instead of rows;
  // otherwise only broken components earn a row.
  const healthy = service.health === "operational" && !changelog && service.id !== "cs2-europe";
  const rows = healthy
    ? []
    : (changelog || service.id === "cs2-europe"
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
  const headerBadge = headerBadgeFor(service);

  return (
    <article
      id={serviceAnchor(service.id)}
      data-highlight={highlight ? "true" : undefined}
      // Focusable by script and by its #service-<id> link, never by Tab, so
      // an attention chip leaves the keyboard on the card it jumped to.
      tabIndex={-1}
      className={cn(
        "@container focus-ring spotlight group relative flex scroll-mt-6 flex-col rounded-lg glass p-4 stagger-in",
        highlight && "@xl:col-span-2",
        emphasized && "service-card-changed",
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms`, viewTransitionName: `vt-${service.id}` }}
    >
      {highlight ? (
        // Neutral, like the rest: the status colour stays in the badge, and amber stays for what just moved.
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">Most urgent</p>
      ) : null}
      <div data-card-header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-xs glass-inset @xs:size-10",
              ICON_TONE[service.health],
            )}
            aria-hidden
          >
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h3 className="font-display text-base font-medium leading-tight @xs:text-lg tracking-[-0.03em] text-balance">
              {service.name}
            </h3>
            <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">
              {/* The catalog index, like a numbered body on a plate. Decorative. */}
              <span aria-hidden className="mr-1.5 tabular-nums slashed-zero">
                {serviceIndex(service.id)} ·
              </span>
              {service.shortName}
              {emphasized ? " · changed" : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          {headerBadge ? <Badge tone={headerBadge.tone}>{headerBadge.label}</Badge> : null}
          <StarButton
            name={service.name}
            starred={starred}
            onToggle={() => onToggleStar(service.id)}
            className="-my-2 -mr-2"
          />
        </div>
      </div>

      <p className="dynamic-text mt-4 text-sm leading-relaxed text-muted text-pretty [overflow-wrap:anywhere]">
        {service.summary}
      </p>
      {summaryIncident ? (
        <IncidentSince startedAt={summaryIncident.startedAt} reference={checkedAt} now={now} className="mt-1" />
      ) : null}

      {healthy ? (
        <HealthyComponents
          components={service.components}
          total={service.componentCount ?? service.components.length}
          className="mt-3"
        />
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
        <ul className="dynamic-text mt-3 space-y-2 text-sm">
          {incidents.map((incident, incidentIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a vendor can repeat an incident id; the index only breaks that tie.
            <li key={`${incident.id}-${incidentIndex}`} className="text-fg [overflow-wrap:anywhere]">
              <span className={ICON_TONE[incident.health]}>{healthLabel(incident.health)}</span>
              <span className="text-subtle"> · </span>
              {incident.title}
              <IncidentSince startedAt={incident.startedAt} reference={checkedAt} now={now} />
            </li>
          ))}
        </ul>
      ) : null}

      {import.meta.env.VITE_STATUS_HISTORY === "1" && days.length > 0 && service.category !== "updates" ? (
        <HistoryStrip days={days} nowMs={now} className="mt-4" />
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <p className="font-mono text-[11px] tabular-nums text-subtle" title="Time the official source took to answer">
          {service.latencyMs} ms
        </p>
        <a
          href={incidentUrl ?? service.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="focus-ring pressable inline-flex min-h-11 min-w-0 items-center gap-1 rounded-full px-2 text-xs text-muted hover:text-fg"
        >
          <span className="truncate">{incidentUrl ? "View incident" : service.sourceName}</span>
          <ArrowUpRight className="size-3.5 shrink-0" />
        </a>
      </div>
    </article>
  );
}
