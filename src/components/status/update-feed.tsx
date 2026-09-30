import { Badge } from "@/components/ui/badge";
import { healthLabel } from "@/lib/status/health";
import type { Pulse } from "@/lib/status/pulse";
import { formatSlotTime } from "@/lib/status/schedule";
import { cn } from "@/lib/utils";

export function UpdateFeed({ pulses, className }: { pulses: Pulse[]; className?: string }) {
  const latest = pulses[0];

  return (
    <section className={cn("glass rounded-lg p-4", className)}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">Checks and new releases</p>
          <h2 className="mt-1 font-display text-xl tracking-[-0.03em]">Board log</h2>
        </div>
        {latest ? <Badge tone={latest.overall}>{healthLabel(latest.overall)}</Badge> : null}
      </div>

      {pulses.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Recording the opening snapshot…</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-0">
          {pulses.slice(0, 8).map((pulse, index) => (
            <li
              key={pulse.slot}
              className={cn(
                "grid grid-cols-[4.5rem_1fr] gap-3 border-t border-border py-3 first:border-t-0 first:pt-0",
                index === 0 && "stagger-in",
              )}
            >
              <time
                dateTime={new Date(pulse.slot).toISOString()}
                className="font-mono text-[11px] tabular-nums text-subtle"
              >
                {formatSlotTime(pulse.slot)}
              </time>
              <div className="min-w-0">
                <p className="text-sm text-fg">
                  {pulse.opening
                    ? "Opening snapshot"
                    : pulse.changes.length === 0
                      ? "No change"
                      : pulse.changes.length === 1
                        ? pulse.changes[0].from === pulse.changes[0].to
                          ? `${pulse.changes[0].name}: ${pulse.changes[0].summary}`
                          : `${pulse.changes[0].name} ${healthLabel(pulse.changes[0].from)} → ${healthLabel(pulse.changes[0].to)}`
                        : `${pulse.changes.length} services changed`}
                </p>
                <p className="mt-0.5 font-mono text-[11px] tabular-nums text-subtle">
                  {pulse.counts.operational}/{Object.values(pulse.counts).reduce((sum, n) => sum + n, 0)} clear
                  {pulse.changes.length > 1
                    ? ` · ${pulse.changes.map((change) => change.name).join(", ")}`
                    : pulse.changes[0]?.summary
                      ? ` · ${pulse.changes[0].summary}`
                      : ""}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
