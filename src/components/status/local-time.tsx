import { useSyncExternalStore } from "react";
import {
  formatAfterHydration,
  formatBeforeHydration,
  formatUtcTitle,
  type LocalTimeFormat,
} from "@/lib/status/local-time";
import { cn } from "@/lib/utils";

const noop = () => () => undefined;

/**
 * False on the server and during the hydrating render, true from the first
 * render after it. It is how a time can be UTC in the server's HTML, keep
 * that through hydration (so React finds what it expects), and then switch to
 * the viewer's own zone.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * A moment as a <time>, in the viewer's own zone once the page has hydrated:
 * "12:04 CEST". The server and the hydrating render show UTC ("10:04 UTC"),
 * because the server cannot know the viewer's zone and must not guess. The
 * `title` is always the whole moment in UTC ("30 Sep 2026 10:04 UTC"), so
 * whoever is reading a screenshot can tell.
 *
 * `reference` is the moment the surrounding text is about (usually the
 * board's own time): an `at` on another day than it gets its date first.
 */
export function LocalTime({
  at,
  reference = at,
  format = "clock",
  className,
}: {
  at: number;
  reference?: number;
  format?: LocalTimeFormat;
  className?: string;
}) {
  const hydrated = useHydrated();
  if (!Number.isFinite(at)) return null;
  const ref = Number.isFinite(reference) ? reference : at;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatUtcTitle(at)} className={cn("tabular-nums", className)}>
      {hydrated ? formatAfterHydration(at, ref, format) : formatBeforeHydration(at, ref, format)}
    </time>
  );
}

/** The board's date line, "Wednesday 30 September": the viewer's own day once hydrated. */
export function Dateline({ generatedAt, className }: { generatedAt: string | number; className?: string }) {
  const at = typeof generatedAt === "number" ? generatedAt : Date.parse(generatedAt);
  return <LocalTime at={at} format="date" className={className} />;
}
