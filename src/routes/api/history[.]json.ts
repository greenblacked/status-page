import { createFileRoute } from "@tanstack/react-router";
import { findCloudflareContext } from "@/lib/status/cloudflare-context";
import { createHistoryResponder } from "@/lib/status/history-response";
import { type HistoryDb, readPublicHistory } from "@/lib/status/history-store";

// The D1 binding exists on the Cloudflare Worker build only. On Node and in
// tests there is none, and the store answers with the empty document.
const respond = createHistoryResponder(() =>
  readPublicHistory((findCloudflareContext()?.env as { HISTORY_DB?: HistoryDb } | undefined)?.HISTORY_DB),
);

/** GET /api/history.json: the last 30 UTC days of per-service aggregates. */
export const Route = createFileRoute("/api/history.json")({
  server: { handlers: { GET: () => respond() } },
});
