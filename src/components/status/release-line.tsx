import type { ReactNode } from "react";
import { ReleaseDay, ReleaseDetails } from "@/components/status/release-details";
import { releaseDate, releaseFeedOf } from "@/lib/status/release-details";
import type { ServiceSnapshot } from "@/lib/status/types";

/**
 * One "Stable 7.21 · Sep 24" on a release tracker's line. It never breaks
 * inside: the line wraps between items, so a date cannot lose its month to the
 * next line ("Sep" / "28").
 */
export function ReleaseItem({ children }: { children: ReactNode }) {
  return (
    <span data-release-item className="whitespace-nowrap">
      {children}
    </span>
  );
}

/**
 * The end of a release line: the last item with "Details ›" (and the Changed
 * tag, when there is one). It moves to the next line whole while it fits, and
 * wraps inside, between the item and the button, only when it is wider than the
 * line itself, so the button is never pushed out of a narrow phone.
 */
export function ReleaseTail({ children }: { children: ReactNode }) {
  return (
    <span data-release-tail className="inline-block max-w-full">
      {children}
    </span>
  );
}

/**
 * The quiet extra line of a status card whose vendor publishes a release
 * feed: the latest entry's title (a version where the vendor numbers its
 * releases) and day, then "Details ›" for the recent entries. Advisory: it is
 * about the vendor's releases, not about whether the service is up, and a card
 * without a feed shows nothing here.
 *
 * It is one row that never wraps, so "Details ›" is always on the item's own
 * line: the title is the only part that gives way (an ellipsis, when it is
 * longer than the line), the day and the button keep their size. The title and
 * day are one item (`data-release-item`), the day never splits, and the whole
 * entry is a tap away in the Details. The title is one clamped line rather
 * than `truncate`, whose unbreakable text would give the row (and the card
 * around it) the width of the whole title when a parent sizes itself to its
 * content.
 */
export function ReleaseFeedLine({ service }: { service: ServiceSnapshot }) {
  const feed = releaseFeedOf(service);
  const latest = feed?.entries[0];
  if (!feed || !latest) return null;
  const day = releaseDate(latest.release.releasedAt);
  const checkedAt = Date.parse(service.checkedAt);
  return (
    <p data-release-line className="flex items-center text-caption text-subtle">
      <span data-release-item className="flex min-w-0 items-baseline">
        <span data-release-title className="line-clamp-1 min-w-0 [overflow-wrap:anywhere]">
          {latest.title}
        </span>
        {day ? (
          <span className="shrink-0 whitespace-pre">
            {" · "}
            <ReleaseDay date={day} reference={Number.isFinite(checkedAt) ? checkedAt : day.at} />
          </span>
        ) : null}
      </span>
      <ReleaseDetails service={service} variant="line" />
    </p>
  );
}
