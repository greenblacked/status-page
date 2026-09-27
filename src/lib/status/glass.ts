/**
 * Reduce glass: solid panels, no blur and a still backdrop. Safari does not
 * pass the system's Reduce Transparency setting to web pages, so the board
 * has its own switch. It sets this attribute on <html>, which the same CSS
 * as `@media (prefers-reduced-transparency: reduce)` answers to.
 */
export const REDUCE_GLASS_STORAGE_KEY = "status-bar:reduce-glass";
export const REDUCE_GLASS_ATTRIBUTE = "data-reduce-transparency";

/** Off unless this browser switched it on; anything unreadable counts as off. */
export function parseReduceGlassPreference(raw: string | null): boolean {
  return raw === "on";
}

export function serializeReduceGlassPreference(on: boolean): string {
  return on ? "on" : "off";
}

/** The part of an element this needs, so tests can pass a stand-in. */
export type AttributeTarget = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export function applyReduceGlass(root: AttributeTarget, on: boolean): void {
  if (on) root.setAttribute(REDUCE_GLASS_ATTRIBUTE, "true");
  else root.removeAttribute(REDUCE_GLASS_ATTRIBUTE);
}

/**
 * Runs in <head> before the body paints, so a visitor who chose Reduce
 * glass never sees a frame of blur first. It only adds an attribute to
 * <html>; React renders the same markup either way, and the switch reads
 * the stored choice again after hydration. Inline, which the page's
 * Content-Security-Policy allows ('unsafe-inline' in script-src).
 */
export const REDUCE_GLASS_BOOT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(REDUCE_GLASS_STORAGE_KEY)})==="on")document.documentElement.setAttribute(${JSON.stringify(REDUCE_GLASS_ATTRIBUTE)},"true")}catch(e){}`;
