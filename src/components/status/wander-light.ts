import { GLINT_QUERY } from "@/lib/status/tilt";

/**
 * The soft light that wanders across each card and list on the Glass and Full
 * backgrounds (src/background.css draws it: a fixed-size ::after layer that
 * only a transform moves).
 *
 * It does not run as a CSS animation. A card is frosted glass: a layer that
 * moves inside (or over) a panel with a backdrop-filter makes the compositor
 * draw that panel's blur again for every frame the layer is damaged, and a
 * continuous animation damages it on every frame, about 60 or 120 a second.
 * Measured on a Pixel 7 profile (Chromium, CPU throttled 4x): the same
 * wander as a CSS animation made the compositor draw about 150 frames in 3 s
 * where a still page draws 4, and the page lost a third of its frame rate.
 * Neither the size of the layer nor where it sits changes that (a 40px
 * square costs what a panel-sized one does): the panel is redrawn whole. So the
 * light moves in small steps instead, all of the cards in the same
 * tick, about twice a second. The light is soft and slow (it crosses a card in
 * about twenty seconds), so a step is a few pixels of a gradient that fades over
 * two hundred: up to 5% of the card's height and 3.7% of its width at the shortest
 * loop (about 23px on a 460px card, more on a very tall list), measured at no more
 * than three levels of colour in a screenshot, which reads as a drift rather than
 * a jump. The page is damaged on 2 of 60 frames, not on all of them.
 *
 * No animation also means nothing for the style system to sample on every
 * frame, and nothing a browser could decide to run on the main thread: the only
 * work is this timer, which reads the cards' sizes and then writes two custom
 * properties (--wander-x, --wander-y, in px) on each card whose light moved by
 * at least a pixel. The CSS reads them in the layer's transform, so nothing is laid out or
 * painted; the compositor moves the layer. The properties are plain (not
 * registered) and `.spotlight > *` resets them, so a write restyles the card and its
 * direct children, not the rows inside.
 *
 * Where it stops: nothing is written on Quiet (the page's data-background is not glass or full, so the timer
 * does not even read a style), while the page is hidden, while Tilt
 * lighting is driving the card light (the glint takes the same ::after over on a
 * device with no hover-capable pointer), and while the style sheet hides the
 * layer (Quiet, Reduce Motion, Reduce glass, Increase Contrast, forced colours).
 * The path is a pure function of the clock, so after any pause the light is
 * simply where it would have been. A pause also takes the cards' data-wander
 * mark off, which fades the light out, so that when the pause ends the light
 * is not shown at the place it stopped at: the next step writes where it should
 * be and puts the mark back, and the light fades in there. That step runs at once
 * when the page becomes visible again, and otherwise within half a second.
 */

/** Milliseconds between steps. */
export const WANDER_TICK_MS = 500;
export const WANDER_VAR_X = "--wander-x";
export const WANDER_VAR_Y = "--wander-y";

/** A stop on a route: how far along the loop (0..1), and the light's offset from the card's middle, as a fraction of its width and height. */
type Stop = readonly [at: number, x: number, y: number];

/** The routes the cards are given at random: the same four loops, in the same fractions of the card, the light has always walked. */
export const WANDER_ROUTES: readonly (readonly Stop[])[] = [
  [
    [0, -0.34, -0.26],
    [0.27, 0.22, -0.34],
    [0.58, 0.38, 0.18],
    [0.81, -0.12, 0.3],
    [1, -0.3, 0.06],
  ],
  [
    [0, 0.3, 0.28],
    [0.22, -0.08, 0.34],
    [0.49, -0.36, -0.12],
    [0.76, 0.06, -0.3],
    [1, 0.34, -0.08],
  ],
  [
    [0, -0.04, -0.36],
    [0.31, 0.36, -0.06],
    [0.55, 0.14, 0.32],
    [0.84, -0.38, 0.2],
    [1, -0.24, -0.2],
  ],
  [
    [0, 0.38, -0.22],
    [0.24, 0.04, 0.08],
    [0.52, -0.32, 0.3],
    [0.73, -0.2, -0.32],
    [1, 0.26, 0.24],
  ],
];

/** Slow in, slow out between two stops (a smoothstep, which the CSS ease-in-out it replaces matches closely). */
const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Where the light is on a route: `progress` counts loops, and every second loop runs backwards (a light that
 * goes there and back), so any non-negative number is a place. Fractions of the card's width and height.
 */
export function wanderAt(route: number, progress: number): { x: number; y: number } {
  const stops = WANDER_ROUTES[((route % WANDER_ROUTES.length) + WANDER_ROUTES.length) % WANDER_ROUTES.length];
  const turn = ((progress % 2) + 2) % 2;
  const at = turn > 1 ? 2 - turn : turn;
  let index = 0;
  while (index < stops.length - 2 && at > stops[index + 1][0]) index++;
  const [from, to] = [stops[index], stops[index + 1]];
  const span = to[0] - from[0];
  const t = span > 0 ? ease(Math.min(1, Math.max(0, (at - from[0]) / span))) : 0;
  return { x: from[1] + (to[1] - from[1]) * t, y: from[2] + (to[2] - from[2]) * t };
}

type Walker = {
  route: number;
  /** Seconds for one loop, and where in the clock the light started (a phase in seconds, two loops long). */
  loop: number;
  phase: number;
  /** The last offsets written, in px. */
  x?: number;
  y?: number;
};

export type WanderOptions = {
  /** Random numbers in [0, 1); the tests give their own. */
  random?: () => number;
  /** The clock, in seconds. */
  now?: () => number;
};

/**
 * Starts the wander for every `.spotlight` inside `root`, and for the ones that appear later. Returns the
 * function that stops it and takes its marks off the cards.
 */
export function startWanderLight(
  root: HTMLElement,
  { random = Math.random, now = () => performance.now() / 1000 }: WanderOptions = {},
): () => void {
  const walkers = new Map<HTMLElement, Walker>();
  const glint = window.matchMedia(GLINT_QUERY);

  /** Gives a card its own route, loop length and starting point, once. The server markup carries none of it. */
  const seed = (el: HTMLElement) => {
    if (walkers.has(el)) return;
    const loop = 44 + random() * 36;
    walkers.set(el, { route: Math.floor(random() * WANDER_ROUTES.length), loop, phase: random() * loop * 2 });
  };
  const seedWithin = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(".spotlight")) seed(node);
    for (const el of node.querySelectorAll<HTMLElement>(".spotlight")) seed(el);
  };

  /** Tilt lighting is driving the light and the glint has the card's ::after (the style sheet's own condition). */
  const tiltDrives = () => document.documentElement.dataset.tilt === "on" && glint.matches;

  /** Takes the light off the cards, so it fades out and comes back at the right place, not the one it stopped at. */
  const pause = (cards: Iterable<[HTMLElement, Walker]>) => {
    for (const [el, walker] of cards) {
      if (walker.x === undefined) continue;
      delete el.dataset.wander;
      walker.x = undefined;
      walker.y = undefined;
    }
  };

  const step = () => {
    // The cards that are still on the page (the rest are forgotten, whether or not the light is moving).
    const cards: [HTMLElement, Walker][] = [];
    for (const entry of walkers) {
      if (entry[0].isConnected) cards.push(entry);
      else walkers.delete(entry[0]);
    }
    if (document.hidden || tiltDrives()) return pause(cards);
    const sample = cards[0]?.[0];
    if (!sample) return;
    // On Quiet (the default) there is no light: skip the computed-style read below, the timer does nothing else.
    const background = document.documentElement.dataset.background;
    if (background !== "glass" && background !== "full") return pause(cards);
    // The style sheet hides the layer in Quiet, under Reduce Motion, Reduce glass, Increase Contrast and forced colours.
    const layer = getComputedStyle(sample, "::after");
    if (layer.content === "none" || layer.display === "none") return pause(cards);
    // All of the cards' sizes are read before any is written.
    const t = now();
    const moves: [HTMLElement, Walker, number, number][] = [];
    for (const [el, walker] of cards) {
      const at = wanderAt(walker.route, (t + walker.phase) / walker.loop);
      const x = Math.round(at.x * el.offsetWidth);
      const y = Math.round(at.y * el.offsetHeight);
      if (x !== walker.x || y !== walker.y) moves.push([el, walker, x, y]);
    }
    for (const [el, walker, x, y] of moves) {
      el.style.setProperty(WANDER_VAR_X, `${x}px`);
      el.style.setProperty(WANDER_VAR_Y, `${y}px`);
      // The mark that lets the style sheet draw it (and fade it in the first time).
      el.dataset.wander = String(walker.route);
      walker.x = x;
      walker.y = y;
    }
  };

  seedWithin(root);
  step();
  const timer = window.setInterval(step, WANDER_TICK_MS);
  // Coming back to the page: the light is put in its place before the first frame, not up to a step later.
  document.addEventListener("visibilitychange", step);
  // A card that appears later (a refresh, a filter) is given its place by the next step, not at once: reading sizes
  // from here would force a layout after every change the page makes to the board.
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) seedWithin(node);
  });
  observer.observe(root, { childList: true, subtree: true });

  return () => {
    window.clearInterval(timer);
    observer.disconnect();
    document.removeEventListener("visibilitychange", step);
    for (const el of walkers.keys()) {
      el.style.removeProperty(WANDER_VAR_X);
      el.style.removeProperty(WANDER_VAR_Y);
      delete el.dataset.wander;
    }
    walkers.clear();
  };
}
