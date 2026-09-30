import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * A tiny label on an inset, for the two things that are not a status:
 * "Changed" and "New release". A status is never a chip: it is a glyph and a
 * coloured word.
 */
export function Tag({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inset inline-flex items-center rounded-sm px-1.5 text-footnote font-semibold text-muted",
        className,
      )}
      {...props}
    />
  );
}
