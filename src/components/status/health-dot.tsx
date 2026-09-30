import type { Health } from "@/lib/status/types";
import { cn } from "@/lib/utils";

const DOT: Record<Health, string> = {
  operational: "bg-ok",
  degraded: "bg-warn",
  outage: "bg-down",
  maintenance: "bg-accent",
  unknown: "bg-subtle",
};

/**
 * A small status dot. Decorative: pair it with a text label. `pingColor`
 * "event" sends its ping out in the warm event colour instead of the dot's
 * own, for the one mark on screen that says "look here"; every other ping
 * keeps its tone, so a degraded service still looks degraded.
 */
export function HealthDot({
  health,
  ping = false,
  pingColor = "tone",
  className,
}: {
  health: Health;
  ping?: boolean;
  pingColor?: "tone" | "event";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        DOT[health],
        ping ? cn("ping", pingColor === "event" && "ping-event") : health === "outage" && "animate-pulse",
        className,
      )}
    />
  );
}
