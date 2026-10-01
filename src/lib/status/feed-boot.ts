import { PULSE_STORAGE_KEY } from "./pulse.ts";
import { RECENT_LIMIT } from "./recent.ts";

/** The custom property on <html> that holds how many rows Recent changes will draw once the saved checks load. */
export const FEED_ROWS_PROPERTY = "--feed-rows";

/**
 * Runs in <head> before the body paints. The saved checks live in local
 * storage, so the server (and the first client render) draws Recent changes
 * empty, and it would grow by up to eight rows after hydration and push the
 * board below it down. This counts the rows `recentRows` will draw, from the
 * same key: the first RECENT_LIMIT checks, a run of checks with no change
 * being one row. The empty state reserves that many rows of height
 * (update-feed.tsx). Any failure leaves the property unset, which reads as 0.
 * Inline, which the page's Content-Security-Policy allows ('unsafe-inline'
 * in script-src).
 */
export const FEED_BOOT_SCRIPT = `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(PULSE_STORAGE_KEY)})).pulses,n=0,q=false;if(Array.isArray(p)){p=p.slice(0,${RECENT_LIMIT});for(var i=0;i<p.length;i++){var x=p[i],z=!!x&&!x.opening&&Array.isArray(x.changes)&&x.changes.length===0;if(!(z&&q))n++;q=z}document.documentElement.style.setProperty(${JSON.stringify(FEED_ROWS_PROPERTY)},String(n))}}catch(e){}`;
