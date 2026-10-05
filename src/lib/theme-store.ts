import {
  applyTheme,
  parseTheme,
  readStoredTheme,
  THEME_ATTRIBUTE,
  THEME_REFRESH_MS,
  type Theme,
  type ThemeDocument,
  type ThemeStorage,
  themeFor,
  themeStorageEventMatters,
  writeStoredTheme,
} from "@/lib/theme";

/** What the store needs from the browser, so a test can pass stand-ins. */
export type ThemeEnv = {
  storage: () => ThemeStorage;
  now: () => Date;
  doc: ThemeDocument &
    Pick<Document, "visibilityState"> & {
      addEventListener(type: "visibilitychange", listener: () => void): void;
      removeEventListener(type: "visibilitychange", listener: () => void): void;
    };
  win: {
    addEventListener(type: "storage" | "pageshow", listener: (event: { key: string | null }) => void): void;
    removeEventListener(type: "storage" | "pageshow", listener: (event: { key: string | null }) => void): void;
  };
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type ThemeStore = {
  /** For useSyncExternalStore. The first subscriber starts the clock, the last one stops it. */
  subscribe(listener: () => void): () => void;
  /** The theme in effect: what <html data-theme> says (the boot script wrote it), or the rule if it says nothing. */
  getSnapshot(): Theme;
  /** Stores the opposite theme and applies it at once. */
  toggle(): void;
  /** Reads the rule again and applies it if it changed; the interval, a tab coming back and a storage event call it. */
  sync(): void;
};

/**
 * The one subscription behind every part of the page that shows the appearance. The attribute on <html> is the
 * truth the style sheet reads; this keeps it equal to the rule (`themeFor` over the stored choice and the clock)
 * while the page is open, and tells React when it moves.
 *
 * It re-reads the rule every 60 seconds, when a hidden tab becomes visible, when the page comes back from the
 * back-forward cache, and when another tab changes the stored choice. A choice made by a press is kept in
 * localStorage; where storage refuses it, it is held in memory for this visit, so the next re-read does not undo it.
 */
export function createThemeStore(env: ThemeEnv): ThemeStore {
  const listeners = new Set<() => void>();
  let timer: unknown;
  // A press that storage refused: lasts for this visit only, and gives way to anything another tab stores.
  let held: Theme | null = null;

  const rule = (): Theme => themeFor(readStoredTheme(env.storage) ?? held, env.now().getHours());
  const current = (): Theme => parseTheme(env.doc.documentElement.getAttribute(THEME_ATTRIBUTE)) ?? rule();

  const show = (theme: Theme) => {
    applyTheme(env.doc, theme);
    for (const listener of [...listeners]) listener();
  };

  const sync = () => {
    const next = rule();
    if (next !== env.doc.documentElement.getAttribute(THEME_ATTRIBUTE)) show(next);
  };

  const onStorage = (event: { key: string | null }) => {
    if (!themeStorageEventMatters(event)) return;
    held = null;
    sync();
  };
  const onPageShow = () => sync();
  const onVisible = () => {
    if (env.doc.visibilityState === "visible") sync();
  };

  const start = () => {
    sync();
    env.win.addEventListener("storage", onStorage);
    env.win.addEventListener("pageshow", onPageShow);
    env.doc.addEventListener("visibilitychange", onVisible);
    timer = env.setInterval(sync, THEME_REFRESH_MS);
  };

  const stop = () => {
    env.win.removeEventListener("storage", onStorage);
    env.win.removeEventListener("pageshow", onPageShow);
    env.doc.removeEventListener("visibilitychange", onVisible);
    env.clearInterval(timer);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: current,
    toggle() {
      const next: Theme = current() === "night" ? "day" : "night";
      held = writeStoredTheme(env.storage, next) ? null : next;
      show(next);
    },
    sync,
  };
}
