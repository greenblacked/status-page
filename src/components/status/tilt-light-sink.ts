import { GLINT_QUERY, TILT_LIGHT_SELECTOR, TILT_VAR_X, TILT_VAR_Y } from "@/lib/status/tilt";

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
 *
 * A pseudo-element's animations die with the pseudo-element. Chromium destroys and
 * rebuilds a pseudo-element when its panel (or an ancestor) is taken out of the
 * document and put back, which is what React does to a keyed card that changes
 * place, and when it is shown again after display: none. The old Animation objects
 * go on reporting "paused" and taking a currentTime, but they no longer touch what
 * is drawn. So a panel that is put back, or that comes back on screen, is checked
 * (getAnimations on it still lists its tracks, or it does not) and given new
 * animations when they are gone.
 *
 * The glint's layer is a fixed-size square (src/background.css), so how far it
 * slides is a length taken from the panel's own size, kept up to date by a
 * ResizeObserver: in the animations' keyframes, or, on the properties path, as
 * --glint-dx and --glint-dy on the panel (written when the panel's size changes,
 * not when the light moves).
 *
 * Whether a panel has a glint at all is the style sheet's media query (GLINT_QUERY: no hover-capable
 * pointer), and it can change while the light is on, as a mouse is plugged into or taken off a tablet.
 * The sink listens to the same query: when it flips, the glint's animations (or its lengths) and its size
 * observation are made or dropped on every panel, and the light is written once to catch them up.
 */

/** How far the sheen's layer slides at x or y = 1, in percent of the layer itself. The same number as in src/background.css. */
export const SHEEN_SLIDE = 8;
/** How far the glint's layer slides at x or y = 1, as a fraction of the panel's width (x) or height (y). The same as in src/background.css. */
export const GLINT_REACH = 0.38;
const GLINT_DX = "--glint-dx";
const GLINT_DY = "--glint-dy";

/** The animations' length in ms: the time 0..SPAN is the light -1..1. A whole number of ms per 0.001. */
const SPAN = 2000;
const ID_X = "tilt-light-x";
const ID_Y = "tilt-light-y";

export type LightSink = {
  /** Moves the light. Both numbers are -1..1. */
  set: (x: number, y: number) => void;
  /** Whether a write is only a currentTime on the animations (cheap enough for every frame), not an inline property. */
  animated: () => boolean;
  /** Takes the light off the page. */
  remove: () => void;
};

/** The two animations of one pseudo-element; `reach` is the glint's slide in px, last given to its keyframes. */
type Track = { x: Animation; y: Animation; glint: boolean; reach?: { x: number; y: number } };

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

type Slide = { x: number; y: number; unit: "%" | "px" };

const keyframesOf = (slide: Slide) => ({
  x: { transform: [`translate3d(${-slide.x}${slide.unit}, 0, 0)`, `translate3d(${slide.x}${slide.unit}, 0, 0)`] },
  y: { translate: [`0 ${-slide.y}${slide.unit}`, `0 ${slide.y}${slide.unit}`] },
});

function animate(host: Element, pseudo: "::before" | "::after", slide: Slide): Track {
  const options = { duration: SPAN, fill: "both", easing: "linear", pseudoElement: pseudo } as const;
  const frames = keyframesOf(slide);
  const x = host.animate(frames.x, { ...options, id: ID_X });
  const y = host.animate(frames.y, { ...options, id: ID_Y });
  x.pause();
  y.pause();
  return { x, y, glint: pseudo === "::after", reach: pseudo === "::after" ? { x: slide.x, y: slide.y } : undefined };
}

/** The glint's slide on this panel, in px. */
function glintReach(host: Element): { x: number; y: number } {
  const box = host as HTMLElement;
  return { x: GLINT_REACH * box.offsetWidth, y: GLINT_REACH * box.offsetHeight };
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
  let sizes: ResizeObserver | null = null;
  let useAnimations = animations;
  let checked = false;
  let glintMedia: MediaQueryList | null = null;

  /**
   * Whether a panel gets a glint: only the cards that spotlight, and only where no hover-capable pointer is. While the
   * light is on the glint takes the wandering light's ::after over there (its transform wins in the style sheet, and the page stops writing the
   * wander's place, see wander-light.ts); where a pointer hovers the wander keeps it and there is no glint.
   */
  const hasGlint = (host: Element) => host.classList.contains("spotlight") && glintMedia?.matches === true;

  /** Sets the animations' time to a position; `since` is the position they were last given, and an axis that has not moved is left alone. */
  const setTime = (
    list: Track[],
    position: { x: number; y: number },
    since: { x: number; y: number } | null = null,
  ) => {
    const moveX = !since || since.x !== position.x;
    const moveY = !since || since.y !== position.y;
    for (const track of list) {
      if (moveX) track.x.currentTime = timeOf(position.x);
      if (moveY) track.y.currentTime = timeOf(position.y);
    }
  };

  const cancelTracks = (list: Track[]) => {
    for (const track of list) {
      track.x.cancel();
      track.y.cancel();
    }
  };

  const dropAnimations = () => {
    for (const list of tracks.values()) cancelTracks(list);
    tracks.clear();
  };

  /** Writes the light on the board, for the engines (or the moments) that cannot animate it. */
  const writeProperties = (position: { x: number; y: number }) => {
    if (!target) return;
    target.style.setProperty(TILT_VAR_X, position.x.toFixed(3));
    target.style.setProperty(TILT_VAR_Y, position.y.toFixed(3));
  };

  /** Gives the glint of one panel the length it slides, from the panel's size now. */
  const sizeGlint = (host: Element) => {
    const reach = glintReach(host);
    if (!useAnimations) {
      const box = host as HTMLElement;
      box.style.setProperty(GLINT_DX, `${reach.x.toFixed(1)}px`);
      box.style.setProperty(GLINT_DY, `${reach.y.toFixed(1)}px`);
      return;
    }
    const glint = tracks.get(host)?.find((track) => track.glint);
    if (!glint || (glint.reach && glint.reach.x === reach.x && glint.reach.y === reach.y)) return;
    const frames = keyframesOf({ ...reach, unit: "px" });
    (glint.x.effect as KeyframeEffect).setKeyframes(frames.x);
    (glint.y.effect as KeyframeEffect).setKeyframes(frames.y);
    glint.reach = reach;
  };

  /** From here on the properties carry the light: the animations go, and the panels with a glint get their lengths. */
  const fallBack = () => {
    useAnimations = false;
    dropAnimations();
    for (const host of hosts) if (hasGlint(host)) sizeGlint(host);
    if (last) writeProperties(last);
    written = last;
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
    if (!works) fallBack();
  };

  const create = (host: Element) => {
    if (!useAnimations || tracks.has(host)) return;
    try {
      const list: Track[] = [animate(host, "::before", { x: SHEEN_SLIDE, y: SHEEN_SLIDE, unit: "%" })];
      // An animation made before its pseudo-element exists never applies to it, so look first
      // (this also flushes the style the data-tilt attribute changed).
      if (hasGlint(host) && getComputedStyle(host, "::after").content !== "none") {
        list.push(animate(host, "::after", { ...glintReach(host), unit: "px" }));
      }
      tracks.set(host, list);
      // A panel that is not laid out (width 0) would show nothing to check: wait for one that is.
      if (!checked && host.getBoundingClientRect().width > 0) verify(host, list);
      // A panel that appears while the light is on starts where the light is.
      if (useAnimations && last) setTime(list, last);
    } catch {
      fallBack();
    }
  };

  /**
   * Makes sure a tracked panel's animations still draw: a panel put back into the
   * document, or shown again, has a new pseudo-element, and the old animations are
   * dead (see the top of this file). Dead ones are cancelled and made again.
   */
  const refresh = (host: Element) => {
    if (!useAnimations) return;
    const list = tracks.get(host);
    if (list) {
      let live: Animation[];
      try {
        live = host.getAnimations({ subtree: true });
      } catch {
        return;
      }
      if (list.every((track) => live.includes(track.x) && live.includes(track.y))) return;
      cancelTracks(list);
      tracks.delete(host);
    }
    create(host);
  };

  /** Brings one panel's glint in line with the query as it is now: made where it is wanted, dropped where it is not. */
  const syncGlint = (host: Element) => {
    const wanted = hasGlint(host);
    if (wanted) sizes?.observe(host);
    else sizes?.unobserve(host);
    if (!useAnimations) {
      if (wanted) sizeGlint(host);
      else {
        (host as HTMLElement).style.removeProperty(GLINT_DX);
        (host as HTMLElement).style.removeProperty(GLINT_DY);
      }
      return;
    }
    const list = tracks.get(host);
    if (!list) return;
    const have = list.find((track) => track.glint);
    if (have && !wanted) {
      cancelTracks([have]);
      list.splice(list.indexOf(have), 1);
    } else if (!have && wanted && getComputedStyle(host, "::after").content !== "none") {
      list.push(animate(host, "::after", { ...glintReach(host), unit: "px" }));
    }
  };

  /** The query flipped: every panel's glint follows, then one write puts the new ones where the light is. */
  const onGlintChange = () => {
    if (!target) return;
    try {
      for (const host of hosts) syncGlint(host);
    } catch {
      fallBack();
    }
    written = null;
    write();
  };

  const write = () => {
    if (!target || !last) return;
    // Nothing on screen: leave the page alone. A panel coming into view is caught up then.
    if (intersections && onScreen.size === 0) return;
    if (written && written.x === last.x && written.y === last.y) return;
    if (useAnimations) {
      for (const host of intersections ? onScreen : hosts) {
        const list = tracks.get(host);
        // An on-screen panel has been given what was written before, so only what changed is set.
        if (list) setTime(list, last, written);
      }
    } else {
      writeProperties(last);
    }
    written = last;
  };

  const track = (host: Element) => {
    if (hosts.has(host)) {
      // Added again: moved, or put back.
      refresh(host);
      return;
    }
    hosts.add(host);
    create(host);
    if (hasGlint(host)) sizes?.observe(host);
    intersections?.observe(host);
  };
  const untrack = (host: Element) => {
    hosts.delete(host);
    onScreen.delete(host);
    const list = tracks.get(host);
    if (list) {
      cancelTracks(list);
      tracks.delete(host);
    }
    sizes?.unobserve(host);
    (host as HTMLElement).style.removeProperty(GLINT_DX);
    (host as HTMLElement).style.removeProperty(GLINT_DY);
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

  const onSizes = (entries: ResizeObserverEntry[]) => {
    for (const entry of entries) {
      if (!hosts.has(entry.target)) continue;
      try {
        sizeGlint(entry.target);
      } catch {
        fallBack();
      }
    }
  };

  const onIntersections = (entries: IntersectionObserverEntry[]) => {
    for (const entry of entries) {
      const host = entry.target;
      if (!hosts.has(host)) continue;
      if (!entry.isIntersecting) {
        onScreen.delete(host);
        continue;
      }
      const wasOn = onScreen.has(host);
      onScreen.add(host);
      if (wasOn) continue;
      // Back in view: its animations may have died while it was out of sight, and it is caught up to the light.
      refresh(host);
      if (!last) continue;
      if (useAnimations) {
        const list = tracks.get(host);
        if (list) setTime(list, last);
      } else if (!written || written.x !== last.x || written.y !== last.y) {
        writeProperties(last);
        written = last;
      }
    }
  };

  const connect = (element: HTMLElement) => {
    target = element;
    glintMedia = window.matchMedia(GLINT_QUERY);
    glintMedia.addEventListener("change", onGlintChange);
    if (typeof IntersectionObserver !== "undefined") {
      // A little margin, so a panel is lit just before it scrolls in.
      intersections = new IntersectionObserver(onIntersections, { rootMargin: "120px 0px" });
    }
    if (typeof ResizeObserver !== "undefined") sizes = new ResizeObserver(onSizes);
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
    animated: () => useAnimations,
    remove: () => {
      mutations?.disconnect();
      intersections?.disconnect();
      sizes?.disconnect();
      glintMedia?.removeEventListener("change", onGlintChange);
      glintMedia = null;
      mutations = null;
      intersections = null;
      sizes = null;
      dropAnimations();
      for (const host of hosts) {
        (host as HTMLElement).style.removeProperty(GLINT_DX);
        (host as HTMLElement).style.removeProperty(GLINT_DY);
      }
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
