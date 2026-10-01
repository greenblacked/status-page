// Whether this browser can show alerts from a page. Kept apart from the hook
// so it can be tested against a fake navigator.

export interface AlertsNavigator {
  platform?: string;
  maxTouchPoints?: number;
  /** Present on every Cocoa WebKit: iOS, iPadOS and, since Safari 17, macOS. */
  standalone?: boolean;
}

/**
 * iPhone and iPad never show `new Notification()` from a page: they take web
 * push through a service worker, in a Home Screen app only. macOS Safari
 * shows them. `standalone` alone cannot tell the two apart, since it exists
 * on every Cocoa WebKit; a Mac reports no touch points, while an iPhone or
 * an iPad, even in desktop mode where it calls itself a Mac, reports some.
 */
export function pageAlertsUnsupported(nav: AlertsNavigator): boolean {
  return "standalone" in nav && (nav.maxTouchPoints ?? 0) > 0;
}

export const ALERTS_UNSUPPORTED_ATTRIBUTE = "data-alerts";

/**
 * Runs in <head> before the body paints and marks <html> when this browser
 * cannot show page alerts (no Notification, or an iPhone or iPad), the same
 * test as `pageAlertsUnsupported` and the alerts hook, written out because
 * it has to run as a string. The board still renders the Alerts button, so
 * every other browser gets it in the first paint; a CSS rule hides it where
 * the attribute is set, so an iPhone never shows it and nothing moves when
 * the hook takes it out after hydration. Inline, as the Reduce glass script.
 */
export const ALERTS_BOOT_SCRIPT = `try{var n=navigator;if(!("Notification" in window)||("standalone" in n&&(n.maxTouchPoints||0)>0))document.documentElement.setAttribute(${JSON.stringify(ALERTS_UNSUPPORTED_ATTRIBUTE)},"unsupported")}catch(e){}`;
