/**
 * A link taken from a vendor payload, made safe to put on a card, in the
 * JSON API and in the Atom feed: returned only when it is an http(s) URL
 * with no credentials in it and, when `allowedHosts` is given, on one of
 * those hosts or a subdomain of one. Anything else (a `javascript:` or
 * `data:` URL, a link to an unrelated site, text that is not a URL) gives
 * `fallback`, the service's own catalog page, so a changed or tampered
 * feed can at worst link to the vendor's front page.
 *
 * A relative link resolves against `fallback`, which is how Google's
 * incidents.json writes its `uri` ("incidents/<id>"). Pure, and imports
 * nothing, so it is tested on its own.
 */
export function vendorUrl(raw: string | null | undefined, fallback: string, allowedHosts?: readonly string[]): string {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  let url: URL;
  try {
    url = new URL(raw.trim(), fallback);
  } catch {
    return fallback;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
  if (url.username || url.password) return fallback;
  if (allowedHosts && !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    return fallback;
  }
  return url.href;
}

/** The hostname of a URL the code itself defines, such as a catalog sourceUrl. */
export function hostOf(url: string): string {
  return new URL(url).hostname;
}
