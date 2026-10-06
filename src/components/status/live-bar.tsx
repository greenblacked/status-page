import { type ReactNode, useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { LiveSignal } from "@/components/status/live-signal";
import { LocalTime } from "@/components/status/local-time";
import { useNow } from "@/components/status/use-now";
import {
  type Freshness,
  formatCountdown,
  formatStaleAge,
  freshnessOf,
  nextRefetchAt,
  noteSnapshot,
  type SnapshotSeen,
  STALE_AFTER_MS,
} from "@/lib/status/schedule";
import { cn } from "@/lib/utils";

/**
 * Tracks the snapshot on screen. Timed by this browser's clock alone, from
 * when the board first showed this snapshot: `checkedAt` is the server's
 * clock, and the two need not agree. Updated while rendering, not in an
 * effect, so the render that brings a new snapshot never shows the old
 * one's age, or a false Stale. Call it once per board, in the component
 * that owns the board, and pass the result down.
 *
 * `now` only says whether the client clock has started (0 until it has) and
 * may be as coarse as a minute: the moments that matter are read from the
 * clock itself, and the hook schedules its own render for them, when the
 * snapshot turns Stale and then each minute the age of its last check grows
 * by, so the board does not need a clock that ticks every second for this.
 */
export function useFreshness(checkedAt: string, isFetching: boolean, now: number): Freshness {
  const [seen, setSeen] = useState<SnapshotSeen | null>(null);
  const [due, renderAgain] = useReducer((count: number) => count + 1, 0);
  const at = now > 0 ? Date.now() : 0;
  const noted = noteSnapshot(seen, checkedAt, at);
  if (noted !== seen) setSeen(noted);
  const freshness = freshnessOf(noted, isFetching, at);
  const seenAt = noted?.seenAt ?? 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `due` is the trigger, not an input: each render it asks for sets the next one.
  useEffect(() => {
    if (seenAt <= 0 || isFetching) return;
    const age = Date.now() - seenAt;
    const wait = age <= STALE_AFTER_MS ? STALE_AFTER_MS - age + 1 : 60_000 - (age % 60_000) + 1;
    const timer = window.setTimeout(renderAgain, wait);
    return () => window.clearTimeout(timer);
  }, [seenAt, isFetching, due]);

  return freshness;
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
              {/* In the margin the countdown takes a line of its own, and its first letter is a capital; on a phone it follows a dot. */}
              <span aria-hidden className="md:hidden">
                {" · "}
              </span>
              <span className="md:block md:first-letter:uppercase">
                next in <span className="tabular-nums text-fg">{nextInText(now, refetchJitterMs)}</span>
              </span>
            </>
          ) : null}
        </span>
      </p>
      {dial}
    </div>
  );
}

/**
 * The live line with its own one-second clock: the countdown is the only part of the board that shows seconds
 * on every screen, and only this component re-renders for it.
 */
export function ClockedLiveBar(props: Omit<Parameters<typeof LiveBar>[0], "now">) {
  return <LiveBar {...props} now={useNow(1000, true)} />;
}

/** The width from which the floating bar shows its countdown; below it the text is for screen readers only. */
const BAR_TEXT_QUERY = "(min-width: 40rem)";

/** How often the floating bar's countdown moves where nobody can see it: a phone's screen-reader-only copy. */
const HIDDEN_TICK_MS = 10_000;

function subscribeBarText(onChange: () => void): () => void {
  const list = window.matchMedia(BAR_TEXT_QUERY);
  // MediaQueryList is an EventTarget from iOS 14; before it, addListener is all there is.
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }
  list.addListener(onChange);
  return () => list.removeListener(onChange);
}

/**
 * Whether the floating bar is wide enough to draw its text and the day/night switch (from 640px). Below that the bar
 * leaves the switch out to keep its width for the verdict, so the hero's copy stays the one in reach. True on the
 * server, as for the countdown, which only decides what the bar draws once it is up.
 */
export function useBarWide(): boolean {
  return useSyncExternalStore(
    subscribeBarText,
    () => window.matchMedia(BAR_TEXT_QUERY).matches,
    () => true,
  );
}

/**
 * The floating bar's countdown, "1:52", with its own clock. From 640px it is on screen and ticks every second;
 * below that it is read only by screen readers, in a text that is not a live region, so a tick every ten seconds
 * keeps it true enough to be read at any moment and costs the phone nothing between.
 */
export function NextIn({ refetchJitterMs }: { refetchJitterMs: number }) {
  const shown = useBarWide();
  return nextInText(useNow(shown ? 1000 : HIDDEN_TICK_MS, true), refetchJitterMs);
}
