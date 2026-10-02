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
 * One line that wraps between items only: the title and day are one item
 * (`data-release-item`) that never breaks inside, the title giving way to an
 * ellipsis (one clamped line, which can still wrap, so it never widens its
 * card) when it is longer than the line; the day never splits.
 */
export function ReleaseFeedLine({ service }: { service: ServiceSnapshot }) {
  const feed = releaseFeedOf(service);
  const latest = feed?.entries[0];
  if (!feed || !latest) return null;
  const day = releaseDate(latest.release.releasedAt);
  const checkedAt = Date.parse(service.checkedAt);
  return (
    <p data-release-line className="flex flex-wrap items-baseline text-caption text-subtle">
      <span data-release-item className="inline-flex max-w-full min-w-0 items-baseline">
        <span className="line-clamp-1 min-w-0">{latest.title}</span>
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
