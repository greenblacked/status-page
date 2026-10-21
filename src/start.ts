import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { methodGuard } from "@/lib/request-methods";
import { nonceForRequest, withSecurityHeaders } from "@/lib/security-headers";

// Every response, pages and API routes alike, leaves with the security headers.
// The Content-Security-Policy carries this request's nonce, the one the router stamps on the page's inline scripts.
const securityHeadersMiddleware = createMiddleware({ type: "request" }).server(async ({ next, request }) => {
  const result = await next();
  // A request that failed before a response existed (a malformed server
  // function call) passes through as it is, rather than failing again here.
  if (!result.response) return result;
  return {
    ...result,
    response: withSecurityHeaders(result.response, { dev: import.meta.env.DEV, nonce: nonceForRequest(request) }),
  };
});

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
