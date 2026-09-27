/// <reference types="@cloudflare/workers-types" />
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { isNoindex, withNoindex } from "@/lib/robots";
import { runWithCloudflareContext } from "@/lib/status/cloudflare-context";
import { runScheduledSweep } from "@/lib/status/cron-sweep";
import type { CloudflareEnv } from "@/lib/status/kv-snapshot-store";
import { withWorkerVersion } from "@/lib/worker-version";

// wrangler.jsonc's `main`, used only for DEPLOY_TARGET=cloudflare builds.
// TanStack Start's own default entry (@tanstack/react-start/server-entry)
// only exports `fetch`, which is all `npm run preview`'s plain Node handler
// needs. Workers module syntax also wants a `scheduled` export for the Cron
// Trigger, and both need the `env` bindings and `ExecutionContext.waitUntil`
// that only workerd's own call to `fetch`/`scheduled` provides - TanStack's
// handler takes only a Request. This entry threads them through with the
// same AsyncLocalStorage-based request context TanStack Start itself uses
// (cloudflare-context.ts).
const handleRequest = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
    // Every response the Worker makes names the version that made it, for
    // the deploy's smoke test (worker-version.ts). Static assets never
    // reach the Worker, so they carry no version; /healthz always does.
    const response = withWorkerVersion(
      await runWithCloudflareContext({ env, waitUntil: ctx.waitUntil.bind(ctx) }, () => handleRequest(request)),
      env.CF_VERSION_METADATA?.id,
    );
    // The staging Worker (ROBOTS=noindex in wrangler.jsonc) is public but
    // must not be indexed. Set here, on every response the Worker makes,
    // rather than in security-headers.ts, which stays the same for both
    // builds. Static assets never reach the Worker; robots.txt covers them.
    return isNoindex(env.ROBOTS) ? withNoindex(response) : response;
  },

  // Awaited rather than handed to waitUntil, so a sweep that throws shows as
  // a failed cron run in the dashboard's past events, which is what to alert on.
  async scheduled(_event: ScheduledController, env: CloudflareEnv): Promise<void> {
    await runScheduledSweep(env.STATUS_SNAPSHOT);
  },
};
