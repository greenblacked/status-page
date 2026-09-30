// tokens-allow: rounded-full (the leading dot)
import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/*
  Transitional: a status is a glyph and a coloured word now (StatusGlyph), and
  the two labels that are not a status are a Tag. This survives only for the
  cards that have not moved over yet, and goes with the last of them.

  Colour as a point, not a wash: every badge sits on the same inset fill, and a
  status badge carries its tone only in its text and a small leading dot drawn
  in the text's own colour. The dot is decorative; the word is the status.
*/
const DOT =
  "gap-1.5 pl-2 before:inline-block before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']";

const badgeVariants = cva("inset inline-flex items-center rounded-sm px-1.5 py-0.5 text-footnote font-semibold", {
  variants: {
    tone: {
      operational: cn(DOT, "text-ok"),
      degraded: cn(DOT, "text-warn"),
      outage: cn(DOT, "text-down"),
      maintenance: cn(DOT, "text-muted"),
      unknown: cn(DOT, "text-muted"),
      mute: "text-muted",
    },
  },
  defaultVariants: { tone: "mute" },
});

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
