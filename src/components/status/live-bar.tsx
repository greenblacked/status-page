import { Radio } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  formatAge,
  formatCountdown,
  formatStaleAge,
  isStale,
  type LiveState,
  liveState,
  nextRefetchAt,
  noteSnapshot,
  PULSE_INTERVAL_MS,
  type SnapshotSeen,
} from "@/lib/status/schedule";
import { cn } from "@/lib/utils";

/** How fresh the board on screen is, shared by the live bar and the live signals. */
export type Freshness = {
  /** Timed by this browser's clock, from when it first showed this snapshot. */
  ageMs: number;
  stale: boolean;
  state: LiveState;
};

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
  const seenAt = noted?.seenAt ?? 0;
  // A check in flight may yet bring it back, so it is not called stale while one runs.
  const stale = !isFetching && isStale(seenAt, now);
  return { ageMs: now - seenAt, stale, state: liveState(isFetching, stale) };
}

/** The freshness strip at the foot of the summary panel. */
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
  const progress = mounted ? Math.min(1, Math.max(0, 1 - remaining / PULSE_INTERVAL_MS)) : 0;
  const { ageMs, stale } = freshness;
  const age = mounted ? formatAge(ageMs) : "…";

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-subtle">
        <p className="flex items-center gap-2">
          <Radio className={cn("size-3.5", isFetching || stale ? "text-muted" : "live-dot text-ok")} aria-hidden />
          {/*
            The live region is scoped to this word alone. The age and the
            countdown tick, and a wider region made a screen reader
            re-announce them every time they moved, a stale board's age
            once a minute for as long as it stayed stale.
          */}
          <span className="flex items-center gap-2 text-fg" aria-live="polite">
            {isFetching ? "Checking official sources" : stale ? <Badge tone="mute">Stale</Badge> : "Live"}
          </span>
          {stale ? <span>last check {formatStaleAge(ageMs)}</span> : <span>· last check {age}</span>}
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
