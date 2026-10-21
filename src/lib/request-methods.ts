// Which HTTP methods the board answers. Every page and endpoint is read-only,
// so GET and HEAD go through; OPTIONS is a preflight; anything else is a 405,
// not the page's HTML with a 200. Server function calls (Refresh is a POST)
// are left to the framework, whose CSRF middleware guards them.

export const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

const SERVER_FN_PREFIX = "/_serverFn/";

// The endpoints other sites read with fetch(): dashboards, badges, feed
// readers and monitors. Their GET answers already carry
// Access-Control-Allow-Origin: *, and a preflight has to agree.
const PUBLIC_PATH = /^\/(?:api\/.*|feed\.xml|metrics|healthz|readyz)$/;

/**
 * The answer for a request whose method the board does not serve, or
 * undefined to let it through: GET, HEAD and every server function call.
 * Without a handler type (the framework did not say), a path under
 * /_serverFn/ counts as a server function call.
 */
export function methodGuard(request: Request, handlerType?: "serverFn" | "router"): Response | undefined {
  const { pathname } = new URL(request.url);
  const serverFn = handlerType === undefined ? pathname.startsWith(SERVER_FN_PREFIX) : handlerType === "serverFn";
  if (serverFn) return undefined;

  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  if (method === "OPTIONS") {
    const headers = new Headers({ Allow: ALLOWED_METHODS, "Cache-Control": "no-store" });
    if (PUBLIC_PATH.test(pathname)) {
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
      headers.set("Access-Control-Allow-Headers", "*");
      headers.set("Access-Control-Max-Age", "86400");
    }
    return new Response(null, { status: 204, headers });
  }

  return new Response("Method Not Allowed\n", {
    status: 405,
    headers: { Allow: ALLOWED_METHODS, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}
