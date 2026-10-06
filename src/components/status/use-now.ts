import { useEffect, useState } from "react";
import { msUntilBoundary } from "@/lib/status/schedule";

/** Past the boundary, so a timer that fires a hair early still reads the new interval. */
const BOUNDARY_CUSHION_MS = 2;

/**
 * The client clock, 0 until mounted, set again every `intervalMs`. A component that calls it renders at that
 * rate, so it belongs in the smallest part of the page that shows the time: the board's cards and sections have
 * no use for a clock that moves every second, and a re-render of all of them every second costs a phone a long
 * task per tick.
 *
 * `aligned` ticks on the wall clock's multiples of the interval (every minute on the minute) instead of
 * `intervalMs` after mounting, so what turns over at a boundary, such as the two-minute slot, turns over on time.
 */
export function useNow(intervalMs = 1000, aligned = false): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!aligned) {
      const tick = () => setNow(Date.now());
      tick();
      const id = window.setInterval(tick, intervalMs);
      return () => window.clearInterval(id);
    }
    let timer = 0;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      timer = window.setTimeout(tick, msUntilBoundary(at, intervalMs) + BOUNDARY_CUSHION_MS);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [intervalMs, aligned]);

  return now;
}
