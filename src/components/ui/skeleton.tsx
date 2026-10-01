import { cn } from "@/lib/utils";

/** A placeholder while a board loads. Static: nothing on the page shimmers. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg bg-inset", className)} {...props} />;
}
