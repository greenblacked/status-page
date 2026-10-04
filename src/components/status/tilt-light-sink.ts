import { TILT_LIGHT_SELECTOR, TILT_VAR_X, TILT_VAR_Y } from "@/lib/status/tilt";

/**
 * Where the tilt light is written, and when (see src/background.css for what
 * draws it).
 *
 * The light is two numbers, x and y, each -1..1. The panels' ::before (the
 * sheen) and ::after (the glint) draw a gradient that never changes, on a layer
 * of its own that is slid by a transform; the numbers only set how far. Two ways
 * to hand the numbers to that transform, the first preferred:
 *
 * "animation": each pseudo-element gets two paused Web Animations (x on
 * `transform`, y on `translate`) whose time stands for the position, and a write
 * sets their `currentTime`. Nothing in the style system is touched: no style
 * recalculation, no repaint, the compositor moves the layer. This is the cheap
 * path; on a 4x slower CPU it costs about a tenth of the other.
 *
 * "properties": the CSS rules take --light-x and --light-y, written inline on
 * ONE element, the board's <main> (the scope), never on each panel. The cost of a
 * write is the restyle of everything that inherits them; background.css stops
 * the inheritance one level below each panel (`.surface > *`), so a write
 * reaches the scope, the panels and their direct children, and not the many
 * hundreds of elements inside the rows. Not on <html> (that would restyle the
 * header and footer too), not through a rule of a style sheet (a change to a rule
 * makes WebKit rebuild its rule sets and re-style the document), and not as
 * non-inherited @property values handed to the pseudo-elements with `inherit`
 * (WebKit then draws the gradients as if the variable were unset). This path
 * is the fallback for an engine that cannot animate pseudo-elements, or whose
 * animations do not reach the computed style (checked once, below).
 *
 * Nothing searches the document per write. The panels (TILT_LIGHT_SELECTOR) are
 * found once, when the light turns on, and after that only through a
 * MutationObserver on the scope, which sees a refresh add or drop them. An
 * IntersectionObserver tells which of them are on screen. With none on screen
 * nothing is written (the loop keeps the light's position, which is only
 * arithmetic); a panel that comes back is caught up with one write, so there is
 * no jump to a stale light. remove() puts everything back.
 */

/** How far each layer slides at x or y = 1, in percent of the layer itself. The same numbers as in src/background.css. */
export const SHEEN_SLIDE = 8;
export const GLINT_SLIDE = 21.1;

/** The animations' length in ms: the time 0..SPAN is the light -1..1. A whole number of ms per 0.001. */
const SPAN = 2000;
const ID_X = "tilt-light-x";
const ID_Y = "tilt-light-y";

/** The glint is drawn only where there is no hover-capable pointer (the wandering light owns it elsewhere). */
const GLINT_QUERY = "not ((hover: hover) and (pointer: fine))";

export type LightSink = {
  /** Moves the light. Both numbers are -1..1. */
  set: (x: number, y: number) => void;
  /** Takes the light off the page. */
  remove: () => void;
};

type Track = { x: Animation; y: Animation };

/** Whether this engine animates the pseudo-elements and the individual `translate` property at all. */
export function pseudoAnimationsSupported(): boolean {
  try {
    if (typeof KeyframeEffect === "undefined" || typeof CSS === "undefined" || !CSS.supports("translate", "0 0")) {
      return false;
    }
    const probe = new KeyframeEffect(document.documentElement, [], { pseudoElement: "::before" });
    return probe.pseudoElement === "::before";
  } catch {
    return false;
  }
}

/** The time on the animations' clock for a light position. */
const timeOf = (value: number) => (Math.max(-1, Math.min(1, value)) + 1) * (SPAN / 2);

function animate(host: Element, pseudo: "::before" | "::after", slide: number): Track {
  const options = { duration: SPAN, fill: "both", easing: "linear", pseudoElement: pseudo } as const;
  const x = host.animate(
    { transform: [`translate3d(${-slide}%, 0, 0)`, `translate3d(${slide}%, 0, 0)`] },
    { ...options, id: ID_X },
  );
  const y = host.animate({ translate: [`0 ${-slide}%`, `0 ${slide}%`] }, { ...options, id: ID_Y });
  x.pause();
  y.pause();
  return { x, y };
}

export function createLightSink(
  scope: () => HTMLElement | null,
  { animations = pseudoAnimationsSupported() }: { animations?: boolean } = {},
): LightSink {
  const hosts = new Set<Element>();
  const onScreen = new Set<Element>();
  const tracks = new Map<Element, Track[]>();
  let last: { x: number; y: number } | null = null;
  let written: { x: number; y: number } | null = null;
  let target: HTMLElement | null = null;
  let mutations: MutationObserver | null = null;
  let intersections: IntersectionObserver | null = null;
  let useAnimations = animations;
  let checked = false;

  const setTime = (list: Track[], position: { x: number; y: number }) => {
    for (const track of list) {
      track.x.currentTime = timeOf(position.x);
      track.y.currentTime = timeOf(position.y);
    }
  };

  const dropAnimations = () => {
    for (const list of tracks.values()) {
      for (const track of list) {
        track.x.cancel();
        track.y.cancel();
      }
    }
    tracks.clear();
  };

  /** Writes the light on the board, for the engines (or the moments) that cannot animate it. */
  const writeProperties = (position: { x: number; y: number }) => {
    if (!target) return;
    target.style.setProperty(TILT_VAR_X, position.x.toFixed(3));
    target.style.setProperty(TILT_VAR_Y, position.y.toFixed(3));
  };

  /**
   * Once, on the first panel: the animation must show in the computed transform of
   * the pseudo-element (an engine that takes the call and draws nothing would
   * leave the light still). If not, the animations go and the properties take over.
   */
  const verify = (host: Element, list: Track[]) => {
    checked = true;
    let works = false;
    try {
      const first = list[0];
      first.x.currentTime = 0;
      const low = getComputedStyle(host, "::before").transform;
      first.x.currentTime = SPAN;
      const high = getComputedStyle(host, "::before").transform;
      first.x.currentTime = SPAN / 2;
      works = low !== high;
    } catch {
      works = false;
    }
    if (works) return;
    useAnimations = false;
    dropAnimations();
    if (last) writeProperties(last);
    written = last;
  };

  const create = (host: Element) => {
    if (!useAnimations || tracks.has(host)) return;
    try {
      const list: Track[] = [animate(host, "::before", SHEEN_SLIDE)];
      // An animation made before its pseudo-element exists never applies to it, so look first
      // (this also flushes the style the data-tilt attribute changed).
      if (
        host.classList.contains("spotlight") &&
        window.matchMedia(GLINT_QUERY).matches &&
        getComputedStyle(host, "::after").content !== "none"
      ) {
        list.push(animate(host, "::after", GLINT_SLIDE));
      }
      tracks.set(host, list);
      // A panel that is not laid out (width 0) would show nothing to check: wait for one that is.
      if (!checked && host.getBoundingClientRect().width > 0) verify(host, list);
      // A panel that appears while the light is on starts where the light is.
      if (useAnimations && last) setTime(list, last);
    } catch {
      useAnimations = false;
      dropAnimations();
      if (last) writeProperties(last);
    }
  };

  const write = () => {
    if (!target || !last) return;
    // Nothing on screen: leave the page alone. A panel coming into view is caught up then.
    if (intersections && onScreen.size === 0) return;
    if (written && written.x === last.x && written.y === last.y) return;
    if (useAnimations) {
      for (const host of intersections ? onScreen : hosts) {
        const list = tracks.get(host);
        if (list) setTime(list, last);
      }
    } else {
      writeProperties(last);
    }
    written = last;
  };

  const track = (host: Element) => {
    if (hosts.has(host)) return;
    hosts.add(host);
    create(host);
    intersections?.observe(host);
  };
  const untrack = (host: Element) => {
    hosts.delete(host);
    onScreen.delete(host);
    const list = tracks.get(host);
    if (list) {
      for (const item of list) {
        item.x.cancel();
        item.y.cancel();
      }
      tracks.delete(host);
    }
    intersections?.unobserve(host);
  };

  const scan = (root: Pick<Element, "querySelectorAll">) => {
    for (const host of root.querySelectorAll(TILT_LIGHT_SELECTOR)) track(host);
  };

  const onMutations = (records: MutationRecord[]) => {
    let removed = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(TILT_LIGHT_SELECTOR)) track(node);
        scan(node);
      }
      if (record.removedNodes.length > 0) removed = true;
    }
    // Only the tracked set is walked: a removed panel is no longer connected.
    if (!removed) return;
    for (const host of Array.from(hosts)) if (!host.isConnected) untrack(host);
  };

  const onIntersections = (entries: IntersectionObserverEntry[]) => {
    for (const entry of entries) {
      if (!hosts.has(entry.target)) continue;
      if (!entry.isIntersecting) {
        onScreen.delete(entry.target);
        continue;
      }
      const wasOn = onScreen.has(entry.target);
      onScreen.add(entry.target);
      // Back in view: catch this panel up to the light.
      if (wasOn || !last) continue;
      if (useAnimations) {
        const list = tracks.get(entry.target);
        if (list) setTime(list, last);
      } else if (!written || written.x !== last.x || written.y !== last.y) {
        writeProperties(last);
        written = last;
      }
    }
  };

  const connect = (element: HTMLElement) => {
    target = element;
    if (typeof IntersectionObserver !== "undefined") {
      // A little margin, so a panel is lit just before it scrolls in.
      intersections = new IntersectionObserver(onIntersections, { rootMargin: "120px 0px" });
    }
    scan(element);
    mutations = new MutationObserver(onMutations);
    mutations.observe(element, { childList: true, subtree: true });
  };

  return {
    set: (x, y) => {
      last = { x, y };
      if (!target) {
        const element = scope();
        if (!element) return;
        connect(element);
      }
      write();
    },
    remove: () => {
      mutations?.disconnect();
      intersections?.disconnect();
      mutations = null;
      intersections = null;
      dropAnimations();
      target?.style.removeProperty(TILT_VAR_X);
      target?.style.removeProperty(TILT_VAR_Y);
      target = null;
      hosts.clear();
      onScreen.clear();
      last = null;
      written = null;
    },
  };
}
