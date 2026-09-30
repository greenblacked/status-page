import type { ReactNode } from "react";
import { LOOP_PATHS, LOOP_VIEW_BOX, UNDERLINE_PATH, UNDERLINE_VIEW_BOX } from "@/components/status/pen-marks";
import { cn } from "@/lib/utils";

/**
 * The hand: a pen mark in blue-black ink, a little uneven, used with extreme
 * restraint. One stroke under the count in the headline, and a loop round any
 * service in outage. Everything else on the page is exact; this alone is
 * alive. Decorative (aria-hidden) and drawn from constants (pen-marks.ts), so
 * the server and the browser print the same path.
 */

/**
 * Wraps the word it underlines, usually the count in the headline ("Two").
 * The stroke draws itself once, left to right, when this mounts (.pen-underline
 * in styles.css); the element keeps its key on a refetch, so it never redraws.
 */
export function PenUnderline({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("relative inline-block", className)}>
      {children}
      <svg
        aria-hidden
        focusable="false"
        viewBox={UNDERLINE_VIEW_BOX}
        preserveAspectRatio="none"
        className="pen-underline pointer-events-none absolute inset-x-0 -bottom-1 h-2 w-full overflow-visible text-accent"
      >
        <path d={UNDERLINE_PATH} fill="currentColor" />
      </svg>
    </span>
  );
}

/** How many hands the loop has: two outages side by side are not the same stroke twice. */
export const LOOP_HANDS = LOOP_PATHS.length;

/**
 * A loop round a 22px status glyph, a 38px box centred on it. Place it inside
 * a `relative` wrapper that holds the glyph; it fades and settles in over 250ms
 * when it mounts.
 */
export function PenLoop({ seed = 0, className }: { seed?: 0 | 1 | 2; className?: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox={LOOP_VIEW_BOX}
      className={cn(
        "pen-loop pointer-events-none absolute -top-2 -left-2 size-[38px] max-w-none overflow-visible text-accent",
        className,
      )}
    >
      <path d={LOOP_PATHS[seed % LOOP_HANDS]} fill="currentColor" />
    </svg>
  );
}
