/// <reference types="@cloudflare/workers-types" />
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { isNoindex, withNoindex } from "@/lib/robots";
import { type CloudflareEnv, runWithCloudflareContext } from "@/lib/status/cloudflare-context";
import { runScheduledHistory } from "@/lib/status/history-cron";
import { withWorkerVersion } from "@/lib/worker-version";

// Cloudflare's module entry receives bindings directly. TanStack's handler
// uses the request context for robots.txt; status collection is cached in
// each isolate by the same board.ts implementation as the Node build. The
// scheduled handler records uptime history (history-cron.ts).
const handleRequest = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
    const response = withWorkerVersion(
      await runWithCloudflareContext({ env, waitUntil: ctx.waitUntil.bind(ctx) }, () => handleRequest(request)),
      env.CF_VERSION_METADATA?.id,
    );
    return isNoindex(env.ROBOTS) ? withNoindex(response) : response;
  },

  // Cron Trigger (wrangler.jsonc): samples the board into D1 every five
  // minutes. Awaited rather than handed to waitUntil, so a failing run shows
  // as failed in the dashboard's cron events.
  async scheduled(controller: ScheduledController, env: CloudflareEnv): Promise<void> {
    await runScheduledHistory(env, controller.scheduledTime);
  },
};
