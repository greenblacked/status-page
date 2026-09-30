import { createFileRoute } from "@tanstack/react-router";
import { emptyHistory, publicHistory } from "@/lib/status/history";
import { PUBLIC_HEADERS } from "@/lib/status/integrations";

/** Preserve the endpoint shape for clients; no persistent history is collected. */
export const Route = createFileRoute("/api/history.json")({
  server: {
    handlers: {
      GET: () => Response.json(publicHistory(emptyHistory(new Date(0).toISOString())), { headers: PUBLIC_HEADERS }),
    },
  },
});
