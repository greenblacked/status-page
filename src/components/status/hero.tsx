import type { MouseEvent, ReactNode } from "react";
import { HandNote } from "@/components/status/hand-note";
import { Dateline } from "@/components/status/local-time";
import { PenUnderline } from "@/components/status/pen";
import { WORDMARK } from "@/lib/status/catalog";
import { serviceAnchor } from "@/lib/status/layout";
import type { ServiceId } from "@/lib/status/types";
import type { Verdict } from "@/lib/status/verdict";
import { cn } from "@/lib/utils";

/**
 * The top of the page. A dateline, the wordmark in the middle and the two icon
 * buttons on the first row; below it the verdict, which is the page's <h1>, and what
 * hangs from it: the services it names (each links to its card), the
 * handwritten "all quiet" when everything is up, and the live line, which
 * sits in the margin on a wide screen and under the verdict on a phone.
 *
 * The count in the headline is underlined by hand once, when it first
 * appears. It is drawn only while something needs a look, and it keeps its
 * place in the tree across a refetch, so the stroke is never drawn twice.
 */
export function Hero({
  generatedAt,
  verdict,
  onReveal,
  controls,
  live,
  children,
}: {
  generatedAt: string;
  verdict: Verdict;
  /** A named service was followed; the board clears its filters first if they hide its card. */
  onReveal: (id: ServiceId, event: MouseEvent<HTMLAnchorElement>) => void;
  /** Alerts and Refresh, icon only. */
  controls: ReactNode;
  /** The live line. */
  live: ReactNode;
  /** The announcement region for results. */
  children?: ReactNode;
}) {
  const [first, ...rest] = verdict.title.split(" ");
  return (
    <header className="page-gutter mx-auto max-w-[62rem] pt-6 pb-4 md:pt-10 md:pb-6">
      {/* Three equal-ended columns from md up: the wordmark is the middle one, so it sits on the header's own centre whatever the dateline or the controls weigh. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 md:grid md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-x-8">
        <p className="text-caption text-muted">
          <Dateline generatedAt={generatedAt} />
        </p>
        <p data-testid="wordmark" className="hidden text-row md:block">
          {WORDMARK}
        </p>
        <div className="-mr-3 flex items-center md:justify-self-end">{controls}</div>
      </div>

      <div className="mt-6 md:mt-8 md:grid md:grid-cols-[var(--margin-col)_minmax(0,1fr)] md:gap-x-8">
        <div className="md:col-start-2 md:row-start-1">
          <h1 id="board-headline" className="text-headline md:text-display">
            {/* Live on the sentence alone. */}
            <span aria-live="polite">
              {verdict.count > 0 ? <PenUnderline>{first}</PenUnderline> : first} {rest.join(" ")}
            </span>
          </h1>
          {verdict.hand ? (
            <>
              <p className="mt-3">
                <HandNote>all quiet</HandNote>
              </p>
              <p className="sr-only">{verdict.srSub}</p>
            </>
          ) : verdict.subParts.length > 0 ? (
            <p
              className={cn(
                "text-body text-muted",
                // Lines 46pt apart on touch, so the links' tap areas never overlap: only where there are links.
                verdict.subParts.some((part) => part.id)
                  ? "hit-lines mt-[calc(0.5rem-var(--hit-lead))] -mb-[var(--hit-lead)] md:mt-[calc(0.75rem-var(--hit-lead))]"
                  : "mt-2 md:mt-3",
              )}
            >
              {verdict.subParts.map((part, at) =>
                part.id ? (
                  <a
                    // biome-ignore lint/suspicious/noArrayIndexKey: the runs never reorder within one render.
                    key={at}
                    href={`#${serviceAnchor(part.id)}`}
                    onClick={(event) => part.id && onReveal(part.id, event)}
                    className="focus-ring hit-extend rounded-sm text-fg underline decoration-subtle underline-offset-4 hover:decoration-fg"
                  >
                    {part.text}
                  </a>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the runs never reorder within one render.
                  <span key={at}>{part.text}</span>
                ),
              )}
            </p>
          ) : null}
        </div>
        <div className="mt-4 md:col-start-1 md:row-start-1 md:mt-3">{live}</div>
      </div>
      {children}
    </header>
  );
}
