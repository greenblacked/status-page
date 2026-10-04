import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
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

export const startInstance = createStart(() => ({
  requestMiddleware: [
    securityHeadersMiddleware,
    createCsrfMiddleware({
      filter: (context) => context.handlerType === "serverFn",
    }),
  ],
}));
