import { Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  formatAge,
  formatCountdown,
  formatStaleAge,
  isStale,
  nextRefetchAt,
  PULSE_INTERVAL_MS,
} from "@/lib/status/schedule";
import { cn } from "@/lib/utils";

/** The freshness strip at the foot of the summary panel. */
export function LiveBar({
  checkedAt,
  isFetching,
  now,
  refetchJitterMs,
  className,
}: {
  checkedAt: string;
  isFetching: boolean;
  now: number;
  /** The board query's jitter, so the countdown ends when its refetch starts. */
  refetchJitterMs: number;
  className?: string;
}) {
  const mounted = now > 0;
  const remaining = mounted ? nextRefetchAt(now, refetchJitterMs) - now : 0;
  const progress = mounted ? Math.min(1, Math.max(0, 1 - remaining / PULSE_INTERVAL_MS)) : 0;
  const ageMs = now - Date.parse(checkedAt);
  const age = mounted ? formatAge(ageMs) : "…";
  // A check in flight may yet bring it back, so it is not called stale while one runs.
  const stale = !isFetching && isStale(checkedAt, now);

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-subtle">
        <p className="flex items-center gap-2">
          <Radio className={cn("size-3.5", isFetching || stale ? "text-muted" : "live-dot text-ok")} aria-hidden />
          {/*
            The live region is scoped to this word alone. The age and the
            countdown tick every second, and a wider region made a screen
            reader re-announce them every second. A stale board's age joins
            it: it moves once a minute, and it is the news.
          */}
          <span className="flex items-center gap-2 text-fg" aria-live="polite">
            {isFetching ? (
              "Checking official sources"
            ) : stale ? (
              <>
                <Badge tone="mute">Stale</Badge>
                <span className="text-subtle">
                  last check {Number.isFinite(ageMs) ? formatStaleAge(ageMs) : "unknown"}
                </span>
              </>
            ) : (
              "Live"
            )}
          </span>
          {stale ? null : <span>· last check {age}</span>}
        </p>
        <p>
          Next update <span className="text-fg">{mounted ? formatCountdown(remaining) : "—"}</span>
        </p>
      </div>
      <div className="mt-2 h-0.5 overflow-hidden rounded-full glass-inset">
        <div
          className="h-full origin-left bg-accent/70 transition-transform duration-1000 ease-linear motion-reduce:transition-none"
          style={{ transform: `scaleX(${progress})` }}
        />
      </div>
    </div>
  );
}
