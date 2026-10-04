import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { ErrorPage } from "@/components/status/error-page";
import { NotFoundPage } from "@/components/status/not-found";
import { nonceForRequest } from "@/lib/security-headers";
import { routeTree } from "./routeTree.gen";

// The nonce of the request being rendered, the one the Content-Security-Policy header of its response names
// (src/start.ts). The router writes it on every inline script it emits (hydration, streaming, the head and body
// scripts) and into a <meta property="csp-nonce"> the browser's router reads back. The browser has no nonce to
// make: the server's scripts are already running by then, so only the server branch exists.
const renderingNonce = createIsomorphicFn()
  .server(() => {
    try {
      return nonceForRequest(getRequest());
    } catch {
      // Outside a request (a router built for a redirect after the middleware ran): nothing to stamp.
      return undefined;
    }
  })
  .client(() => undefined);

export function getRouter() {
  return createRouter({
    routeTree,
    ssr: { nonce: renderingNonce() },
    scrollRestoration: true,
    // Off the board, the same voice and type instead of the router's unbranded defaults.
    defaultNotFoundComponent: NotFoundPage,
    defaultErrorComponent: ErrorPage,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
