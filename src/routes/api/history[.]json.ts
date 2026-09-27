import { createFileRoute } from "@tanstack/react-router";
import { findCloudflareContext } from "@/lib/status/cloudflare-context";
import { emptyHistory, publicHistory } from "@/lib/status/history";
import { PUBLIC_HEADERS } from "@/lib/status/integrations";
import { readHistory } from "@/lib/status/kv-snapshot-store";

/**
 * GET /api/history.json: rolling UTC-day uptime history from KV `history:v1`.
 * Read-only — no write or admin handler on this path. Same CORS/cache posture
 * as /api/status.json. On the Node build (no KV) or a cold namespace, returns
 * an empty document rather than 503.
 */
export const Route = createFileRoute("/api/history.json")({
  server: {
    handlers: {
      GET: async () => {
        const context = findCloudflareContext();
        const stored = context ? await readHistory(context.env.STATUS_SNAPSHOT) : null;
        const document = stored ?? emptyHistory(new Date(0).toISOString());
        return Response.json(publicHistory(document), { headers: PUBLIC_HEADERS });
      },
    },
  },
});
