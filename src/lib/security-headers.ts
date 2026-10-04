// Response headers for every page and API response. The board has no login,
// no cookies and no user content, so these are defence in depth: they stop
// it being framed, sniffed or made to load scripts from anywhere else.

/**
 * `script-src` keeps 'unsafe-inline' because the framework writes the
 * hydration state as inline scripts. It still blocks every script from
 * another origin, which is what an injected tag would need.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // manifest-src falls back to default-src: the web manifest and its icons
  // are served from public/, same origin, like the apple-touch-icon.
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Browsers ignore it over plain HTTP, so local previews are unaffected.
 * includeSubDomains covers the staging site on a subdomain of the same
 * HTTPS-only Worker. No `preload`: that is a commitment made to browsers
 * through a list, not something a response header should opt into alone.
 * The Node server (src/node) does not use this default: a self-hoster's
 * domain may carry plain-HTTP services, so it sends no includeSubDomains
 * unless asked to.
 */
export const DEFAULT_HSTS = "max-age=31536000; includeSubDomains";

/**
 * In development the Vite client injects scripts and opens a websocket, so
 * the Content-Security-Policy is left out there; everything else applies.
 */
export function securityHeaders({
  dev,
  hsts = DEFAULT_HSTS,
}: {
  dev: boolean;
  /** The Strict-Transport-Security value, or false to leave the header out (a server that decides it for itself). */
  hsts?: string | false;
}): Record<string, string> {
  return {
    ...(dev ? {} : { "Content-Security-Policy": CONTENT_SECURITY_POLICY }),
    ...(hsts === false ? {} : { "Strict-Transport-Security": hsts }),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

/** Adds the headers a response does not already set, on a mutable copy. */
export function withSecurityHeaders(response: Response, { dev }: { dev: boolean }): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders({ dev }))) {
    if (!copy.headers.has(name)) copy.headers.set(name, value);
  }
  return copy;
}
