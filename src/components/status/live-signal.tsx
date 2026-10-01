import { STATUS_TEXT, StatusGlyph } from "@/components/status/status-glyph";
import type { LiveState } from "@/lib/status/schedule";
import { cn } from "@/lib/utils";

/**
 * The live line's mark: the operational ring, standing still while the board
 * is live, pulsing while a check runs (and only then), and dashed when the
 * board has gone stale. Decorative: the words beside it say the same.
 */
export function LiveSignal({ state, className }: { state: LiveState; className?: string }) {
  const health = state === "stale" ? "unknown" : "operational";
  return (
    <span
      aria-hidden
      data-state={state}
      className={cn("inline-flex shrink-0", state === "checking" && "live-checking", className)}
    >
      <StatusGlyph health={health} size={14} className={STATUS_TEXT[health]} cut="bg" />
    </span>
  );
}
