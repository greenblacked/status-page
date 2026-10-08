import { type AttributeTarget, type PreferenceStorage, REDUCE_GLASS_BOOT_SCRIPT } from "@/lib/status/glass";

/**
 * The page behind the board: Quiet (warm paper, with a faint grain by day, the default), Glass (frosted
 * panels over a still glow, with a light that wanders across the cards) or Full
 * (adds the drift and the glass lenses). The choice is a preference kept in this
 * browser; the CSS answers to a `data-background` attribute on <html>
 * (src/background.css), which is absent for Quiet. Reduce glass sits above it:
 * with that on, the page stays solid whatever is chosen.
 */
export const BACKGROUND_STORAGE_KEY = "status-bar:background";
export const BACKGROUND_ATTRIBUTE = "data-background";

export const BACKGROUNDS = ["quiet", "glass", "full"] as const;
export type Background = (typeof BACKGROUNDS)[number];
export const DEFAULT_BACKGROUND: Background = "quiet";

/** Quiet unless this browser chose another; anything unreadable counts as Quiet. */
export function parseBackgroundPreference(raw: string | null): Background {
  return (BACKGROUNDS as readonly string[]).includes(raw ?? "") ? (raw as Background) : DEFAULT_BACKGROUND;
}

export function serializeBackgroundPreference(value: Background): string {
  return value;
}

export function readBackground(storage: () => PreferenceStorage): Background {
  try {
    return parseBackgroundPreference(storage().getItem(BACKGROUND_STORAGE_KEY));
  } catch {
    return DEFAULT_BACKGROUND;
  }
}

export function writeBackground(storage: () => PreferenceStorage, value: Background): void {
  try {
    storage().setItem(BACKGROUND_STORAGE_KEY, serializeBackgroundPreference(value));
  } catch {
    // Private windows can refuse storage; the choice then lasts for this visit.
  }
}

/**
 * What a `storage` event from another tab means for this one: the new
 * choice, or null when the event is about another key. A null key is
 * localStorage.clear(), which puts the default back.
 */
export function backgroundFromStorageEvent(event: { key: string | null; newValue: string | null }): Background | null {
  if (event.key === null) return DEFAULT_BACKGROUND;
  if (event.key !== BACKGROUND_STORAGE_KEY) return null;
  return parseBackgroundPreference(event.newValue);
}

/** Quiet is the absence of the attribute, so the server's markup and the default agree. */
export function applyBackground(root: AttributeTarget, value: Background): void {
  if (value === DEFAULT_BACKGROUND) root.removeAttribute(BACKGROUND_ATTRIBUTE);
  else root.setAttribute(BACKGROUND_ATTRIBUTE, value);
}

/**
 * Runs in <head> before the body paints: the Reduce glass line (so a visitor
 * who chose it never sees a frame of blur first) and one that sets
 * `data-background` for Glass or Full, so those never flash Quiet first. The
 * server writes no attribute (<html> carries suppressHydrationWarning), React
 * renders the same markup either way, and the hooks read the stored choices
 * again after hydration. Inline, and run under the page's
 * Content-Security-Policy by the response's nonce (src/lib/security-headers.ts).
 */
export const APPEARANCE_BOOT_SCRIPT = `${REDUCE_GLASS_BOOT_SCRIPT};try{var b=localStorage.getItem(${JSON.stringify(BACKGROUND_STORAGE_KEY)});if(b==="glass"||b==="full")document.documentElement.setAttribute(${JSON.stringify(BACKGROUND_ATTRIBUTE)},b)}catch(e){}`;
