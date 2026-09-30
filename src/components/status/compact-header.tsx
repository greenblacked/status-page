import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { HealthDot } from "@/components/status/health-dot";
import { LiveSignal } from "@/components/status/live-signal";
import { dockProgress, keyboardFocus } from "@/lib/status/layout";
import type { LiveState } from "@/lib/status/schedule";
import type { Health } from "@/lib/status/types";

/** An element's left edge in the page, from layout alone, so the bar's hidden-pose transform cannot skew it. */
function pageLeft(element: HTMLElement): number {
  let x = 0;
  let node: HTMLElement | null = element;
  while (node) {
    x += node.offsetLeft;
    node = node.offsetParent as HTMLElement | null;
  }
  return x;
}

/**
 * Scroll progress of the search dock (0 in the hero, 1 in the bar). The dock is a
 * position: sticky element, so the browser moves it with the page; this only
 * reads where it is and writes --dock (plus the slot geometry) on it.
 */
export function useSearchDock(
  dockRef: RefObject<HTMLElement | null>,
  slotRef: RefObject<HTMLElement | null>,
  range = 48,
): boolean {
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let lastP = -1;
    let lastDocked = false;
    let stickTop = 10;
    const measure = () => {
      const slot = slotRef.current;
      stickTop = Number.parseFloat(getComputedStyle(dock).top) || 10;
      if (!slot) return;
      dock.style.setProperty("--dock-x", `${pageLeft(slot) - pageLeft(dock)}px`);
      dock.style.setProperty("--dock-w", `${slot.offsetWidth}px`);
    };
    const frame = () => {
      raf = 0;
      const top = dock.getBoundingClientRect().top;
      let p = dockProgress(top, stickTop, range);
      // In the move the geometry is read fresh: a headline that changed length moves the slot without resizing it.
      if (p > 0) measure();
      if (reduce.matches) p = p >= 1 ? 1 : 0;
      p = Math.round(p * 500) / 500;
      if (p !== lastP) {
        lastP = p;
        dock.style.setProperty("--dock", String(p));
      }
      const next = p >= 0.75;
      if (next !== lastDocked) {
        lastDocked = next;
        setDocked(next);
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    measure();
    frame();
    window.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(() => {
      measure();
      schedule();
    });
    ro.observe(dock);
    // The slot's own size can stay put while a longer headline moves it, so its row is watched too.
    if (slotRef.current) {
      ro.observe(slotRef.current);
      if (slotRef.current.parentElement) ro.observe(slotRef.current.parentElement);
    }
    return () => {
      window.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [dockRef, slotRef, range]);
  return docked;
}

/**
 * The floating control bar: the board's name, its live signal and
 * headline, and the same Alerts and Refresh controls as the hero, shown
 * once the hero has scrolled away. The one chrome surface on the page.
 *
 * Hidden, it is `inert`, so Tab never lands on a control nobody can see
 * and the skip link stays the first stop. It stays put while keyboard
 * focus is inside it, so scrolling back up never pulls focus out from
 * under a keyboard user. Focus from a click does not hold it: Chromium
 * and Firefox focus a clicked button, and the bar would then sit over the
 * hero's own controls after scrolling back to the top.
 */
export function CompactHeader({
  shown,
  slotRef,
  name,
  live,
  headline,
  children,
}: {
  shown: boolean;
  slotRef: RefObject<HTMLDivElement | null>;
  name: string;
  live: LiveState;
  headline: { tone: Health; title: string };
  /** The controls, rendered by the board so they share its state and handlers. */
  children: ReactNode;
}) {
  const [heldByKeyboard, setKeyboardFocus] = useState(false);
  const visible = shown || heldByKeyboard;
  return (
    <section
      aria-label="Board controls"
      data-shown={visible}
      inert={!visible}
      onFocus={(event) => setKeyboardFocus(keyboardFocus(event.target))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false);
      }}
      className="compact-header glass-chrome flex h-12 items-center gap-3 rounded-full pr-1.5 pl-4"
    >
      <p className="flex shrink-0 items-center gap-2 text-sm font-medium tracking-[-0.01em]">
        <LiveSignal state={live} />
        <span className="max-sm:sr-only">{name}</span>
      </p>
      {/* The headline again, where there is room for it. */}
      <p className="hidden min-w-0 items-center gap-2 text-sm text-muted sm:flex">
        <span aria-hidden className="text-subtle">
          ·
        </span>
        <HealthDot health={headline.tone} />
        <span className="truncate">{headline.title}</span>
      </p>
      <div className="flex min-w-0 flex-1 justify-center" aria-hidden>
        <div ref={slotRef} className="h-11 w-full max-w-[26rem]" />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </section>
  );
}
