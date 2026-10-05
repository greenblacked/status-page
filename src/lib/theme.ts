/**
 * Day and night. The board has two appearances and one rule for which a visitor sees:
 *
 *   1. A choice made with the header switch, kept in localStorage under "theme" ("day" or "night"), wins.
 *   2. With nothing kept, the visitor's own clock decides: night from 20:00 to 06:00, day from 06:00 to 20:00.
 *   3. With scripts off there is no choice and no clock: <html> has no data-theme, and the style sheet follows the
 *      system's prefers-color-scheme as it always did.
 *
 * Everything that has to know the appearance (the tokens, scrollbars and form controls, the theme-color meta, the
 * switch) reads it from one place, the data-theme attribute on <html>, which is written only by `applyTheme`. The
 * pure rule is `themeFor`; nothing else decides.
 */
export type Theme = "day" | "night";

export const THEME_STORAGE_KEY = "theme";
export const THEME_ATTRIBUTE = "data-theme";

/** The clock rule: night from this hour (inclusive) ... */
export const NIGHT_FROM_HOUR = 20;
/** ... until this one (exclusive). */
export const NIGHT_UNTIL_HOUR = 6;

/** How often the rule is read again while the page stays open, so a board left open through dusk follows the clock. */
export const THEME_REFRESH_MS = 60_000;

/**
 * The theme-color of each theme: --color-bg in src/styles.css, in its light and its dark value (a test holds the
 * two together). The tab strip, a Home Screen app's status bar and Android's toolbar take it.
 */
export const THEME_COLORS: Record<Theme, string> = { day: "#f4f1eb", night: "#000000" };

export function isNightHour(hour: number): boolean {
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR;
}

/** "day" or "night" when that is what was stored; anything else (junk, nothing) is no choice. */
export function parseTheme(raw: unknown): Theme | null {
  return raw === "day" || raw === "night" ? raw : null;
}

/** The rule: a stored choice wins, otherwise the hour (0 to 23, the visitor's own) decides. */
export function themeFor(stored: unknown, hour: number): Theme {
  return parseTheme(stored) ?? (isNightHour(hour) ? "night" : "day");
}

/** Where the choice is kept; a getter, since merely reading window.localStorage can throw. */
export type ThemeStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** The stored choice, or null when there is none or storage cannot be read (a private window, blocked site data). */
export function readStoredTheme(storage: () => ThemeStorage): Theme | null {
  try {
    return parseTheme(storage().getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Keeps the choice; false when storage refused, so the caller can hold it for this visit instead. */
export function writeStoredTheme(storage: () => ThemeStorage, theme: Theme): boolean {
  try {
    storage().setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

/** What a `storage` event means for the theme: the stored choice may have changed (another tab, or localStorage.clear()). */
export function themeStorageEventMatters(event: { key: string | null }): boolean {
  return event.key === null || event.key === THEME_STORAGE_KEY;
}

/** The part of a document `applyTheme` needs, so a test can pass a stand-in. */
export type ThemeDocument = {
  documentElement: { setAttribute(name: string, value: string): void };
  querySelectorAll(selector: string): ArrayLike<{ setAttribute(name: string, value: string): void }>;
};

/** The one place the appearance is written: <html data-theme> and every theme-color meta. */
export function applyTheme(doc: ThemeDocument, theme: Theme): void {
  doc.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
  const metas = doc.querySelectorAll('meta[name="theme-color"]');
  for (let at = 0; at < metas.length; at++) metas[at]?.setAttribute("content", THEME_COLORS[theme]);
}

/**
 * Runs in <head>, after the theme-color metas and before the body paints, so a visitor at night never sees a frame
 * of paper. It is `themeFor` and `applyTheme` written out for a script that cannot import (a test runs the two side
 * by side). Storage is read in a try: a private window or blocked site data falls back to the clock. Inline, and
 * run under the page's Content-Security-Policy by the response's nonce (src/lib/security-headers.ts).
 */
export const THEME_BOOT_SCRIPT = `(function(){var s=null;try{s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}var h=new Date().getHours();var t=s==="night"||(s!=="day"&&(h>=${NIGHT_FROM_HOUR}||h<${NIGHT_UNTIL_HOUR}))?"night":"day";var d=document;d.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t);var m=d.querySelectorAll('meta[name="theme-color"]');var c=t==="night"?${JSON.stringify(THEME_COLORS.night)}:${JSON.stringify(THEME_COLORS.day)};for(var i=0;i<m.length;i++)m[i].setAttribute("content",c)})();`;
