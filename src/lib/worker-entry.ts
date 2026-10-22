import { isNoindex, withNoindex } from "./robots";
import { nonceForRequest, withSecurityHeaders } from "./security-headers";
import { type CloudflareEnv, runWithCloudflareContext } from "./status/cloudflare-context";
import { withWorkerVersion } from "./worker-version";

// The Cloudflare Worker's fetch handler around TanStack Start's
// (src/server.cloudflare.ts). It runs each request inside its Cloudflare
// context (the bindings, waitUntil and the origin the shared board snapshot is
// keyed by), and puts the headers every Worker response needs on whatever
// comes back: X-Worker-Version, X-Robots-Tag on a noindex deployment, and the
// security headers. Start's own middleware (src/start.ts) sets those on the
// responses it builds; a response it never saw, an error Start answered by
// itself or a handler that threw, would leave without them, so they are
// filled in here too, never overriding what a response already sets.

/** The part of a Worker's ExecutionContext this needs. */
type WorkerContext = { waitUntil(promise: Promise<unknown>): void };

export function createWorkerFetch(handle: (request: Request) => Response | Promise<Response>) {
  return async function fetch(request: Request, env: CloudflareEnv, ctx: WorkerContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      response = await runWithCloudflareContext({ env, waitUntil: ctx.waitUntil.bind(ctx), origin: url.origin }, () =>
        handle(request),
      );
    } catch (error) {
      // Only the path: the query may carry anything, and the message is enough to find the cause.
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "unhandled_error", path: url.pathname, message }));
      response = new Response("Internal Server Error\n", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const versioned = withWorkerVersion(response, env.CF_VERSION_METADATA?.id);
    const indexed = isNoindex(env.ROBOTS) ? withNoindex(versioned) : versioned;
    return withSecurityHeaders(indexed, { dev: false, nonce: nonceForRequest(request) });
  };
}
