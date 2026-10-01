import { type ReactNode, type RefObject, useEffect, useState, useSyncExternalStore } from "react";
import { LocalTime } from "@/components/status/local-time";
import { STATUS_TEXT, StatusGlyph } from "@/components/status/status-glyph";
import {
  DOCK_MS,
  DOCK_REST,
  type DockGeometry,
  type DockState,
  type DockStore,
  dockFrame,
  dockGeometry,
  transitionMs,
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
 * Runs `change`, which flips the field's pose (data-docked) and so changes the width of `chrome`, the field's
 * fill, and has the fill move from where it was drawn to its new box with a transition of its own. The box
 * takes its new width at once, so the fill never goes through a layout while it moves, and what is drawn
 * is held to the old width with a scaleX for the one style recalculation in between (FLIP: first, last, invert,
 * play). Read from where the fill is now, not from where it was at rest, so a move that is turned round part
 * way carries on from the shape it has.
 */
function flipFill(chrome: HTMLElement, change: () => void): void {
  const first = chrome.getBoundingClientRect().width;
  chrome.style.transition = "none";
  chrome.style.transform = "";
  change();
  const last = chrome.offsetWidth;
  if (first > 0 && last > 0 && Math.abs(first - last) > 0.5) {
    chrome.style.transform = `scaleX(${first / last})`;
    // The style as it is held, so the move below starts from it.
    void chrome.getBoundingClientRect();
  }
  chrome.style.transition = "";
  chrome.style.transform = "";
}

/**
 * Drives the search dock from the scroll position (window.scrollY), and writes down only what changes.
 *
 * The dock is a position: sticky element, so the browser moves it with the page and pins it in the bar's slot
 * (on iOS the compositor does, at the display's rate, with no help from this hook). What the page's
 * main thread does here has to survive running late: on a 120Hz iPhone it runs at about 60fps and a frame or
 * three behind the scrolling, so one flick crosses the whole of a merge between two of its frames. Nothing
 * visible is therefore tied to the scroll position on a phone. This hook only compares it with thresholds
 * (dockFrame), and the merge is a transition in time that CSS plays on the compositor, of transform and
 * opacity only, from the moment the threshold is crossed (data-docked on the dock and on the bar).
 *
 * Progress comes from window.scrollY against offsets measured when the layout changes, never from a rect
 * read on every frame. Every offset is worked out from `end`, the scroll position at which the field reaches
 * its pin. A resize that changes only the viewport's height, which is what iOS fires each time its toolbar
 * collapses or returns mid-scroll, measures nothing again: only the width moves any of these offsets.
 *
 * On a phone (below 64rem) the bar is fixed at the top and the field is in the flow, so the bar comes up on
 * its own: at `end` minus the bar's height and PHONE_GAP, when the field is still that far below it and the
 * hero's last line (the live line) has just scrolled out from under the bar's slide-in. The page's spacing
 * puts them at the same scroll position. The field then scrolls on up at the page's pace, alone with the bar
 * for PHONE_GAP px, until its top reaches the bar's bottom edge; there it docks. Nothing is ever pinned
 * over the page without the bar behind it, and the field is under the bar (see .search-dock) until it
 * docks, so under Reduce Motion, where it only steps into the bar when it pins, it never covers the bar's
 * buttons.
 *
 * On a wide screen the field shares its row with the chips, so it is a single move of 48px of scrolling that
 * does follow the scroll position: --dock (0 to 1) is written on the dock and on the chips beside it, which
 * fade with it, and the bar comes up 67% of the way through it (only once it is done under Reduce Motion,
 * where the field snaps). It is kept as it was: a mouse or trackpad scrolls on the main thread there, so
 * there is no frame gap to hide. While it is under way (--dock above 0) the dock, the chips and the bar
 * carry data-docking.
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
    let painted = false;
    // Whether a change of pose may play as a move: not until the page has loaded and drawn (see writeDocked).
    let armed = false;
    let instantFrames = 0;
    let armFrames = 0;
    let laidOutWide = wide.matches;
    let width = 0;
    // Where the hero's last line ended at the last reading, and whether the next frame is the first after that
    // line moved down (a hero that has grown): then the bar's hold on its place (the hysteresis) is let go.
    let lastBottom: number | undefined;
    let grew = false;
    let settling = 0;
    let insets = { pin: 0, barTop: 0 };
    let state: DockState = DOCK_REST;
    let geometry: DockGeometry = {
      wide: false,
      start: 0,
      range: 1,
      barStart: 0,
      hysteresis: 8,
      dockAt: 0,
      undockAt: 0,
    };
    const measure = () => {
      width = document.documentElement.clientWidth;
      const hostStyle = getComputedStyle(host);
      const contentTop =
        host.getBoundingClientRect().top +
        window.scrollY +
        (Number.parseFloat(hostStyle.paddingTop) || 0) +
        (Number.parseFloat(hostStyle.borderTopWidth) || 0);
      const dockStyle = getComputedStyle(dock);
      const pin = Number.parseFloat(dockStyle.top) || 10;
      // Where the hero's last line ends: on a phone the bar waits until it has scrolled clear.
      const hero = host.previousElementSibling;
      const heroStyle = hero ? getComputedStyle(hero) : null;
      const contentBottom =
        hero && heroStyle
          ? hero.getBoundingClientRect().bottom + window.scrollY - (Number.parseFloat(heroStyle.paddingBottom) || 0)
          : undefined;
      if (contentBottom !== undefined && lastBottom !== undefined && contentBottom > lastBottom + 0.5) grew = true;
      lastBottom = contentBottom;
      const end = contentTop + (Number.parseFloat(dockStyle.marginTop) || 0) - pin;
      const barTop = Number.parseFloat(getComputedStyle(bar).top) || 8;
      insets = { pin, barTop };
      geometry = dockGeometry({
        wide: wide.matches,
        reduce: reduce.matches,
        end,
        pin,
        barTop,
        barHeight: bar.offsetHeight,
        fieldHeight: dock.offsetHeight,
        contentBottom,
      });
      const slot = slotRef.current;
      if (!slot) return;
      const x = `${pageLeft(slot) - pageLeft(dock)}px`;
      const w = `${slot.offsetWidth}px`;
      // A docked field whose slot has moved or resized (the bar's lead text changed, from 40rem where it sits
      // in the flow before the slot) follows it at once. Left to the transition it would slide sideways, and
      // its width, which is not timed, would snap in the middle of that. A move already under way retargets.
      const moved = dock.style.getPropertyValue("--dock-x") !== x || dock.style.getPropertyValue("--dock-w") !== w;
      if (moved && !wide.matches && dock.hasAttribute("data-docked") && !settling) holdInstant();
      dock.style.setProperty("--dock-x", x);
      dock.style.setProperty("--dock-w", w);
    };
    /** Holds the field's, the fill's and the verdict's transitions off (data-instant) for two frames from now. */
    const holdInstant = () => {
      for (const element of [dock, bar]) element.setAttribute("data-instant", "");
      cancelAnimationFrame(instantFrames);
      instantFrames = requestAnimationFrame(() => {
        instantFrames = requestAnimationFrame(() => {
          instantFrames = 0;
          for (const element of [dock, bar]) element.removeAttribute("data-instant");
        });
      });
    };
    /**
     * Moves are on from two frames after the page has loaded (and this hook has run), never before. The dock
     * says so (data-armed), for a test that must not scroll before then.
     */
    const arm = () => {
      armFrames = requestAnimationFrame(() => {
        armFrames = requestAnimationFrame(() => {
          armFrames = 0;
          armed = true;
          dock.setAttribute("data-armed", "");
        });
      });
    };
    /** Wide: the move's progress, on the dock and the chips, and whether it is under way. */
    const writeProgress = (p: number) => {
      const value = String(p);
      dock.style.setProperty("--dock", value);
      const chips = chipsRef.current;
      if (chips) chips.style.setProperty("--dock", value);
      const nextDocking = p > 0;
      if (nextDocking !== docking) {
        docking = nextDocking;
        for (const element of [dock, chips, bar]) {
          if (docking) element?.setAttribute("data-docking", "");
          else element?.removeAttribute("data-docking");
        }
      }
    };
    /**
     * Phone: the pose the field and the bar are in, which CSS moves them to over DOCK_MS. Returns whether it
     * was written as a move (the CSS transition may play) rather than as the pose the page opened in.
     */
    const writeDocked = (docked: boolean): boolean => {
      const set = () => {
        for (const element of [dock, bar]) element.toggleAttribute("data-docked", docked);
      };
      const chrome = dock.querySelector<HTMLElement>(".search-chrome");
      // The first pose is not a move: the page opened part way down, or came back to a scroll position, which a
      // browser may restore after this hook has run (WebKit does, up to the end of the load). Until the page has
      // loaded and drawn, and for the first write after a change of layout, the transitions are held off by an
      // attribute (data-instant) that stays on for two frames: a frame draws the new pose before they are back,
      // which holds in every engine, where a style flush between two inline writes is only as good as the
      // engine's idea of when to recalculate.
      if (!painted || !armed) {
        holdInstant();
        set();
        painted = true;
        return false;
      }
      if (chrome && !reduce.matches) flipFill(chrome, set);
      else set();
      painted = true;
      return true;
    };
    /** The other layout's marks, which a change across the 64rem line leaves behind. */
    const clearMarks = () => {
      if (laidOutWide === wide.matches) return;
      laidOutWide = wide.matches;
      if (wide.matches) {
        dock.removeAttribute("data-docked");
        bar.removeAttribute("data-docked");
      } else {
        dock.style.removeProperty("--dock");
        chipsRef.current?.style.removeProperty("--dock");
        docking = false;
        for (const element of [dock, chipsRef.current, bar]) element?.removeAttribute("data-docking");
      }
      lastP = -1;
      painted = false;
    };
    const settle = (docked: boolean) => {
      window.clearTimeout(settling);
      settling = 0;
      dock.removeAttribute("data-moving");
      state = { ...state, settled: docked };
      store.set(state);
    };
    const frame = () => {
      raf = 0;
      let instant = false;
      // The 8px hysteresis keeps a bar up that the page has scrolled back a little from its place. It is not for
      // a hero that has grown: the new last line may sit under the bar, which is slowly sliding in, so the bar
      // goes by the threshold itself (it waits for the line to be out from under the bar's highest point).
      const held = grew && !wide.matches ? { ...geometry, hysteresis: 0 } : geometry;
      grew = false;
      const next = dockFrame(window.scrollY, held, reduce.matches, state);
      if (wide.matches) {
        if (next.p !== lastP) {
          lastP = next.p;
          writeProgress(next.p);
        }
      } else if (next.docked !== state.docked || !painted) {
        instant = !writeDocked(next.docked);
      }
      if (next.docked !== state.docked) {
        window.clearTimeout(settling);
        settling = 0;
        dock.removeAttribute("data-moving");
        const field = dock.querySelector<HTMLElement>(".search-field");
        // What is written in the field waits for the move when there is one, and follows at once when there
        // is none (Reduce Motion, a wide screen).
        const moves = !instant && field !== null && transitionMs(getComputedStyle(field).transitionDuration) > 0;
        state = { barShown: next.barShown, docked: next.docked, settled: moves ? state.settled : next.docked };
        // transitionend usually ends the wait; the timer is for a move that never reports (a hidden tab).
        if (moves) {
          // The field's own controls (Clear) are at their docked place at once; they wait out the move.
          dock.setAttribute("data-moving", "");
          settling = window.setTimeout(() => settle(next.docked), DOCK_MS + 100);
        }
      } else {
        state = { ...state, barShown: next.barShown };
      }
      store.set(state);
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (settling && event.propertyName === "transform" && event.target === dock.querySelector(".search-field")) {
        settle(state.docked);
      }
    };
    const schedule = () => {
      if (alive && !raf) raf = requestAnimationFrame(frame);
    };
    const remeasure = () => {
      if (!alive) return;
      measure();
      clearMarks();
      // Now, not on the next frame: a hero that has just grown (the board's answer names more services, the live
      // line wraps to another line) has moved its last line under a bar that is already up. This runs after the
      // layout and before the paint, so the bar starts to leave in the frame that shows the new hero, not one frame later.
      if (raf) cancelAnimationFrame(raf);
      frame();
    };
    const onResize = () => {
      if (!alive) return;
      // Height only (iOS collapsing or returning its toolbar mid-scroll): the offsets do not follow it. The
      // width is a read that costs nothing when the layout is clean. The safe-area insets the two pins are
      // built from can move with the height, and those are style reads.
      if (width === document.documentElement.clientWidth) {
        const pin = Number.parseFloat(getComputedStyle(dock).top) || 10;
        const barTop = Number.parseFloat(getComputedStyle(bar).top) || 8;
        if (pin === insets.pin && barTop === insets.barTop) return;
      }
      remeasure();
    };
    measure();
    frame();
    if (document.readyState === "complete") arm();
    else window.addEventListener("load", arm, { once: true });
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", onResize);
    dock.addEventListener("transitionend", onTransitionEnd);
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
      window.removeEventListener("load", arm);
      cancelAnimationFrame(armFrames);
      cancelAnimationFrame(instantFrames);
      for (const element of [dock, bar]) element.removeAttribute("data-instant");
      dock.removeAttribute("data-armed");
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
      dock.removeEventListener("transitionend", onTransitionEnd);
      wide.removeEventListener("change", remeasure);
      reduce.removeEventListener("change", remeasure);
      ro.disconnect();
      window.clearTimeout(settling);
      dock.removeAttribute("data-moving");
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostRef, dockRef, barRef, slotRef, chipsRef, store]);
}

/**
 * The floating control bar: the verdict in short ("1 down · 1 degraded") with when
 * the board was last checked, the search field once it has docked, and the same
 * Alerts and Refresh controls as the hero. It is shown once the hero has
 * scrolled away, and it is the only translucent element on a Quiet page.
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
  verdict,
  live,
  checkedAt,
  nextIn,
  children,
}: {
  /** Says when the bar is up; only this component renders when that changes. */
  store: DockStore;
  barRef: RefObject<HTMLElement | null>;
  slotRef: RefObject<HTMLDivElement | null>;
  /** The verdict's tone and its short form. */
  verdict: { tone: Health; short: string };
  live: LiveState;
  /** When the snapshot was collected (epoch ms), if it says. */
  checkedAt: number | null;
  /** The countdown to the next check, "1:52". */
  nextIn: string;
  /** The controls, rendered by the board so they share its state and handlers. */
  children: ReactNode;
}) {
  const { barShown } = useDockState(store);
  const [heldByKeyboard, setKeyboardFocus] = useState(false);
  const visible = barShown || heldByKeyboard;
  const when = checkedAt === null ? null : <LocalTime at={checkedAt} />;
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
      className="compact-header float flex h-12 items-center gap-3 pr-1.5 pl-3.5"
    >
      <p data-bar-lead data-state={live} className="flex shrink-0 items-center gap-2.5">
        <StatusGlyph health={verdict.tone} size={20} className={STATUS_TEXT[verdict.tone]} cut="card" />
        {/*
          From 640px the verdict and the check time sit in the flow, before the field's slot. On a phone the
          slot needs the room, so the short verdict is laid over it, between the glyph and the buttons, and
          fades out as the field docks (data-docked, written by useSearchDock); "checked" stays for
          screen readers only.
        */}
        <span
          data-bar-verdict
          className="max-sm:pointer-events-none max-sm:absolute max-sm:top-1/2 max-sm:right-[6.75rem] max-sm:left-11 max-sm:-translate-y-1/2 max-sm:overflow-hidden max-sm:text-ellipsis max-sm:whitespace-nowrap"
        >
          <span className="block text-row leading-[18px]">{verdict.short}</span>
          <span className="block text-footnote tabular-nums text-subtle max-sm:sr-only">
            {live === "checking" ? (
              "Checking…"
            ) : live === "stale" ? (
              <>Stale{when ? <> · checked {when}</> : null}</>
            ) : (
              <>
                {when ? <>Checked {when} · </> : null}next in {nextIn}
              </>
            )}
          </span>
        </span>
      </p>
      <div className="flex min-w-0 flex-1 justify-center" aria-hidden>
        <div ref={slotRef} className="h-11 w-full max-w-[26rem]" />
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </section>
  );
}
