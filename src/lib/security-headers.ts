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
 * In development the Vite client injects scripts and opens a websocket, so
 * the Content-Security-Policy is left out there; everything else applies.
 */
export function securityHeaders({ dev }: { dev: boolean }): Record<string, string> {
  return {
    ...(dev ? {} : { "Content-Security-Policy": CONTENT_SECURITY_POLICY }),
    // Browsers ignore it over plain HTTP, so local previews are unaffected.
    "Strict-Transport-Security": "max-age=31536000",
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
