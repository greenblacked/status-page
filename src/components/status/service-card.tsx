import { ArrowUpRight, Cloud, Cpu, Gamepad2, History, Smartphone, Star } from "lucide-react";
import { HealthDot } from "@/components/status/health-dot";
import { Badge } from "@/components/ui/badge";
import { CATEGORIES } from "@/lib/status/catalog";
import { ALL_CLEAR_SUMMARY, healthLabel } from "@/lib/status/health";
import { serviceAnchor } from "@/lib/status/layout";
import { formatDuration, formatUtcTime, parseTimestamp } from "@/lib/status/schedule";
import type { CategoryId, ComponentHealth, ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

const CATEGORY_ICON: Record<CategoryId, typeof Cloud> = {
  cloud: Cloud,
  gaming: Gamepad2,
  platforms: Smartphone,
  ai: Cpu,
  updates: History,
};

const ICON_TONE = {
  operational: "text-ok",
  degraded: "text-warn",
  outage: "text-down",
  maintenance: "text-accent",
  unknown: "text-subtle",
} as const;

const norm = (text: string) => text.trim().toLowerCase();

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
}: {
  service: ServiceSnapshot;
  index: number;
  emphasized?: boolean;
  starred: boolean;
  onToggleStar: (id: ServiceSnapshot["id"]) => void;
  /** The client clock (0 until mounted), for how long an incident has run. */
  now: number;
}) {
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
  const summaryIncident = changelog ? undefined : service.incidents.find((incident) => norm(incident.title) === summary);
  const incidentUrl = changelog ? undefined : service.incidents.find((incident) => incident.url)?.url;
  const checkedAt = Date.parse(service.checkedAt);

  return (
    <article
      id={serviceAnchor(service.id)}
      className={cn(
        "spotlight group relative flex scroll-mt-6 flex-col rounded-3xl glass p-4 transition-[box-shadow,transform] duration-[var(--motion-fast)] ease-[var(--ease-smooth-out)] hover:shadow-[var(--shadow-border-hover)] stagger-in",
        emphasized && (service.health === "outage" ? "service-card-changed is-down" : "service-card-changed"),
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms`, viewTransitionName: `vt-${service.id}` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn("grid size-10 shrink-0 place-items-center rounded-2xl glass-inset", ICON_TONE[service.health])}
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
          <StarButton name={service.name} starred={starred} onToggle={() => onToggleStar(service.id)} className="-my-2 -mr-2" />
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
            <li key={`${incident.id}-${incidentIndex}`} className="text-sm text-fg [overflow-wrap:anywhere]">
              <span className={ICON_TONE[incident.health]}>{healthLabel(incident.health)}</span>
              <span className="text-subtle"> · </span>
              {incident.title}
              <IncidentSince startedAt={incident.startedAt} reference={checkedAt} now={now} />
            </li>
          ))}
        </ul>
      ) : null}

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

/**
 * When an incident began, as "since 14:05 UTC", and after hydration how long
 * it has run. The start is the same text on the server and the client; the
 * duration needs the visitor's clock, so it waits for `now`.
 */
function IncidentSince({
  startedAt,
  reference,
  now,
  className,
}: {
  startedAt: string | undefined;
  /** When the card was checked; a start on another day shows its date. */
  reference: number;
  now: number;
  className?: string;
}) {
  const at = parseTimestamp(startedAt);
  if (at === null) return null;
  const duration = now > 0 ? formatDuration(now - at) : null;
  return (
    <span className={cn("block font-mono text-[11px] tabular-nums text-subtle", className)}>
      since{" "}
      <time dateTime={new Date(at).toISOString()}>
        {formatUtcTime(at, Number.isFinite(reference) ? reference : at)}
      </time>
      {duration ? (
        <>
          {" · "}
          <time dateTime={duration.iso}>
            <span aria-hidden>{duration.short}</span>
            <span className="sr-only">{duration.long}</span>
          </time>
        </>
      ) : null}
    </span>
  );
}

function ComponentRow({
  component,
  changelog,
  showDetail,
}: {
  component: ComponentHealth;
  changelog: boolean;
  showDetail: boolean;
}) {
  const badge = changelog
    ? component.health === "maintenance" && <Badge tone="maintenance">New</Badge>
    : component.health !== "operational" && <Badge tone={component.health}>{healthLabel(component.health)}</Badge>;

  return (
    <li className="flex items-center gap-3 rounded-xl glass-inset px-3 py-2">
      {/* The floor keeps a name readable beside a long detail without reserving room a short name does not need. */}
      <span className="min-w-[4.5rem] flex-1 truncate text-sm text-fg" title={component.name}>
        {component.name}
      </span>
      {showDetail ? (
        <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-subtle" title={component.detail}>
          {component.detail}
        </span>
      ) : null}
      {badge ? <span className="shrink-0">{badge}</span> : null}
    </li>
  );
}

/**
 * The compact form for an operational status service: one line, since
 * "operational" needs no more room than that. The summary shows only when it
 * says something beyond the generic all-clear sentence.
 */
export function ServiceTile({
  service,
  index,
  emphasized = false,
  starred,
  onToggleStar,
}: {
  service: ServiceSnapshot;
  index: number;
  emphasized?: boolean;
  starred: boolean;
  onToggleStar: (id: ServiceSnapshot["id"]) => void;
}) {
  const Icon = CATEGORY_ICON[service.category];
  const detail = service.summary && service.summary !== ALL_CLEAR_SUMMARY ? service.summary : null;

  return (
    <article
      id={serviceAnchor(service.id)}
      className={cn(
        "spotlight flex scroll-mt-6 items-center gap-3 rounded-2xl glass py-2 pr-1.5 pl-3 stagger-in",
        emphasized && "service-card-changed",
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms`, viewTransitionName: `vt-${service.id}` }}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl glass-inset text-ok" aria-hidden>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-2 text-sm font-medium tracking-[-0.01em]">
          <span className="truncate">{service.name}</span>
          <HealthDot health="operational" />
          <span className="sr-only">Operational</span>
        </h3>
        <p className="line-clamp-2 font-mono text-[11px] text-subtle [overflow-wrap:anywhere]">
          {detail ?? CATEGORIES.find((category) => category.id === service.category)?.label}
        </p>
      </div>
      <StarButton name={service.name} starred={starred} onToggle={() => onToggleStar(service.id)} />
      <a
        href={service.sourceUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`${service.sourceName}, official status for ${service.name}`}
        title={service.sourceName}
        className="focus-ring grid size-11 shrink-0 place-items-center rounded-full text-subtle transition-colors duration-[var(--motion-quick)] hover:text-fg"
      >
        <ArrowUpRight className="size-4" />
      </a>
    </article>
  );
}

/**
 * Stars a service so it sorts first and shows under the Starred filter. It is
 * a preference, not a status, so it stays neutral rather than taking a
 * status colour.
 */
function StarButton({
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
      title={starred ? `Unstar ${name}` : `Star ${name} to keep it first`}
      className={cn(
        "grid size-11 shrink-0 place-items-center rounded-full transition-colors duration-[var(--motion-quick)] focus-ring",
        starred ? "text-fg" : "text-subtle hover:text-fg",
        className,
      )}
    >
      <Star className={cn("size-4", starred && "fill-current")} strokeWidth={1.75} />
    </button>
  );
}
