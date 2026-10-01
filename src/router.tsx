import { createRouter } from "@tanstack/react-router";
import { ErrorPage } from "@/components/status/error-page";
import { NotFoundPage } from "@/components/status/not-found";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
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
