import { LocalTime } from "@/components/status/local-time";
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
    <section aria-labelledby="recent-heading" className={cn("board-grid", className)}>
      <div className="board-margin">
        <h2 id="recent-heading" className="mb-2 text-caption font-semibold text-muted md:mb-0 md:pt-4">
          Recent changes
        </h2>
        <p className="hidden text-footnote text-subtle md:block">On this device</p>
      </div>

      <div className="board-main">
        {rows.length === 0 ? (
          <p className="surface px-4 py-4 text-body text-muted">Waiting for the first check.</p>
        ) : (
          <ol className="surface card-list">
            {rows.map((row) => (
              <li key={row.key}>
                <div className="row grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 px-4 py-3">
                  <LocalTime at={row.at} format="slot" className="pt-px text-footnote text-muted" />
                  <div className="min-w-0">
                    <p className="text-body text-fg [overflow-wrap:anywhere]">{row.text}</p>
                    <p className="text-caption text-subtle [overflow-wrap:anywhere]">{row.caption}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-footnote text-subtle md:hidden">On this device</p>
      </div>
    </section>
  );
}
