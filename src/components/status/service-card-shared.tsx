import { Cloud, Cpu, Gamepad2, History, Smartphone, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { healthLabel } from "@/lib/status/health";
import { formatUtcTime, incidentStart, parseTimestamp } from "@/lib/status/schedule";
import type { CategoryId, ComponentHealth } from "@/lib/status/types";
import { cn } from "@/lib/utils";

export const CATEGORY_ICON: Record<CategoryId, typeof Cloud> = {
  cloud: Cloud,
  gaming: Gamepad2,
  platforms: Smartphone,
  ai: Cpu,
  updates: History,
};

export const ICON_TONE = {
  operational: "text-ok",
  degraded: "text-warn",
  outage: "text-down",
  maintenance: "text-accent",
  unknown: "text-subtle",
} as const;

export const norm = (text: string) => text.trim().toLowerCase();

/**
 * When an incident began, as "since 14:05 UTC", and after hydration how long
 * it has run. A start still ahead, such as planned maintenance, reads
 * "scheduled for 22:00 UTC" instead. The start is the same text on the
 * server and the client; the duration needs the visitor's clock, so it
 * waits for `now`.
 */
export function IncidentSince({
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
  const { upcoming, duration } = incidentStart(at, now, reference);
  return (
    <span className={cn("block font-mono text-[11px] tabular-nums text-subtle", className)}>
      {upcoming ? "scheduled for " : "since "}
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

export function ComponentRow({
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
 * Stars a service so it sorts first and shows under the Starred filter. It is
 * a preference, not a status, so it stays neutral rather than taking a
 * status colour.
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
