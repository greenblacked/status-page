/// <reference types="@cloudflare/workers-types" />
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import type { CloudflareEnv } from "@/lib/status/cloudflare-context";
import { createWorkerFetch } from "@/lib/worker-entry";

// Cloudflare's module entry receives bindings directly. createWorkerFetch
// (src/lib/worker-entry.ts) runs TanStack's handler inside the request's
// Cloudflare context (the bindings, waitUntil and the origin), and gives every
// response, an unhandled error's 500 included, the Worker version, noindex
// where the deployment asks for it and the security headers. Status collection
// is cached in each isolate by the same board-cache.server.ts implementation
// as the Node build, and shared within a data center through the Cache API,
// keyed by the origin.
export default {
  fetch: createWorkerFetch(createStartHandler(defaultStreamHandler)),
} satisfies ExportedHandler<CloudflareEnv>;
