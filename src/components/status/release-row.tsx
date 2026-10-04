// tokens-allow: rounded-full (the accent dot on a fresh release)
import { Tag as TagIcon } from "lucide-react";
import { Fragment } from "react";
import { ReleaseDetails } from "@/components/status/release-details";
import { ReleaseItem, ReleaseNote, ReleaseTail } from "@/components/status/release-line";
import type { ServiceCardProps } from "@/components/status/service-card-shared";
import { ChangedTag, ROW_LEAD, RowFrame, RowHeader } from "@/components/status/service-row";
import { Tag } from "@/components/ui/tag";
import type { ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

/** How many versions the line under a release tracker's name shows. */
const MAX_VERSIONS = 2;

/**
 * Whether a tracker has a release from the last two weeks: the collectors mark
 * the fresh channel on its component row (or the feed itself).
 */
export function hasFreshRelease(service: ServiceSnapshot): boolean {
  return service.health === "maintenance" || service.components.some((component) => component.health === "maintenance");
}

/**
 * The newest versions a tracker lists, "Stable 7.21 · Sep 24" and the next,
 * a fresh channel first; "No new release" when it lists none. The collectors
 * put the channel in the component's name and the version in its detail.
 */
export function releaseLine(service: ServiceSnapshot): string {
  return releaseItems(service).join(" · ");
}

/** The items of that line, "Stable 7.21 · Sep 24" each, which the row keeps whole when it wraps. */
export function releaseItems(service: ServiceSnapshot): string[] {
  return releaseParts(service).map((part) => part.item);
}

/** One item of the line, with the short note on that release (the vendor's own data) when it has one. */
export type ReleasePart = { item: string; note?: string };

/**
 * The line's items each with its note: "7.21beta4 · Sep 19" and "23 changes: bgp, wifi, container +9 more". A release
 * the collector gave no note for (a changelog not read yet, a build the page lists no update type for) has none,
 * and its item is exactly what it was.
 */
export function releaseParts(service: ServiceSnapshot): ReleasePart[] {
  const parts = service.components
    .filter((component) => component.detail)
    .sort((a, b) => Number(b.health === "maintenance") - Number(a.health === "maintenance"))
    .slice(0, MAX_VERSIONS)
    .map((component): ReleasePart => {
      const note = component.release?.note?.text;
      const item = `${component.name} ${component.detail}`;
      return typeof note === "string" && note.trim() !== "" ? { item, note: note.trim() } : { item };
    });
  return parts.length > 0 ? parts : [{ item: "No new release" }];
}

/**
 * A note as the row prints it: the " · " inside it (before "2 important") is joined to the word before it, so a
 * wrapped line never starts with a stray dot. Plain text.
 */
function rowNote(note: string): string {
  return note.replaceAll(" · ", "\u00a0· ");
}

/**
 * A release tracker in the compact list. A changelog has no operational
 * state, so it wears a tag icon instead of a status glyph, and no status word:
 * its line is the newest versions, and a release from the last two weeks says
 * "New release" in a tag with an accent dot. Unreadable or in-maintenance
 * trackers are never rows here (they are unread rows and attention cards).
 * Its Changed bar says what changed: a new release (`released`: versions that
 * moved from known versions) is not a recovery, so it keeps the neutral accent;
 * a source that came back from unread, or with the same versions, gets the
 * green of its state.
 */
export function ReleaseRow({ service, emphasized, released, starred, onToggleStar }: ServiceCardProps) {
  const fresh = hasFreshRelease(service);
  const parts = releaseParts(service);
  const last = parts[parts.length - 1];
  return (
    <RowFrame
      service={service}
      emphasized={emphasized}
      starred={starred}
      onToggleStar={onToggleStar}
      bar={released ? "after:bg-accent" : undefined}
      lead={<TagIcon aria-hidden strokeWidth={1.7} className={cn("block size-5 text-subtle", ROW_LEAD)} />}
    >
      <div className="flex min-h-(--row-h) min-w-0 items-center">
        <RowHeader name={service.name} className="relative">
          {fresh ? (
            <Tag className="mr-1.5 gap-1.5 text-fg">
              <span aria-hidden className="size-1.5 rounded-full bg-accent" />
              New release
            </Tag>
          ) : null}
          {/* The line wraps between items, never inside one, and "Details" stays with the last. A release's note
              follows its item and wraps like text, so on a phone it sits under the version. */}
          {parts.slice(0, -1).map((part, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two versions can read alike; the index only breaks that tie.
            <Fragment key={at}>
              <ReleaseItem>{part.item} ·</ReleaseItem>{" "}
              {part.note ? <ReleaseNote>{rowNote(part.note)}&nbsp;·</ReleaseNote> : null}
              {part.note ? " " : null}
            </Fragment>
          ))}
          <ReleaseTail>
            <ReleaseItem>
              {last.item}
              {last.note ? " ·" : null}
            </ReleaseItem>
            {last.note ? (
              <>
                {" "}
                <ReleaseNote>{rowNote(last.note)}</ReleaseNote>
              </>
            ) : null}
            {emphasized ? (
              <>
                {" "}
                <ChangedTag />
              </>
            ) : null}{" "}
            <ReleaseDetails service={service} variant="inline" />
          </ReleaseTail>
        </RowHeader>
      </div>
    </RowFrame>
  );
}
