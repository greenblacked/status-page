import { useSyncExternalStore } from "react";
import type { Theme } from "@/lib/theme";
import { createThemeStore, type ThemeStore } from "@/lib/theme-store";

let store: ThemeStore | undefined;

/** One store per page, made on first use in the browser (the server never subscribes). */
function themeStore(): ThemeStore {
  store ??= createThemeStore({
    storage: () => window.localStorage,
    now: () => new Date(),
    doc: document,
    win: window,
    setInterval: (handler, ms) => window.setInterval(handler, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  });
  return store;
}

const subscribe = (listener: () => void) => themeStore().subscribe(listener);
const getSnapshot = (): Theme => themeStore().getSnapshot();
// The server cannot know the visitor's clock or choice. The page is drawn from the attribute the boot script sets
// before the first paint, so this only decides the markup that hydration compares: after it, React reads the real one.
const getServerSnapshot = (): Theme => "day";

/**
 * The appearance in effect (day or night) and the press that flips it. The boot script in <head> has already set
 * <html data-theme> by the time this runs (THEME_BOOT_SCRIPT), and the style sheet draws from that attribute, so
 * nothing on the page waits for React to look right; this is for what has to say it (aria-checked).
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { theme, toggle: () => themeStore().toggle() };
}

/**
 * Keeps the appearance following the rule on a page that has no switch (the not-found page, an error page): the
 * 60-second re-read, a tab coming back and another tab's choice. Renders nothing.
 */
export function ThemeSync(): null {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return null;
}
