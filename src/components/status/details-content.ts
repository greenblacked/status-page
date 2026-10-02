import { useSyncExternalStore } from "react";

/**
 * Whether the browser knows `::details-content` (Chrome 131, Safari 18.4, Firefox 143): the pseudo-element
 * that lets a closed <details> show part of what follows its <summary> (styles.css, `row-details-feed`).
 */
export function supportsDetailsContent(): boolean {
  try {
    return typeof CSS !== "undefined" && CSS.supports("selector(::details-content)");
  } catch {
    return false;
  }
}

const never = () => () => {};

/**
 * `supportsDetailsContent()` for a component. The server and the first client render answer "yes" so they
 * agree; a browser that cannot do it re-renders at once with "no".
 */
export function useDetailsContent(): boolean {
  return useSyncExternalStore(never, supportsDetailsContent, () => true);
}
