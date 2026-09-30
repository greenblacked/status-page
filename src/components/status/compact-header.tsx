import { type ReactNode, type RefObject, useEffect, useState, useSyncExternalStore } from "react";
import { HealthDot } from "@/components/status/health-dot";
import { LiveSignal } from "@/components/status/live-signal";
import {
  DOCK_REST,
  type DockGeometry,
  type DockState,
  type DockStore,
  dockFrame,
  dockGeometry,
  PHONE_RANGE,
} from "@/lib/status/dock";
import { keyboardFocus } from "@/lib/status/layout";
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

export function useDockState(store: DockStore): DockState {
  return useSyncExternalStore(store.subscribe, store.get, () => DOCK_REST);
}

/** The width from which the search field shares a row with the filter chips (Tailwind's lg). */
const WIDE = "(min-width: 64rem)";
/**
 * Scroll progress of the search dock (0 in the hero, 1 in the bar). The dock is a
 * position: sticky element, so the browser moves it with the page and pins it in
 * the bar's slot; this only maps the scroll position to --dock (plus the slot
 * geometry) on the dock itself. On a wide screen --dock is also written on
 * `chipsRef`, the filter chips beside the field, which follow it; nothing else
 * reads it, so a write restyles only the field and them. While the move is under
 * way (--dock above 0) the dock (and the chips) carry data-docking, and the dock
 * data-merging while it is part way.
 *
 * Progress comes from window.scrollY against offsets measured when the layout
 * changes, never from a rect read on every frame. Every offset is worked out from
 * `end`, the scroll position at which the field reaches its pin.
 *
 * On a phone the bar is fixed at the top and the field is in the flow, so the
 * bar can come up on its own: at `end` minus the bar's height and PHONE_GAP, when
 * the field is still that far below it. The field then scrolls on up at the
 * page's pace, and over the last PHONE_RANGE px before it pins it merges into
 * the bar (its x and width follow --dock). Nothing is ever pinned over the page
 * without the bar behind it. On a wide screen the field shares its row with the
 * chips, so it is a single move, and the bar comes up 67% of the way through it
 * (only once it is done under Reduce Motion, where the field snaps).
 */
export function useSearchDock({
  hostRef,
  dockRef,
  barRef,
  slotRef,
  chipsRef,
  store,
}: {
  hostRef: RefObject<HTMLElement | null>;
  dockRef: RefObject<HTMLElement | null>;
  barRef: RefObject<HTMLElement | null>;
  slotRef: RefObject<HTMLElement | null>;
  chipsRef: RefObject<HTMLElement | null>;
  store: DockStore;
}): void {
  useEffect(() => {
    const dock = dockRef.current;
    const host = hostRef.current;
    const bar = barRef.current;
    if (!dock || !host || !bar) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const wide = window.matchMedia(WIDE);
    let alive = true;
    let raf = 0;
    let lastP = -1;
    let docking = false;
    let merging = false;
    let state: DockState = DOCK_REST;
    let geometry: DockGeometry = { start: 0, range: PHONE_RANGE, barStart: 0, hysteresis: 8 };
    const measure = () => {
      const hostStyle = getComputedStyle(host);
      const contentTop =
        host.getBoundingClientRect().top +
        window.scrollY +
        (Number.parseFloat(hostStyle.paddingTop) || 0) +
        (Number.parseFloat(hostStyle.borderTopWidth) || 0);
      const dockStyle = getComputedStyle(dock);
      const pin = Number.parseFloat(dockStyle.top) || 10;
      const end = contentTop + (Number.parseFloat(dockStyle.marginTop) || 0) - pin;
      geometry = dockGeometry({
        wide: wide.matches,
        reduce: reduce.matches,
        end,
        pin,
        barTop: Number.parseFloat(getComputedStyle(bar).top) || 8,
        barHeight: bar.offsetHeight,
      });
      const slot = slotRef.current;
      if (!slot) return;
      dock.style.setProperty("--dock-x", `${pageLeft(slot) - pageLeft(dock)}px`);
      dock.style.setProperty("--dock-w", `${slot.offsetWidth}px`);
    };
    const write = (p: number) => {
      const value = String(p);
      dock.style.setProperty("--dock", value);
      const chips = chipsRef.current;
      if (chips && wide.matches) chips.style.setProperty("--dock", value);
      const nextDocking = p > 0;
      const nextMerging = p > 0 && p < 1;
      if (nextDocking !== docking) {
        docking = nextDocking;
        for (const element of [dock, chips]) {
          if (docking) element?.setAttribute("data-docking", "");
          else element?.removeAttribute("data-docking");
        }
      }
      if (nextMerging !== merging) {
        merging = nextMerging;
        if (merging) dock.setAttribute("data-merging", "");
        else dock.removeAttribute("data-merging");
      }
    };
    const frame = () => {
      raf = 0;
      const next = dockFrame(window.scrollY, geometry, reduce.matches, state);
      if (next.p !== lastP) {
        lastP = next.p;
        write(next.p);
      }
      state = { barShown: next.barShown, docked: next.docked };
      store.set(state);
    };
    const schedule = () => {
      if (alive && !raf) raf = requestAnimationFrame(frame);
    };
    const remeasure = () => {
      if (!alive) return;
      measure();
      // Across the wide/phone split the chips' copy of --dock has to come or go.
      if (!wide.matches) chipsRef.current?.style.removeProperty("--dock");
      lastP = -1;
      schedule();
    };
    measure();
    frame();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", remeasure);
    wide.addEventListener("change", remeasure);
    reduce.addEventListener("change", remeasure);
    void document.fonts?.ready.then(remeasure);
    const ro = new ResizeObserver(remeasure);
    ro.observe(dock);
    ro.observe(host);
    // What sits above the body decides where it is: the hero growing or shrinking moves every offset.
    if (host.previousElementSibling) ro.observe(host.previousElementSibling);
    // The slot's own size can stay put while a longer headline moves it, so its row is watched too.
    if (slotRef.current) {
      ro.observe(slotRef.current);
      if (slotRef.current.parentElement) ro.observe(slotRef.current.parentElement);
    }
    return () => {
      alive = false;
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", remeasure);
      wide.removeEventListener("change", remeasure);
      reduce.removeEventListener("change", remeasure);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostRef, dockRef, barRef, slotRef, chipsRef, store]);
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
  store,
  barRef,
  slotRef,
  name,
  live,
  headline,
  children,
}: {
  /** Says when the bar is up; only this component renders when that changes. */
  store: DockStore;
  barRef: RefObject<HTMLElement | null>;
  slotRef: RefObject<HTMLDivElement | null>;
  name: string;
  live: LiveState;
  headline: { tone: Health; title: string };
  /** The controls, rendered by the board so they share its state and handlers. */
  children: ReactNode;
}) {
  const { barShown } = useDockState(store);
  const [heldByKeyboard, setKeyboardFocus] = useState(false);
  const visible = barShown || heldByKeyboard;
  return (
    <section
      ref={barRef}
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
