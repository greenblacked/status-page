import {
  formatUptimePercent,
  historySlots,
  historySlotTitle,
  historyStripSummary,
  sampleWeightedUptime,
  utcToday,
  worstHistoryDay,
} from "@/lib/status/board-history";
import type { HistoryDay } from "@/lib/status/history";
import type { Health } from "@/lib/status/types";
import { cn } from "@/lib/utils";

const SLOT_TONE: Record<Health, string> = {
  operational: "bg-ok",
  degraded: "bg-warn",
  outage: "bg-down",
  maintenance: "bg-accent",
  unknown: "bg-subtle",
};

/**
 * Compact 30-day uptime strip for a service card. Renders nothing when there
 * are no public days (cold history or a service the document omits). Colour
 * alone is never the only cue: a caption and per-slot titles carry the same
 * meaning. Built only from public day fields.
 */
export function HistoryStrip({
  days,
  nowMs,
  compact = false,
  className,
}: {
  days: HistoryDay[];
  /** Client clock ms; 0 / unset falls back to Date.now() after mount callers pass useNow(). */
  nowMs?: number;
  /** Tighter bars for the operational tile. */
  compact?: boolean;
  className?: string;
}) {
  if (days.length === 0) return null;

  const today = utcToday(nowMs && nowMs > 0 ? nowMs : Date.now());
  if (!today) return null;

  const slots = historySlots(days, today);
  if (slots.length === 0) return null;

  const uptime = sampleWeightedUptime(days);
  const worst = worstHistoryDay(days);
  const summary = historyStripSummary(days, uptime, worst);
  const showWorstChip = Boolean(worst && worst.worst !== "operational");

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-end justify-between gap-2">
        <p className="font-mono text-[11px] tabular-nums text-subtle">
          {uptime !== null ? (
            <>
              <span className="text-muted">{formatUptimePercent(uptime)}</span>
              <span> uptime</span>
            </>
          ) : (
            <span>Uptime history</span>
          )}
          {showWorstChip && worst ? (
            <>
              <span className="text-subtle"> · </span>
              <span className={cn("text-muted", toneText(worst.worst))}>
                {worst.date.slice(5)} {shortHealth(worst.worst)}
              </span>
            </>
          ) : null}
        </p>
        <p className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-subtle">30d</p>
      </div>
      <div role="img" aria-label={summary} className={cn("mt-1.5 flex items-stretch gap-px", compact ? "h-3" : "h-4")}>
        {slots.map((slot) => (
          <span
            key={slot.date}
            title={historySlotTitle(slot)}
            className={cn("min-w-0 flex-1 rounded-[1px]", slot.day ? SLOT_TONE[slot.day.worst] : "bg-subtle/25")}
          />
        ))}
      </div>
    </div>
  );
}

function shortHealth(health: Health): string {
  switch (health) {
    case "operational":
      return "ok";
    case "degraded":
      return "degraded";
    case "outage":
      return "outage";
    case "maintenance":
      return "maint";
    default:
      return "unknown";
  }
}

function toneText(health: Health): string {
  switch (health) {
    case "operational":
      return "text-ok";
    case "degraded":
      return "text-warn";
    case "outage":
      return "text-down";
    case "maintenance":
      return "text-accent";
    default:
      return "text-subtle";
  }
}
