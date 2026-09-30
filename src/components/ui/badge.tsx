import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/*
  Colour as a point, not a wash: every badge sits on the same neutral fill,
  and a status badge carries its tone only in its text and a small leading
  dot drawn in the text's own colour. The dot is decorative; the word is
  the status.
*/
const DOT =
  "gap-1.5 pl-2 before:inline-block before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']";

const badgeVariants = cva(
  "inline-flex items-center rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium tracking-wide uppercase",
  {
    variants: {
      tone: {
        operational: cn(DOT, "text-ok"),
        degraded: cn(DOT, "text-warn"),
        outage: cn(DOT, "text-down"),
        maintenance: cn(DOT, "text-accent"),
        // Muted text, not subtle: subtle on the neutral fill sits too close to the 4.5:1 floor.
        unknown: cn(DOT, "text-muted"),
        mute: "text-muted",
      },
    },
    defaultVariants: { tone: "mute" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
