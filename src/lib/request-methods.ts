// Which HTTP methods the board answers. Every page and endpoint is read-only,
// so GET and HEAD go through; OPTIONS is a preflight; anything else is a 405,
// not the page's HTML with a 200. Server function calls (Refresh is a POST)
// are left to the framework, whose CSRF middleware guards them. It also
// decides which answers leave marked no-cache (needsNoCache, below).

export const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

const SERVER_FN_PREFIX = "/_serverFn/";

/** Which of the framework's handlers is answering: a server function call, or a page or server route. */
type HandlerType = "serverFn" | "router";

// The endpoints other sites read with fetch(): dashboards, badges, feed
// readers and monitors. Their GET answers already carry
// Access-Control-Allow-Origin: *, and a preflight has to agree.
const PUBLIC_PATH = /^\/(?:api\/.*|feed\.xml|metrics|healthz|readyz)$/;

/** A server function call, by the framework's word or, without it, by its path under /_serverFn/. */
function isServerFn(request: Request, handlerType: HandlerType | undefined): boolean {
  if (handlerType !== undefined) return handlerType === "serverFn";
  return new URL(request.url).pathname.startsWith(SERVER_FN_PREFIX);
}

/**
 * The answer for a request whose method the board does not serve, or
 * undefined to let it through: GET, HEAD and every server function call.
 */
export function methodGuard(request: Request, handlerType?: HandlerType): Response | undefined {
  if (isServerFn(request, handlerType)) return undefined;

  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  if (method === "OPTIONS") {
    const headers = new Headers({ Allow: ALLOWED_METHODS, "Cache-Control": "no-store" });
    if (PUBLIC_PATH.test(new URL(request.url).pathname)) {
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

/**
 * Whether an answer should leave with `Cache-Control: no-cache`: a page
 * (HTML) or a GET server function answer (the board the page polls) that
 * set no Cache-Control of its own. Without one a browser may reuse either
 * heuristically, and show an old board. no-cache, not no-store: a browser
 * revalidates before reuse, and the back-forward cache still keeps the page.
 */
export function needsNoCache(request: Request, response: Response, handlerType?: HandlerType): boolean {
  if (response.headers.has("Cache-Control")) return false;
  const type = (response.headers.get("Content-Type") ?? "").toLowerCase();
  if (type.startsWith("text/html")) return true;
  return isServerFn(request, handlerType) && request.method === "GET" && type.includes("json");
}
