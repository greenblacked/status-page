// tokens-allow: rounded-full (the accent dot on a fresh release)
import { ArrowUpRight, ChevronRight, X } from "lucide-react";
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LocalTime } from "@/components/status/local-time";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { formatUtcDay } from "@/lib/status/local-time";
import {
  hasReleaseDetails,
  type ReleaseDate,
  type ReleaseEntry,
  releaseEntries,
  releaseSource,
} from "@/lib/status/release-details";
import type { ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

/** A release's day: in the viewer's zone for a moment, the UTC day for a source that gave only a day. */
export function ReleaseDay({ date, reference }: { date: ReleaseDate; reference: number }) {
  if (!date.dayOnly) return <LocalTime at={date.at} reference={reference} format="day" />;
  return <time dateTime={new Date(date.at).toISOString().slice(0, 10)}>{formatUtcDay(date.at, reference)}</time>;
}

/** What one channel, OS or version says about itself: its facts on one line, then its notes, then its link. */
function Entry({ entry, service, reference }: { entry: ReleaseEntry; service: ServiceSnapshot; reference: number }) {
  // A tracker's own name, or the name of the vendor feed a status card's entries come from.
  const source = releaseSource(service);
  // " · " between the facts a release has, and not before the first.
  let shown = 0;
  const lead = () => (shown++ > 0 ? " · " : null);
  const hasFacts = Boolean(entry.version || entry.build || entry.releasedAt || entry.updatedAt);
  return (
    <li data-release-entry className="inset rounded-md px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 text-caption font-semibold text-fg [overflow-wrap:anywhere]">{entry.name}</h3>
        {entry.fresh ? (
          <Tag className="shrink-0 gap-1.5 text-fg">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            New release
          </Tag>
        ) : null}
      </div>
      {hasFacts ? (
        <p className="mt-0.5 text-footnote text-muted [overflow-wrap:anywhere]">
          {entry.version ? (
            <>
              {lead()}
              <span className="text-fg">{entry.version}</span>
            </>
          ) : null}
          {entry.build ? (
            <>
              {lead()}build {entry.build}
            </>
          ) : null}
          {entry.releasedAt ? (
            <>
              {lead()}
              <ReleaseDay date={entry.releasedAt} reference={reference} />
            </>
          ) : null}
          {entry.updatedAt ? (
            <>
              {lead()}updated <ReleaseDay date={entry.updatedAt} reference={reference} />
            </>
          ) : null}
        </p>
      ) : null}
      {entry.notes.length > 0 ? (
        <ul
          aria-label="Changes"
          className="mt-2 flex list-disc flex-col gap-1 pl-4 text-footnote text-muted marker:text-subtle"
        >
          {entry.notes.map((note, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a changelog can repeat a line; the index only breaks that tie.
            <li key={at} className="[overflow-wrap:anywhere]">
              {note}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-footnote text-subtle">No notes text from {source.name}.</p>
      )}
      <a
        href={entry.url}
        target="_blank"
        rel="noreferrer"
        className="focus-ring pressable mt-1 inline-flex min-h-8 items-center gap-1 rounded-md text-footnote text-accent pointer-coarse:min-h-11"
      >
        {entry.own ? (entry.linkLabel ?? "Release page") : source.name}
        <span className="sr-only">
          {" "}
          for {entry.name}
          {entry.version ? ` ${entry.version}` : ""}
        </span>
        <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
      </a>
    </li>
  );
}

/**
 * A release tracker's Details, or a status card's list of its vendor's latest
 * release or changelog entries, in a native modal <dialog> like Settings: it
 * traps focus, closes on Escape, and a click on the dimmed backdrop closes it.
 * It lists every channel, OS or version the tracker holds, not only the two
 * its row names: the version and build, the day it came out, "New release"
 * while it is fresh, a short changelog where the vendor's source has one, and
 * a link to the vendor's notes. A source with no notes text says so.
 *
 * It mounts open (the parent renders it only while it is open) and calls
 * `onClose` however it closes. On a phone it is a sheet from the bottom edge,
 * elsewhere a small centred panel (styles.css). The title and the close button
 * stay put and the list scrolls under them.
 *
 * It belongs to the card that opened it: if a refresh moves the tracker to
 * another list (it could not be read, or needs a look) while the pop-up is
 * open, that card unmounts and takes the pop-up with it, and focus falls to
 * the page. A tracker that cannot be read has no versions to show anyway, and
 * a refresh is a few seconds apart from a person opening Details, so the
 * board does not hold the open pop-up above the cards.
 */
export function ReleaseDetailsDialog({ service, onClose }: { service: ServiceSnapshot; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Whether the press that began this click began on the backdrop too.
  const pressedBackdrop = useRef(false);
  const headingId = useId();
  const entries = releaseEntries(service);
  const checkedAt = Date.parse(service.checkedAt);
  const reference = Number.isFinite(checkedAt) ? checkedAt : Date.now();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only catches the backdrop; Esc closes a modal <dialog> natively.
    <dialog
      ref={ref}
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, not its content. It counts only when the press began
      // there as well, so a text selection dragged from the panel and let go over the backdrop closes nothing.
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const outside = pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (outside) onClose();
      }}
      aria-labelledby={headingId}
      aria-modal="true"
      data-release-details
      className="details-dialog bg-transparent p-0 text-fg backdrop:bg-bg/70"
    >
      <div className="sheet p-5 sm:p-6">
        <div className="flex shrink-0 items-center justify-between gap-4">
          <h2 id={headingId} className="min-w-0 text-card text-balance">
            Details<span className="text-muted"> · {service.name}</span>
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="-my-2 -mr-2 shrink-0"
            onClick={onClose}
            aria-label={`Close details for ${service.name}`}
          >
            <X />
          </Button>
        </div>
        <ul
          aria-label="Releases"
          className="-mx-1 mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain px-1 pb-1"
        >
          {entries.map((entry, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a tracker can list two channels under one name; the index only breaks that tie.
            <Entry key={`${entry.name}-${at}`} entry={entry} service={service} reference={reference} />
          ))}
        </ul>
      </div>
    </dialog>
  );
}

/**
 * A pointer's way into a card's Details from its name and line, for the card layout where the button sits in the
 * footer and cannot stretch over the header: the click goes on to the button, which keyboards and screen readers
 * use directly. A click that ends a text selection opens nothing.
 */
export function openDetailsFromCard(event: MouseEvent<HTMLElement>): void {
  if (window.getSelection()?.isCollapsed === false) return;
  event.currentTarget.closest("article")?.querySelector<HTMLButtonElement>("[data-release-details-trigger]")?.click();
}

/**
 * The "Details" button of a release tracker or of a status card with a release
 * feed, and the pop-up it opens; nothing for a service that has nothing to show. In a row (`inline`) the button sits
 * at the end of the row's line and a pseudo-element stretches its hit area over
 * the row's header (the nearest positioned ancestor, which the row makes), so a
 * click on the name or the line opens it too, while the star and the
 * open-in-new-tab link beside it keep their own targets. The button is the one
 * thing Tab reaches, and Enter or Space opens it. In a card (`button`) it is a
 * plain 44px link-style button, and on a status card's release line (`line`) a
 * small button of its own, with no reach over the row. Focus goes back to the button when the pop-up
 * closes, because not every browser (Safari) focuses a button on click and
 * restores it by itself.
 */
export function ReleaseDetails({
  service,
  variant,
}: {
  service: ServiceSnapshot;
  variant: "inline" | "line" | "button";
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  if (!hasReleaseDetails(service)) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-release-details-trigger
        className={cn(
          "focus-ring inline-flex cursor-pointer items-center gap-0.5 rounded-md text-caption text-accent",
          variant === "inline" && "ml-1 align-baseline after:absolute after:inset-0 after:content-['']",
          // On a status card the button stays its own target: the row around it opens the components, not Details.
          variant === "line" && "ml-1 min-h-6",
          variant === "button" && "pressable min-h-11 text-caption",
        )}
      >
        Details
        <span className="sr-only"> for {service.name}</span>
        <ChevronRight className="size-3.5 shrink-0" aria-hidden />
      </button>
      {/* On <body>, not inside the row: a <dialog> may not sit in the row's <p>, and nothing of the row's layout reaches it. */}
      {open
        ? createPortal(<ReleaseDetailsDialog service={service} onClose={() => setOpen(false)} />, document.body)
        : null}
    </>
  );
}
