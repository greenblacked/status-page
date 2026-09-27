import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide uppercase",
  {
    variants: {
      tone: {
        operational: "bg-ok/15 text-ok",
        degraded: "bg-warn/15 text-warn",
        outage: "bg-down/15 text-down",
        maintenance: "bg-accent/12 text-accent",
        unknown: "bg-subtle/15 text-subtle",
        mute: "bg-surface-2 text-muted",
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
