// Whether this browser can show alerts from a page. Kept apart from the hook
// so it can be tested against a fake navigator.

export interface AlertsNavigator {
  platform?: string;
  maxTouchPoints?: number;
  /** Present on iOS and iPadOS Safari only. */
  standalone?: boolean;
}

/**
 * iPhone, iPad and iPadOS Safari never show `new Notification()` from a page:
 * they take web push through a service worker, in a Home Screen app only.
 * `standalone` exists on iOS and iPadOS Safari and nowhere else. An iPad in
 * desktop mode reports itself as a Mac, so it is told apart by touch, and
 * only when it also lacks push. A real Mac has no touch points and keeps its
 * alerts.
 */
export function pageAlertsUnsupported(nav: AlertsNavigator, hasPush: boolean): boolean {
  if ("standalone" in nav) return true;
  return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1 && !hasPush;
}
