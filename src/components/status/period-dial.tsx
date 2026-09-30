// tokens-allow: rounded-full (the centre point is a dot)
import { type CSSProperties, useState } from "react";
import { STATUS_TEXT } from "@/components/status/status-glyph";
import { dialTicks } from "@/lib/status/dial";
import { PULSE_INTERVAL_MS, periodPhase } from "@/lib/status/schedule";
import type { Health } from "@/lib/status/types";
import { cn } from "@/lib/utils";

const TICKS = dialTicks();

// Without motion the dial stands still and moves on in steps this long, on
// the board's own one-second render tick.
const STILL_STEP_MS = 5_000;

/**
 * The period dial: one tick per second of the two-minute period between
 * refetches, lighting up as the period runs, with a warm hand at the
 * current moment. Decorative: "Next update" in the live bar says the same
 * in words, from the same period and jitter.
 *
 * The motion is CSS, not a per-second render: a registered custom
 * property fills the sweep in 120 steps and the hand turns on a transform,
 * started at the right point by a negative delay and restarted with each
 * period. With reduced motion both stand still at `--period-at`.
 */
export function PeriodDial({
  now,
  jitterMs,
  tone,
  className,
}: {
  /** The client clock, 0 until mounted. */
  now: number;
  /** The board query's refetch jitter, as the countdown uses it. */
  jitterMs: number;
  /** The headline's tone, for the point at the centre. */
  tone: Health;
  className?: string;
}) {
  const mounted = now > 0;
  const still = mounted ? periodPhase(now, jitterMs, STILL_STEP_MS).progress : 0;
  const phase = mounted ? periodPhase(now, jitterMs) : null;
  const style = { "--period-at": still, "--period-length": `${PULSE_INTERVAL_MS}ms` } as CSSProperties;

  return (
    <div aria-hidden className={cn("period-dial", className)} style={style}>
      <TickRing />
      {/* A new period remounts the motion, so it starts over from empty. */}
      <PeriodMotion key={phase?.endsAt ?? "server"} elapsedMs={phase?.elapsedMs ?? null} />
      <span className="period-lens">
        <span className={cn("block size-1.5 rounded-full bg-current", STATUS_TEXT[tone])} />
      </span>
    </div>
  );
}

function PeriodMotion({ elapsedMs }: { elapsedMs: number | null }) {
  // Fixed for this mount: changing an animation's delay while it runs
  // would move it by the change, not to the new value.
  const [delay] = useState(elapsedMs === null ? null : -elapsedMs);
  return (
    <span
      className="period-motion"
      data-running={delay === null ? undefined : true}
      style={delay === null ? undefined : ({ "--period-delay": `${delay}ms` } as CSSProperties)}
    >
      <span className="period-sweep">
        <TickRing lit />
      </span>
      <span className="period-hand">
        <span className="period-mark" />
      </span>
    </span>
  );
}

function TickRing({ lit = false }: { lit?: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 100"
      className="period-ring"
      data-lit={lit || undefined}
      fill="none"
      focusable="false"
    >
      <circle cx="50" cy="50" r="36" className="period-orbit" vectorEffect="non-scaling-stroke" />
      <path d={TICKS.minor} className="period-tick" vectorEffect="non-scaling-stroke" />
      <path d={TICKS.major} className="period-tick-major" vectorEffect="non-scaling-stroke" />
      <path d={TICKS.quarter} className="period-tick-quarter" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
