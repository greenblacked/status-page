// Whether search engines may index this deployment. Production and any
// self-hosted Node build may; the staging Worker (wrangler.jsonc's
// env.staging sets ROBOTS=noindex) must not, or a half-finished dev build
// competes with the real board in search results. Platform-neutral: the
// caller says which deployment it is.

export const NOINDEX_HEADER_VALUE = "noindex, nofollow";

/** True only for the exact value wrangler.jsonc sets; anything else indexes. */
export function isNoindex(robots: string | undefined): boolean {
  return robots === "noindex";
}

/** The /robots.txt body for a deployment. */
export function robotsTxt(noindex: boolean): string {
  return noindex ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nAllow: /\n";
}

/** A copy of `response` carrying X-Robots-Tag, for deployments that must not be indexed. */
export function withNoindex(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("X-Robots-Tag", NOINDEX_HEADER_VALUE);
  return copy;
}
