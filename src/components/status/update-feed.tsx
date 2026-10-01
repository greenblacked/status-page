import { LocalTime } from "@/components/status/local-time";
import { FEED_RESERVE_SCRIPT, FEED_ROW_CLASSES } from "@/lib/status/feed-reserve";
import type { Pulse } from "@/lib/status/pulse";
import { recentRows } from "@/lib/status/recent";
import { cn } from "@/lib/utils";

/**
 * The last few checks of this browser, newest first: what changed, and how
 * many services were up. It is a log of this device (the pulses live in local
 * storage), and says so. A run of checks with nothing changed is one row.
 * The heading and its note sit in the margin column on wide screens.
 */
export function UpdateFeed({ pulses, className }: { pulses: Pulse[]; className?: string }) {
  const rows = recentRows(pulses);

  return (
    // Never the scroll anchor: it sits in view under Needs a look, and when a search empties the sections above it
    // the browser would scroll up to keep it in place, out from under a field that is docked in the bar.
    <section
      data-no-anchor=""
      aria-labelledby="recent-heading"
      className={cn("board-grid [overflow-anchor:none]", className)}
    >
      <div className="board-margin">
        <h2 id="recent-heading" className="mb-2 text-caption font-semibold text-muted md:mb-0 md:pt-4">
          Recent changes
        </h2>
        <p className="hidden text-footnote text-subtle md:block">On this device</p>
      </div>

      <div className="board-main">
        {/*
          One surface in both states, so the node (and the light the page seeds
          on it) survives the saved checks arriving after hydration. Until they
          load, its height is held by --feed-reserve, which the script after it
          measures from the saved checks (feed-reserve.ts) and sets on this
          element's style. React renders no style here and never diffs one it
          does not own, so the script's property is left alone after
          hydration; suppressHydrationWarning only quiets development's
          check for an attribute the server did not render.
        */}
        <div
          suppressHydrationWarning
          className={cn("surface spotlight card-list", rows.length === 0 && "min-h-[var(--feed-reserve,0px)]")}
        >
          {rows.length === 0 ? (
            <p className="px-4 py-4 text-body text-muted">Waiting for the first check.</p>
          ) : (
            <ol>
              {rows.map((row) => (
                <li key={row.key}>
                  <div className={FEED_ROW_CLASSES.row}>
                    <LocalTime at={row.at} format="slot" className={FEED_ROW_CLASSES.time} />
                    <div className={FEED_ROW_CLASSES.body}>
                      <p className={FEED_ROW_CLASSES.title}>{row.text}</p>
                      <p className={FEED_ROW_CLASSES.caption}>{row.caption}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        {/* Right after the surface: the script measures the element before it. Only while empty, as it is only then needed. */}
        {rows.length === 0 ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant of ours, built from no input.
          <script dangerouslySetInnerHTML={{ __html: FEED_RESERVE_SCRIPT }} />
        ) : null}
        <p className="mt-2 text-footnote text-subtle md:hidden">On this device</p>
      </div>
    </section>
  );
}
