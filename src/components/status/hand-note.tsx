import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A handwritten note, small and a little tilted: "all quiet" when every
 * service is up. The only text in the signature face (Hand), used at most
 * twice on a page and never in body text or a control. Decorative: the words
 * it stands for are in the page's text for a screen reader (the verdict's
 * sr-only line).
 */
export function HandNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block -rotate-2 font-hand text-hand text-accent md:text-hand-lg", className)}
    >
      {children}
    </span>
  );
}
