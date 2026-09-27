import { ArrowUpRight } from "lucide-react";
import { useServiceHistoryDays } from "@/components/status/board-history-provider";
import { HealthDot } from "@/components/status/health-dot";
import { HistoryStrip } from "@/components/status/history-strip";
import { CATEGORY_ICON, StarButton } from "@/components/status/service-card-shared";
import { CATEGORIES } from "@/lib/status/catalog";
import { ALL_CLEAR_SUMMARY } from "@/lib/status/health";
import type { HistoryDay } from "@/lib/status/history";
import { serviceAnchor, serviceIndex } from "@/lib/status/layout";
import type { ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

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
  historyDays = [],
  now = 0,
}: {
  service: ServiceSnapshot;
  index: number;
  emphasized?: boolean;
  starred: boolean;
  onToggleStar: (id: ServiceSnapshot["id"]) => void;
  /** Public history days for this service; empty when cold or missing. */
  historyDays?: HistoryDay[];
  /** Client clock for the strip's UTC day window. */
  now?: number;
}) {
  const contextDays = useServiceHistoryDays(service.id);
  const days = historyDays.length > 0 ? historyDays : contextDays;
  const Icon = CATEGORY_ICON[service.category];
  const detail = service.summary && service.summary !== ALL_CLEAR_SUMMARY ? service.summary : null;

  return (
    <article
      id={serviceAnchor(service.id)}
      tabIndex={-1}
      className={cn(
        "focus-ring spotlight relative flex scroll-mt-6 flex-col gap-2 rounded-md glass-whisper py-2 pr-1.5 pl-3 stagger-in",
        emphasized && "service-card-changed",
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms`, viewTransitionName: `vt-${service.id}` }}
    >
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xs glass-inset text-ok" aria-hidden>
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-medium tracking-[-0.01em]">
            <span className="truncate">{service.name}</span>
            <HealthDot health="operational" />
            <span className="sr-only">Operational</span>
          </h3>
          <p className="line-clamp-2 font-mono text-[11px] text-subtle [overflow-wrap:anywhere]">
            <span aria-hidden className="mr-2 tabular-nums slashed-zero">
              {serviceIndex(service.id)}
            </span>
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
          className="focus-ring pressable grid size-11 shrink-0 place-items-center rounded-full text-subtle hover:text-fg"
        >
          <ArrowUpRight className="size-4" />
        </a>
      </div>
      {days.length > 0 ? <HistoryStrip days={days} nowMs={now} compact className="pr-1.5" /> : null}
    </article>
  );
}
