import { Radio } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  type Freshness,
  formatAge,
  formatCountdown,
  formatStaleAge,
  freshnessOf,
  nextRefetchAt,
  noteSnapshot,
  type SnapshotSeen,
} from "@/lib/status/schedule";
import { cn } from "@/lib/utils";

/**
 * Tracks the snapshot on screen. Timed by this browser's clock alone, from
 * when the board first showed this snapshot: `checkedAt` is the server's
 * clock, and the two need not agree. Updated while rendering, not in an
 * effect, so the render that brings a new snapshot never shows the old
 * one's age, or a false Stale. Call it once per board, in the component
 * that owns the board, and pass the result down.
 */
export function useFreshness(checkedAt: string, isFetching: boolean, now: number): Freshness {
  const [seen, setSeen] = useState<SnapshotSeen | null>(null);
  const noted = noteSnapshot(seen, checkedAt, now);
  if (noted !== seen) setSeen(noted);
  return freshnessOf(noted, isFetching, now);
}

/**
 * The freshness strip at the foot of the summary panel. Its countdown is the
 * period dial's accessible value: the dial beside the counts is decorative.
 */
export function LiveBar({
  freshness,
  isFetching,
  now,
  refetchJitterMs,
  className,
}: {
  freshness: Freshness;
  isFetching: boolean;
  now: number;
  /** The board query's jitter, so the countdown ends when its refetch starts. */
  refetchJitterMs: number;
  className?: string;
}) {
  const mounted = now > 0;
  const remaining = mounted ? nextRefetchAt(now, refetchJitterMs) - now : 0;
  const { ageMs, stale } = freshness;
  const age = mounted ? formatAge(ageMs) : "…";

  return (
    <div data-testid="live-bar" className={className}>
      {/*
        Two rows on a phone in every state. One row that wrapped only when a
        state ran long ("Checking official sources") made the strip, and
        everything under it, jump by a line each time a check began.
      */}
      <div className="flex flex-col gap-y-1 font-mono text-[11px] tabular-nums text-subtle sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4">
        <p className="flex items-center gap-2">
          <Radio className={cn("size-3.5", isFetching || stale ? "text-muted" : "live-dot text-ok")} aria-hidden />
          {/*
            The live region is scoped to this word alone. The age and the
            countdown tick, and a wider region made a screen reader
            re-announce them every time they moved, a stale board's age
            once a minute for as long as it stayed stale.
          */}
          <span className="flex items-center gap-2 text-fg" aria-live="polite">
            {isFetching ? (
              <span>
                Checking<span className="sm:hidden">…</span>
                <span className="max-sm:sr-only"> official sources</span>
              </span>
            ) : stale ? (
              <Badge tone="mute">Stale</Badge>
            ) : (
              "Live"
            )}
          </span>
          {stale ? <span>last check {formatStaleAge(ageMs)}</span> : <span>· last check {age}</span>}
        </p>
        <p>
          Next update <span className="text-fg">{mounted ? formatCountdown(remaining) : "—"}</span>
        </p>
      </div>
    </div>
  );
}
