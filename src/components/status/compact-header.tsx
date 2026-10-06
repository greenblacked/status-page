import { type ReactNode, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { firstInView } from "@/components/status/hold-place";
import { LocalTime } from "@/components/status/local-time";
import { STATUS_TEXT, StatusGlyph } from "@/components/status/status-glyph";
import {
  clampScroll,
  crossingTarget,
  DOCK_REST,
  type DockGeometry,
  type DockState,
  type DockStore,
  dockFrame,
  dockGeometry,
  focusReveal,
  heroFieldClear,
  quietScrolling,
  REVEAL_REST,
  type RevealMemo,
  readerMoved,
  revealFrame,
  TYPING_MS,
} from "@/lib/status/dock";
import { keyboardFocus } from "@/lib/status/layout";
import type { LiveState } from "@/lib/status/schedule";
import type { Health } from "@/lib/status/types";
import { cn } from "@/lib/utils";

/**
 * A length in px for a custom property, to 1/64 px (the layout unit): the slot's real, fractional box, so a
 * field placed by it is on the slot, where a rounded offset would leave it up to a pixel off.
 */
function px(value: number): string {
  return `${Math.round(value * 64) / 64}px`;
}

/**
 * One part of the dock's state. A component renders only when its own part changes, not on every change of the
 * state: the bar and the hero's buttons (barShown) are not rendered again when the bar's field is revealed, so
 * the frame that reveals it renders the bar alone, for its data-revealed.
 */
export function useDockSelect<T extends boolean | number | string>(
  store: DockStore,
  select: (state: DockState) => T,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => select(DOCK_REST),
  );
}

/**
 * Moves the focus from one search field to the other, with the caret or the selection and its direction (the text is
 * the one query both show). The page stays where it is: the field being left is why the reader is where they are.
 */
function handFocus(from: HTMLInputElement, to: HTMLInputElement): void {
  const { selectionStart, selectionEnd, selectionDirection } = from;
  to.focus({ preventScroll: true });
  if (selectionStart !== null && selectionEnd !== null)
    to.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
}

/** The search field that has focus, if one does. */
function searchFieldInHand(): HTMLInputElement | null {
  const focused = document.activeElement;
  return focused instanceof HTMLInputElement && focused.hasAttribute("data-search-input") ? focused : null;
}

/** The width from which the search field shares a row with the filter chips (Tailwind's lg). */
export const WIDE = "(min-width: 64rem)";

/**
 * Drives the search dock from the scroll position (window.scrollY), and writes down only what changes.
 *
 * Below 64rem (phones and iPad portrait) the hero's field is ordinary content, and scrolls away with the page
 * natively: nothing here moves it, which is what kept a scroll on iOS, where the compositor runs ahead of the
 * page's thread, from jumping a field that the page had to move itself. The bar is fixed at the top and has its
 * own copy of the field in its slot. This hook only compares the scroll position with thresholds, and the bar's
 * copy comes and goes by a plain CSS transition of opacity and translate (data-revealed on the bar).
 *   - The bar comes up once the hero's last line has scrolled clear of it (`barStart`), alone.
 *   - `heroAway` is the hero's field being entirely behind the bar (`revealFrom`). Only then can the bar's copy
 *     be reached (it is inert before) and the hero's is taken out of the Tab order.
 *   - `revealed` is the direction rule (revealFrame): REVEAL_UP_PX of scrolling up shows the copy, HIDE_DOWN_PX of
 *     scrolling down hides it. It does not read the position on a pointer, wheel or touch separately: they all
 *     fire `scroll`, which is the single rAF-coalesced listener here. The rule is held (latched) while a search
 *     field has focus or a dialog is open, and until the page has armed, and the baseline is re-set after
 *     anything that moves the page without the reader (a re-measure, a focus leaving, a quietScroll).
 *   - A search written in the field keeps it showing while `heroAway` (`keepRevealed`).
 *   - The two fields are never on screen together, and a field being typed in is not lost to the layout: when a
 *     filter shortens the board and the page ends up above `revealFrom` without the reader scrolling (`readerMoved`),
 *     the focus, the text and the caret of the bar's field move to the hero's, once that is wholly clear of the bar
 *     (`heroFieldClear`; until then the bar's field stays up and in use, not under it). The reader's
 *     own scroll up past `revealFrom` lets the bar's field go (a blur) as it always did.
 *     A key typed into a search field is such a layout change: the results shorten the page and the browser moves it by
 *     part of that (`typing`, for `TYPING_MS` after the key), which is no scroll by the reader either, even when
 *     the card its scroll anchoring held was one the search removed.
 *   - The same hand-over when the screen crosses 64rem (an iPad turned) with a field in use. The field that was in use
 *     is hidden (the bar's copy from 64rem up) or out of reach (the hero's, scrolled away, below it), so the reveal
 *     is read again from the scroll position as it is now, not from the reset the crossing leaves, and the focus,
 *     the text and the caret go to the field that is there (`crossingTarget`): the docked one from 64rem, below it
 *     the hero's while in view and otherwise the bar's copy, revealed. A crossing with no field in use moves no focus.
 *
 * A scroll the page makes itself is no direction either. The browser's own scroll anchoring moves the page when
 * the board changes above what the reader is looking at, and a reorder that leaves the board's height alone
 * (a card moving to another section) has no resize to say so. While the bar's field can show, the first thing of
 * the board in view is therefore kept with its place in the document, and a frame whose scroll is exactly the
 * distance that place moved took the baseline along instead of counting travel. The limit: an adjustment reads as
 * no travel only when it is the whole of a frame's scroll; one that lands in the same frame as the reader's own
 * scroll (a board update during a drag or fling) is still counted as the reader's travel.
 *
 * Progress comes from window.scrollY against offsets measured when the layout changes, never from a rect
 * read on every frame (the one exception is that anchor's, only while `heroAway`). A resize that changes only
 * the viewport's height, which is what iOS fires each time its toolbar collapses or returns mid-scroll, measures
 * nothing again: it refreshes how far the page can scroll (to clamp a rubber band) and moves the baseline.
 *
 * On a wide screen (64rem and up) the field shares its row with the chips, so it is a single move of 48px of
 * scrolling that does follow the scroll position: --dock (0 to 1) is written on the dock and on the chips beside
 * it, which fade with it, and the bar comes up 67% of the way through it (only once it is done under Reduce
 * Motion, where the field snaps). A mouse or trackpad scrolls on the main thread there, so there is no frame gap
 * to hide. While it is under way (--dock above 0) the dock, the chips and the bar carry data-docking.
 */
export function useSearchDock({
  hostRef,
  dockRef,
  barRef,
  slotRef,
  chipsRef,
  store,
  keepRevealed,
}: {
  hostRef: RefObject<HTMLElement | null>;
  dockRef: RefObject<HTMLElement | null>;
  barRef: RefObject<HTMLElement | null>;
  slotRef: RefObject<HTMLElement | null>;
  chipsRef: RefObject<HTMLElement | null>;
  store: DockStore;
  /** A search is written: the bar's field stays showing while the hero's is behind the bar. */
  keepRevealed: boolean;
}): void {
  const keepRef = useRef(keepRevealed);
  const pokeRef = useRef<() => void>(() => {});
  useEffect(() => {
    keepRef.current = keepRevealed;
    pokeRef.current();
  }, [keepRevealed]);
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
    // Whether the page has loaded and drawn (two frames after `load`): until then a scroll is a restored position,
    // not a direction.
    let armed = false;
    let armFrames = 0;
    let laidOutWide = wide.matches;
    let width = 0;
    // Where the hero's last line ended at the last reading, and whether the next frame is the first after that
    // line moved down (a hero that has grown): then the bar's hold on its place (the hysteresis) is let go.
    let lastBottom: number | undefined;
    let grew = false;
    let insets = { pin: 0, barTop: 0 };
    let maxScroll = 0;
    // What the last frame saw, for telling the reader's scroll from the layout's (`readerMoved`): how far the page
    // could go, and (only between a rebase and the frame after it) where the page was before the rebase took the
    // baseline along, and how far the board's anchor had moved by then.
    let lastLimit = 0;
    let travelFrom: number | null = null;
    let anchorShift = 0;
    // When a key was last typed into a search field: the board it changes moves the page (see `readerMoved`).
    let typedAt = Number.NEGATIVE_INFINITY;
    let memo: RevealMemo = REVEAL_REST;
    // The search field that had focus when the screen crossed 64rem, until its focus has been handed to the field
    // that is there (below 64rem that waits for the bar's copy to be reachable: a render or two) or given up on.
    let crossing: { from: HTMLInputElement; frames: number; orphan: boolean } | null = null;
    // A search field the browser let go of because the new layout hides it, seen by `onFocusOut` while the screen has
    // crossed 64rem and this hook has not yet taken that in. Under load that can come before the media query's event.
    let dropped: HTMLInputElement | null = null;
    // The board's first thing in view, and its offset in the document at the last reading (see `anchorMoved`).
    let anchor: { element: Element; offset: number } | null = null;
    const board = host.querySelector("main");
    let seenKeep = keepRef.current;
    let geometry: DockGeometry = {
      wide: false,
      start: 0,
      range: 1,
      barStart: 0,
      hysteresis: 8,
      revealFrom: Number.POSITIVE_INFINITY,
    };
    // The end of the page is measured against the viewport that really scrolls: on iOS Safari,
    // documentElement.clientHeight is the layout viewport with the toolbars expanded and does not grow when they
    // collapse, while innerHeight does. The taller of the two gives the true last position, so a bounce at the
    // bottom is clamped at the end and its recoil reads as no travel. Elsewhere the two are the same.
    const scrollLimit = () =>
      document.documentElement.scrollHeight - Math.max(document.documentElement.clientHeight, window.innerHeight);
    /**
     * Moves the direction rule's baseline to `y`: what happens to the page without the reader is no direction. It is
     * held to the page as revealFrame holds its frames (an iOS overshoot past the end is the end), or the next
     * frame, clamped, would read the overshoot as travel back up.
     */
    const rebase = (raw: number) => {
      const y = clampScroll(raw, maxScroll);
      // The next frame still has to tell whether the reader scrolled: keep what it would have compared against,
      // before the anchor is dropped and the baseline moved.
      travelFrom ??= memo.lastY;
      if (memo.heroAway) anchorShift += anchorMoved();
      memo = { ...memo, lastY: y, pivot: y };
      // The layout may have changed with whatever called this: the anchor's place is read again at the frame's end.
      anchor = null;
    };
    /**
     * How far the board's anchor has moved in the document since it was last read, in px (0 if there is none to
     * read). A reader's scroll does not move it; a change of the board does. The browser's scroll anchoring then
     * scrolls the page by the same distance, which keeps the anchor still in the viewport.
     */
    const anchorMoved = (): number => {
      const held = anchor;
      if (!held) return 0;
      const { top, bottom } = held.element.getBoundingClientRect();
      if (!held.element.isConnected || bottom <= 0 || top >= window.innerHeight) {
        anchor = null;
        return 0;
      }
      const offset = top + window.scrollY;
      const moved = offset - held.offset;
      held.offset = offset;
      return moved;
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
      // Where the hero's last line ends: below 64rem the bar waits until it has scrolled clear.
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
      maxScroll = scrollLimit();
      const isWide = wide.matches;
      geometry = dockGeometry({
        wide: isWide,
        reduce: reduce.matches,
        end,
        barTop,
        barHeight: bar.offsetHeight,
        // The hero's field is in the flow below 64rem, so its box is its place in the page.
        fieldBottom: isWide ? undefined : dock.getBoundingClientRect().bottom + window.scrollY,
        contentBottom,
      });
      if (!isWide) return;
      const slot = slotRef.current;
      if (!slot) return;
      // The slot's box in the viewport less the dock's, both read now, so the same scroll and the same page
      // offset are in both and cancel. The bar's hidden pose (translateY, vertical only) and its fade cannot
      // skew a left edge or a width, and offsetLeft, which rounds every offset in the chain, would be off by up to
      // a pixel. The reads are here, on a measure, never on a scroll.
      const slotBox = slot.getBoundingClientRect();
      dock.style.setProperty("--dock-x", px(slotBox.left - dock.getBoundingClientRect().left));
      dock.style.setProperty("--dock-w", px(slotBox.width));
    };
    /**
     * Revealing from two frames after the page has loaded (and this hook has run), never before. The dock says so
     * (data-armed), for a test that must not scroll before then.
     */
    const arm = () => {
      armFrames = requestAnimationFrame(() => {
        armFrames = requestAnimationFrame(() => {
          armFrames = 0;
          armed = true;
          dock.setAttribute("data-armed", "");
          // A page that opened part way down (a restored scroll) takes its pose now, hidden.
          schedule();
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
    /** The other layout's marks, which a change across the 64rem line leaves behind. True if the line was crossed. */
    const clearMarks = (): boolean => {
      if (laidOutWide === wide.matches) return false;
      laidOutWide = wide.matches;
      if (!wide.matches) {
        for (const name of ["--dock", "--dock-x", "--dock-w"]) dock.style.removeProperty(name);
        chipsRef.current?.style.removeProperty("--dock");
        docking = false;
        for (const element of [dock, chipsRef.current, bar]) element?.removeAttribute("data-docking");
      }
      memo = REVEAL_REST;
      lastP = -1;
      return true;
    };
    /**
     * Hands the focus of a field in use across the 64rem line to the field that is there (see the hook's notes).
     * Called at the end of a frame, once the reveal is read from the scroll position: it is done there when the target
     * is the one that has focus or can take it, waits a few frames for the bar's copy to be rendered reachable
     * (its markup is `inert` until `heroAway` has reached it), and is dropped when focus has moved on by itself.
     */
    const settleCrossing = (heroAway: boolean) => {
      const held = crossing;
      if (!held) return;
      const to = document.querySelector(`[data-search-input="${crossingTarget({ wide: wide.matches, heroAway })}"]`);
      const active = document.activeElement;
      // A field the browser had already let go of (orphan) leaves the focus on the body, which is not a move of its own.
      const still = active === held.from || (held.orphan && (active === null || active === document.body));
      if (!(to instanceof HTMLInputElement) || !held.from.isConnected || !still) {
        crossing = null;
        return;
      }
      if (to === held.from) {
        crossing = null;
        return;
      }
      if (to.closest("[inert]") || !to.checkVisibility()) {
        // Not yet: the render of the reveal is on its way. Give up after a dozen frames rather than wait on for ever.
        if (++held.frames > 12) crossing = null;
        else schedule();
        return;
      }
      crossing = null;
      handFocus(held.from, to);
    };
    const frame = () => {
      raf = 0;
      const y = window.scrollY;
      // Where the page was and how far the anchor had moved before anything below (or a rebase since the last
      // frame) took the baseline to the new position: what tells the reader's scroll from the layout's.
      const from = travelFrom ?? memo.lastY;
      let shift = anchorShift;
      travelFrom = null;
      anchorShift = 0;
      const prev = store.get();
      // The 8px hysteresis keeps a bar up that the page has scrolled back a little from its place. It is not for
      // a hero that has grown: the new last line may sit under the bar, which is slowly sliding in, so the bar
      // goes by the threshold itself (it waits for the line to be out from under the bar's highest point).
      const held = grew && !wide.matches ? { ...geometry, hysteresis: 0 } : geometry;
      grew = false;
      const next = dockFrame(y, held, reduce.matches, prev);
      if (wide.matches) {
        if (next.p !== lastP) {
          lastP = next.p;
          writeProgress(next.p);
        }
        memo = REVEAL_REST;
        anchor = null;
        store.set({ barShown: next.barShown, docked: next.docked, heroAway: false, revealed: false });
        settleCrossing(false);
        return;
      }
      // The page got longer or shorter since it was last measured (a filter removed cards): the position it now has
      // is the layout's doing, and the browser's scroll anchoring may have taken it a long way (to the top, even)
      // when the card it was holding moved up. That is no direction, whatever the resize observer says next.
      const limit = scrollLimit();
      // The anchor is read before a rebase drops it: how far the layout moved it is part of what it did to the page.
      if (memo.heroAway) shift += anchorMoved();
      if (Math.abs(limit - maxScroll) >= 1) {
        maxScroll = limit;
        rebase(y);
      }
      const keep = keepRef.current;
      // A search written, or cleared, is no scroll: the field that was showing is let go of from here.
      if (keep !== seenKeep) {
        seenKeep = keep;
        rebase(y);
      }
      if (quietScrolling()) rebase(y);
      // Focus in the bar's field shows it without a scroll (SearchInput, onFocus): take that up as a run going up.
      if (prev.revealed && !memo.revealed) memo = focusReveal(memo, clampScroll(y, maxScroll));
      // A scroll that is exactly the distance the board's anchor moved is the browser's scroll anchoring holding
      // the reader's place, not the reader: no direction (a scroll the reader makes moves the page, not the anchor).
      if (memo.heroAway && Math.abs(shift) >= 1 && Math.abs(clampScroll(y, maxScroll) - from - shift) < 1.5) rebase(y);
      const focused = document.activeElement;
      // A field in use holds the rule where it is, except across the 64rem line: the reset that leaves is no state to
      // hold, and the field is about to be handed to the one that is there.
      const latched =
        !armed ||
        (!crossing && focused instanceof Element && focused.hasAttribute("data-search-input")) ||
        document.querySelector("dialog[open]") !== null;
      const wasAway = memo.heroAway;
      // Whether the page is where the reader took it, or where the layout left it. Read before the frame's own
      // rebases moved the baseline (`from`), and only when it matters (the bar's field has focus).
      const barFocused = focused instanceof HTMLInputElement && focused.dataset.searchInput === "bar";
      const byReader =
        barFocused &&
        readerMoved({
          from,
          scrollY: y,
          limit: maxScroll,
          lastLimit,
          anchorMoved: shift,
          quiet: quietScrolling(),
          typing: performance.now() - typedAt < TYPING_MS,
        });
      lastLimit = maxScroll;
      travelFrom = null;
      anchorShift = 0;
      memo = revealFrame(y, maxScroll, held, memo, { barShown: next.barShown, latched, keep });
      // The bar's copy is where the field in use is going, and it shows when a field in it has focus.
      if (crossing && crossingTarget({ wide: false, heroAway: memo.heroAway }) === "bar") {
        memo = focusReveal(memo, clampScroll(y, maxScroll));
      }
      // The hero's field is back in view and the bar's copy, which still had focus, is inert from here: the bar
      // must not stay up over the hero for a focus it holds, and the two fields are never on screen together.
      if (wasAway && !memo.heroAway && barFocused) {
        const hero = document.querySelector('[data-search-input="hero"]');
        if (byReader || !(hero instanceof HTMLInputElement)) {
          // The reader scrolled up to the hero: let the field go; blur tells the bar's own focus tracking.
          focused.blur();
        } else if (
          next.barShown &&
          !heroFieldClear(hero.getBoundingClientRect().top, insets.barTop + bar.offsetHeight)
        ) {
          // The layout did, but the hero's field is only just out from behind the bar and would still be under it
          // (a tablet, a phone on its side): the bar's field stays up and in use until the board moves the field
          // clear of the bar, or the reader scrolls.
          const at = clampScroll(y, maxScroll);
          memo = { heroAway: true, revealed: true, dir: "up", pivot: at, lastY: at };
        } else {
          // The layout did (a filter shortened the board): the reader is still typing, so the focus, the text and
          // the caret go to the hero's field, which is in view and clear of the bar.
          handFocus(focused, hero);
        }
      }
      // The anchor is read while the bar's field can show, so that the next frame can tell how far it moved.
      if (!memo.heroAway) anchor = null;
      else if (!anchor && board) {
        const element = firstInView(board);
        if (element) anchor = { element, offset: element.getBoundingClientRect().top + window.scrollY };
      }
      store.set({ barShown: next.barShown, docked: false, heroAway: memo.heroAway, revealed: memo.revealed });
      settleCrossing(memo.heroAway);
    };
    const schedule = () => {
      if (alive && !raf) raf = requestAnimationFrame(frame);
    };
    pokeRef.current = schedule;
    const remeasure = () => {
      if (!alive) return;
      // Before anything below lays the page out again: the media query and the resize event come before the browser
      // lets go of the focus of a field that the new layout hides.
      const inHand = searchFieldInHand();
      const orphan = inHand ? null : dropped;
      dropped = null;
      measure();
      if (clearMarks()) {
        const from = inHand ?? orphan;
        if (from) crossing = { from, frames: 0, orphan: from === orphan };
      }
      rebase(window.scrollY);
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
        if (pin === insets.pin && barTop === insets.barTop) {
          // How far the page can go changes with the height, and the position may move with it: no direction.
          maxScroll = scrollLimit();
          rebase(window.scrollY);
          schedule();
          return;
        }
      }
      remeasure();
    };
    // A field losing focus ends the hold on the rule: the page may have moved while it had it (the keyboard).
    const onFocusOut = (event: FocusEvent) => {
      const { target, relatedTarget } = event;
      if (
        wide.matches !== laidOutWide &&
        relatedTarget === null &&
        target instanceof HTMLInputElement &&
        target.hasAttribute("data-search-input")
      )
        dropped = target;
      rebase(window.scrollY);
      schedule();
    };
    const onInput = (event: Event) => {
      const { target } = event;
      if (target instanceof HTMLInputElement && target.hasAttribute("data-search-input")) typedAt = performance.now();
    };
    measure();
    lastLimit = maxScroll;
    frame();
    if (document.readyState === "complete") arm();
    else window.addEventListener("load", arm, { once: true });
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("focusout", onFocusOut);
    // Capturing, before the field's own handler renders the board that the key changes.
    document.addEventListener("input", onInput, true);
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
      crossing = null;
      pokeRef.current = () => {};
      window.removeEventListener("load", arm);
      cancelAnimationFrame(armFrames);
      dock.removeAttribute("data-armed");
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("input", onInput, true);
      wide.removeEventListener("change", remeasure);
      reduce.removeEventListener("change", remeasure);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostRef, dockRef, barRef, slotRef, chipsRef, store]);
}

/**
 * The floating control bar: the verdict in short ("1 down · 1 degraded") with when
 * the board was last checked, a copy of the search field, and the same Alerts and
 * Refresh controls as the hero. It is shown once the hero has scrolled away, and it
 * is the only translucent element on a Quiet page.
 *
 * Below 64rem the copy of the field is in the bar's slot all the time, invisible
 * until a scroll up reveals it (data-revealed, from the dock's state); the hero's
 * field is then ordinary content. From 64rem the slot is empty: the hero's own
 * field docks into it.
 * A turn across 64rem with a field in use moves the focus to the field that is
 * there (see useSearchDock), since the copy is not drawn from 64rem up.
 *
 * Hidden, it is `inert` and `aria-hidden`, so Tab never lands on a control
 * nobody can see, a tap goes through to the page and the skip link stays the
 * first stop. Below 64rem that is all that hides it from use: it keeps its
 * blurred layer and fades out by opacity alone (styles.css), so the layer is
 * not built and torn down in the middle of the scroll that shows it. It stays put while keyboard
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
  search,
  children,
}: {
  /** Says when the bar is up; only this component renders when that changes. */
  store: DockStore;
  barRef: RefObject<HTMLElement | null>;
  slotRef: RefObject<HTMLDivElement | null>;
  /** The verdict's tone, its short form and its compact form (for the room under 1024px). */
  verdict: { tone: Health; short: string; compact: string };
  live: LiveState;
  /** When the snapshot was collected (epoch ms), if it says. */
  checkedAt: number | null;
  /**
   * The countdown to the next check, "1:52". A node, so that the part that ticks (NextIn) is a component of its own
   * and the bar does not render for every second of it.
   */
  nextIn: ReactNode;
  /** The bar's copy of the search field, for the slot (below 64rem only). */
  search: ReactNode;
  /** The controls, rendered by the board so they share its state and handlers. */
  children: ReactNode;
}) {
  const barShown = useDockSelect(store, (state) => state.barShown);
  const revealed = useDockSelect(store, (state) => state.revealed);
  const [heldByKeyboard, setKeyboardFocus] = useState(false);
  const visible = barShown || heldByKeyboard;
  const when = checkedAt === null ? null : <LocalTime at={checkedAt} />;
  return (
    <section
      ref={barRef}
      aria-label="Board controls"
      data-shown={visible}
      data-revealed={revealed ? "" : undefined}
      inert={!visible}
      aria-hidden={visible ? undefined : true}
      onFocus={(event) => setKeyboardFocus(keyboardFocus(event.target))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false);
      }}
      className="compact-header float flex h-12 items-center gap-3 pr-1.5 pl-3.5"
    >
      {/*
        From 640px to 1023px the lead sits in the flow before the slot, so its width moves the slot (and the bar's
        field in it) when the text swaps between "Checking…", "Stale · checked 14:05 UTC" and "Checked 14:05 UTC ·
        next in 1:52". 15rem holds the widest of them, so a revealed field keeps still (236px at a 16px root).
      */}
      <p
        data-bar-lead
        data-state={live}
        className="flex shrink-0 items-center gap-2.5 max-sm:contents sm:max-lg:min-w-60"
      >
        <StatusGlyph
          health={verdict.tone}
          size={20}
          className={cn(STATUS_TEXT[verdict.tone], "max-sm:relative max-sm:z-[1]")}
          cut="card"
        />
        {/*
          From 640px the verdict and the check time sit in the flow, before the field's slot. On a phone the
          slot needs the room, so the short verdict is laid over it, between the glyph and the buttons, and
          fades out while the bar's field is revealed (data-revealed); "checked" stays for
          screen readers only. It is positioned against the bar, so the lead has no box of its own there
          (max-sm:contents): the Glass and Full materials make every direct child of the bar `position:
          relative`, and a lead that is one would be the box the verdict's edges are measured from (a
          20px box, which left the verdict none).
        */}
        <span
          data-bar-verdict
          className="max-sm:pointer-events-none max-sm:absolute max-sm:top-1/2 max-sm:right-[6.75rem] max-sm:left-11 max-sm:-translate-y-1/2 max-sm:overflow-hidden max-sm:text-ellipsis max-sm:whitespace-nowrap"
        >
          {/*
            Under 1024px the lead cannot give the long form the room (a phone's slot is 134px at 320; from 640px
            the lead would squeeze the field in the slot), so the compact form is drawn and the short one is read by
            screen readers. Either ends in an ellipsis if it still does not fit.
          */}
          <span
            aria-hidden
            className="block overflow-hidden text-ellipsis whitespace-nowrap text-row leading-[18px] lg:hidden"
          >
            {verdict.compact}
          </span>
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-row leading-[18px] max-lg:sr-only">
            {verdict.short}
          </span>
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
      <div className="flex min-w-0 flex-1 justify-center">
        <div ref={slotRef} className="h-11 w-full max-w-[26rem]">
          <div className="bar-search lg:hidden">{search}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </section>
  );
}
