import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { methodGuard, needsNoCache } from "@/lib/request-methods";
import { nonceForRequest, withSecurityHeaders } from "@/lib/security-headers";

// Every response, pages and API routes alike, leaves with the security headers.
// The Content-Security-Policy carries this request's nonce, the one the router stamps on the page's inline scripts.
// A page, and the board a page polls, also leave marked no-cache when they set no Cache-Control themselves.
const securityHeadersMiddleware = createMiddleware({ type: "request" }).server(
  async ({ next, request, handlerType }) => {
    const result = await next();
    // A request that failed before a response existed (a malformed server
    // function call) passes through as it is, rather than failing again here.
    if (!result.response) return result;
    const response = withSecurityHeaders(result.response, {
      dev: import.meta.env.DEV,
      nonce: nonceForRequest(request),
    });
    if (needsNoCache(request, response, handlerType)) response.headers.set("Cache-Control", "no-cache");
    return { ...result, response };
  },
);

// A method no page or endpoint serves (POST to a page, PUT to the API) gets a
// 405, and OPTIONS a preflight answer, before any route runs. It sits inside
// the security middleware, so those answers carry the same headers; server
// function calls pass through to the CSRF middleware below.
const methodGuardMiddleware = createMiddleware({ type: "request" }).server(({ next, request, handlerType }) => {
  return methodGuard(request, handlerType) ?? next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    securityHeadersMiddleware,
    methodGuardMiddleware,
    createCsrfMiddleware({
      filter: (context) => context.handlerType === "serverFn",
    }),
  ],
}));
