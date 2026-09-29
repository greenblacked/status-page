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

/*
  A quiet day is a fine neutral tick; only a day that went wrong gets a
  full-width mark in its status colour, so the eye lands on the exceptions.
  A day with no record is a stub on the baseline.
*/
const SLOT_MARK: Record<Health, string> = {
  operational: "h-full w-px bg-tick",
  degraded: "h-full w-full bg-warn",
  outage: "h-full w-full bg-down",
  maintenance: "h-full w-full bg-accent",
  unknown: "h-full w-full bg-subtle/60",
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
      <div
        role="img"
        aria-label={summary}
        className={cn("mt-1.5 flex items-stretch gap-px border-b border-hairline", compact ? "h-3" : "h-4")}
      >
        {slots.map((slot) => (
          <span key={slot.date} title={historySlotTitle(slot)} className="flex min-w-0 flex-1 items-end justify-center">
            <span
              className={cn("block rounded-[1px]", slot.day ? SLOT_MARK[slot.day.worst] : "h-1 w-px bg-hairline")}
            />
          </span>
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
