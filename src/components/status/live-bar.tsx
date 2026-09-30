import { type ReactNode, useState } from "react";
import { LiveSignal } from "@/components/status/live-signal";
import { LocalTime } from "@/components/status/local-time";
import {
  type Freshness,
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

/** The countdown to the next refetch, "1:52", or a dash until the client clock has mounted. */
export function nextInText(now: number, refetchJitterMs: number): string {
  return now > 0 ? formatCountdown(nextRefetchAt(now, refetchJitterMs) - now) : "—";
}

/**
 * The live line: whether the board is current, when it was last checked and
 * when the next check comes. One quiet sentence in the margin on a wide screen
 * (under the headline on a phone), with the live signal, a ring, in front of
 * it. Only the state word sits in the polite live region: the clock and the
 * countdown tick, and a wider region would have a screen reader read them out
 * every time they moved.
 *
 *   live      "Checked 12:04 CET · next in 1:52" (a screen reader is also told "Live")
 *   checking  "Checking…"
 *   stale     "Stale" and "Last checked 7 min ago."
 *
 * `dial` is the period dial, which only the Full background draws.
 */
export function LiveBar({
  freshness,
  now,
  refetchJitterMs,
  checkedAt,
  dial,
  className,
}: {
  freshness: Freshness;
  now: number;
  /** The board query's jitter, so the countdown ends when its refetch starts. */
  refetchJitterMs: number;
  /** When the snapshot on screen was collected (epoch ms), if it says. */
  checkedAt: number | null;
  dial?: ReactNode;
  className?: string;
}) {
  const { ageMs, state } = freshness;

  return (
    <div data-testid="live-bar" className={cn("flex items-start gap-3", className)}>
      <p className="flex min-w-0 items-start gap-2 text-caption text-muted">
        <LiveSignal state={state} className="mt-[2px]" />
        <span className="min-w-0">
          <span aria-live="polite">
            {state === "checking" ? (
              "Checking…"
            ) : state === "stale" ? (
              <>
                <span className="font-semibold text-fg">Stale</span>.
              </>
            ) : (
              <span className="sr-only">Live</span>
            )}
          </span>
          {state === "stale" ? (
            <> Last checked {now > 0 ? formatStaleAge(ageMs) : "…"}.</>
          ) : state === "live" ? (
            <>
              {" "}
              Checked {checkedAt === null ? "…" : <LocalTime at={checkedAt} />}
              {/* In the margin the countdown takes a line of its own; on a phone it follows a dot. */}
              <span aria-hidden className="md:hidden">
                {" · "}
              </span>
              <span className="md:block">
                next in <span className="text-fg">{nextInText(now, refetchJitterMs)}</span>
              </span>
            </>
          ) : null}
        </span>
      </p>
      {dial}
    </div>
  );
}
