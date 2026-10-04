// Response headers for every page and API response. The board has no login,
// no cookies and no user content, so these are defence in depth: they stop
// it being framed, sniffed or made to load scripts from anywhere else.

/**
 * A fresh, unguessable value for one response's `script-src`. 128 bits from
 * the platform's CSPRNG (Workers and Node both have `crypto`), in base64,
 * which is what a CSP nonce is written in.
 */
export function createNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

const nonces = new WeakMap<Request, string>();

/**
 * The nonce of one request: the first call makes it, later calls (the
 * middleware that writes the header, the router that stamps the page's
 * inline scripts) read the same one, so the header and the markup of a
 * response always agree, and no two requests ever share one.
 */
export function nonceForRequest(request: Request): string {
  let nonce = nonces.get(request);
  if (nonce === undefined) {
    nonce = createNonce();
    nonces.set(request, nonce);
  }
  return nonce;
}

/**
 * `script-src` allows a script only by its per-response nonce: the
 * framework's hydration and streaming scripts and the board's own inline
 * boot scripts carry it (the router stamps it from `nonceForRequest`), and
 * 'strict-dynamic' lets those trusted scripts load the rest of the bundle.
 * An injected `<script>` has no nonce and is blocked, inline or not.
 *
 * 'self' stays only as the fallback for a browser too old to know
 * 'strict-dynamic' (it still honours the nonce); a browser that knows it
 * ignores 'self'. There is no 'unsafe-inline' here: a browser that reads
 * the nonce ignores it anyway, and one that does not would run an injected
 * script with it.
 *
 * `style-src` keeps 'unsafe-inline' on purpose. The page needs inline
 * styles that no nonce can cover: React writes `style="..."` attributes
 * (the board sets custom properties and sizes that way). A style cannot run
 * code, so the exposure is limited to restyling the page, which is not what
 * this policy guards. `style-src-attr` could one day tighten this.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'self'`,
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
}

/**
 * In development the Vite client injects scripts and opens a websocket, so
 * the Content-Security-Policy is left out there; everything else applies.
 */
export function securityHeaders({ dev, nonce }: { dev: boolean; nonce: string }): Record<string, string> {
  return {
    ...(dev ? {} : { "Content-Security-Policy": contentSecurityPolicy(nonce) }),
    // Browsers ignore it over plain HTTP, so local previews are unaffected.
    // includeSubDomains covers the staging site on a subdomain of the same
    // HTTPS-only Worker. No `preload`: that is a commitment made to browsers
    // through a list, not something a response header should opt into alone.
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

/** Adds the headers a response does not already set, on a mutable copy. */
export function withSecurityHeaders(response: Response, { dev, nonce }: { dev: boolean; nonce: string }): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders({ dev, nonce }))) {
    if (!copy.headers.has(name)) copy.headers.set(name, value);
  }
  return copy;
}
