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
