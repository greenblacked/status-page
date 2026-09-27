import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { HealthDot } from "@/components/status/health-dot";
import { LiveSignal } from "@/components/status/live-signal";
import { scrolledPast } from "@/lib/status/layout";
import type { LiveState } from "@/lib/status/schedule";
import type { Health } from "@/lib/status/types";

/**
 * Whether `target` has scrolled up out of view. False on the server and
 * until the observer first reports, so the first client render matches
 * the server's. `topInset` is how far down the viewport a floating bar
 * covers: content under it counts as gone.
 */
export function useScrolledPast(target: RefObject<HTMLElement | null>, topInset = 64): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setPast(scrolledPast(entry, topInset));
      },
      { rootMargin: `-${topInset}px 0px 0px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, topInset]);
  return past;
}

/**
 * The floating control bar: the board's name, its live signal and
 * headline, and the same Alerts and Refresh controls as the hero, shown
 * once the hero has scrolled away. The one chrome surface on the page.
 *
 * Hidden, it is `inert`, so Tab never lands on a control nobody can see
 * and the skip link stays the first stop. It stays put while focus is
 * inside it, so scrolling back up never pulls focus out from under a
 * keyboard user.
 */
export function CompactHeader({
  shown,
  name,
  live,
  headline,
  children,
}: {
  shown: boolean;
  name: string;
  live: LiveState;
  headline: { tone: Health; title: string };
  /** The controls, rendered by the board so they share its state and handlers. */
  children: ReactNode;
}) {
  const [focusWithin, setFocusWithin] = useState(false);
  const visible = shown || focusWithin;
  return (
    <section
      aria-label="Board controls"
      data-shown={visible}
      inert={!visible}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
      className="compact-header glass-chrome flex h-12 items-center gap-3 rounded-full pr-1.5 pl-4"
    >
      <p className="flex shrink-0 items-center gap-2 text-sm font-medium tracking-[-0.01em]">
        <LiveSignal state={live} />
        {name}
      </p>
      {/* The headline again, where there is room for it. */}
      <p className="hidden min-w-0 items-center gap-2 text-sm text-muted sm:flex">
        <span aria-hidden className="text-subtle">
          ·
        </span>
        <HealthDot health={headline.tone} />
        <span className="truncate">{headline.title}</span>
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">{children}</div>
    </section>
  );
}
