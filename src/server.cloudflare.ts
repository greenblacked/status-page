/// <reference types="@cloudflare/workers-types" />
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { runWithCloudflareContext } from "@/lib/status/cloudflare-context";
import { runScheduledSweep } from "@/lib/status/cron-sweep";
import type { CloudflareEnv } from "@/lib/status/kv-snapshot-store";

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
  fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> | Response {
    return runWithCloudflareContext({ env, waitUntil: ctx.waitUntil.bind(ctx) }, () => handleRequest(request));
  },

  scheduled(_event: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduledSweep(env.STATUS_SNAPSHOT));
  },
};
