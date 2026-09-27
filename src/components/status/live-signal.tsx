import type { LiveState } from "@/lib/status/schedule";
import { cn } from "@/lib/utils";

/**
 * The board's live dot. Live, it sends out a slow current of rings; while a
 * check runs it pulses, and on a stale board it stands still. Decorative:
 * the live bar says the same in words.
 */
export function LiveSignal({ state, className }: { state: LiveState; className?: string }) {
  return <span aria-hidden data-state={state} className={cn("live-signal", className)} />;
}
