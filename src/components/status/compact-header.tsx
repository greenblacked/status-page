import { type ReactNode, type RefObject, useEffect, useState, useSyncExternalStore } from "react";
import { HealthDot } from "@/components/status/health-dot";
import { LiveSignal } from "@/components/status/live-signal";
import { barShownAt, dockProgress, keyboardFocus } from "@/lib/status/layout";
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

/** What the search dock has reached, for the few parts of the page that change with it. */
export type DockState = {
  /** The floating bar is up (phase one on a phone, most of the move on a wide screen). */
  barShown: boolean;
  /** The field is fully in the bar. Part way, it keeps whatever it was. */
  docked: boolean;
};

/**
 * Where the dock keeps those two discrete states. A store outside React, read
 * with useDockState, so that the board (which holds every card) does not
 * render when the bar comes up: only the bar, the hero's two buttons and the
 * field's placeholder do.
 */
export type DockStore = {
  get: () => DockState;
  subscribe: (listener: () => void) => () => void;
  set: (next: DockState) => void;
};

const DOCK_REST: DockState = { barShown: false, docked: false };

export function createDockStore(): DockStore {
  let state = DOCK_REST;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      if (next.barShown === state.barShown && next.docked === state.docked) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export function useDockState(store: DockStore): DockState {
  return useSyncExternalStore(store.subscribe, store.get, () => DOCK_REST);
}

/** The width from which the search field shares a row with the filter chips (Tailwind's lg). */
const WIDE = "(min-width: 64rem)";
/** On a phone: the scrolling, in px, between the bar appearing and the field starting to merge, and the merge itself. */
const PHONE_GAP = 24;
const PHONE_RANGE = 56;
/** On a wide screen: the scrolling the one move takes, and where in it (0 to 1) the bar comes up. */
const WIDE_RANGE = 48;
const WIDE_BAR_AT = 0.67;

/**
 * Scroll progress of the search dock (0 in the hero, 1 in the bar). The dock is a
 * position: sticky element, so the browser moves it with the page; this only
 * maps the scroll position to --dock (plus the slot geometry) on the dock
 * itself. On a wide screen --dock is also written on `hostRef`, the board
 * body, because the filter chips beside the field follow it; on a phone that
 * would restyle every card on every write. While the move is under way (--dock
 * above 0) the dock and the host carry data-docking.
 *
 * Progress comes from window.scrollY against offsets measured when the layout
 * changes, never from a rect read on every frame. On a phone the move has two
 * phases: the bar comes up on its own at `barStart`, the scroll offset at which
 * it sits in its stuck place; the field waits pinned below it; PHONE_GAP px
 * later it merges up into the bar over PHONE_RANGE px. On a wide screen the
 * field shares its row with the chips, so it is a single move and the bar comes
 * up three quarters of the way through it.
 */
export function useSearchDock({
  hostRef,
  dockRef,
  barRef,
  slotRef,
  store,
}: {
  hostRef: RefObject<HTMLElement | null>;
  dockRef: RefObject<HTMLElement | null>;
  barRef: RefObject<HTMLElement | null>;
  slotRef: RefObject<HTMLElement | null>;
  store: DockStore;
}): void {
  useEffect(() => {
    const dock = dockRef.current;
    const host = hostRef.current;
    const bar = barRef.current;
    if (!dock || !host || !bar) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const wide = window.matchMedia(WIDE);
    let raf = 0;
    let lastP = -1;
    let docked = false;
    let barShown = false;
    let barStart = 0;
    let start = 0;
    let range = PHONE_RANGE;
    const measure = () => {
      const hostStyle = getComputedStyle(host);
      const contentTop =
        host.getBoundingClientRect().top +
        window.scrollY +
        (Number.parseFloat(hostStyle.paddingTop) || 0) +
        (Number.parseFloat(hostStyle.borderTopWidth) || 0);
      if (wide.matches) {
        const dockStyle = getComputedStyle(dock);
        const natural = contentTop + (Number.parseFloat(dockStyle.marginTop) || 0);
        range = WIDE_RANGE;
        start = natural - (Number.parseFloat(dockStyle.top) || 10) - range;
        barStart = start + WIDE_BAR_AT * range;
      } else {
        // The bar is the first thing in the body, so it sits at the body's top until it sticks.
        range = PHONE_RANGE;
        barStart = contentTop - (Number.parseFloat(getComputedStyle(bar).top) || 8);
        start = barStart + PHONE_GAP;
      }
      const slot = slotRef.current;
      if (!slot) return;
      dock.style.setProperty("--dock-x", `${pageLeft(slot) - pageLeft(dock)}px`);
      dock.style.setProperty("--dock-w", `${slot.offsetWidth}px`);
    };
    const write = (p: number) => {
      const value = String(p);
      dock.style.setProperty("--dock", value);
      if (wide.matches) host.style.setProperty("--dock", value);
      else host.style.removeProperty("--dock");
      for (const element of [dock, host]) {
        if (p > 0) element.setAttribute("data-docking", "");
        else element.removeAttribute("data-docking");
      }
    };
    const frame = () => {
      raf = 0;
      const y = window.scrollY;
      let p = dockProgress(y, start, range);
      if (reduce.matches) p = p >= 1 ? 1 : 0;
      p = Math.round(p * 500) / 500;
      if (p !== lastP) {
        lastP = p;
        write(p);
      }
      barShown = barShownAt(y, barStart, barShown);
      // Part way, the field is still where it was: the placeholder only changes at the two ends.
      if (p === 1) docked = true;
      else if (p === 0) docked = false;
      store.set({ barShown, docked });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const remeasure = () => {
      measure();
      lastP = -1;
      schedule();
    };
    measure();
    frame();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", remeasure);
    wide.addEventListener("change", remeasure);
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
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", remeasure);
      wide.removeEventListener("change", remeasure);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostRef, dockRef, barRef, slotRef, store]);
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
