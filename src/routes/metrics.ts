import { createFileRoute } from "@tanstack/react-router";
import { getStatusBoard } from "@/lib/status/board";
import { respondWithBoard } from "@/lib/status/board-response";
import { PUBLIC_HEADERS } from "@/lib/status/integrations";
import { METRICS_CONTENT_TYPE, prometheusMetrics } from "@/lib/status/metrics";

// GET /metrics: the board in the Prometheus text format, from the same cached
// snapshot as the page, so scraping it never adds vendor requests.
export const Route = createFileRoute("/metrics")({
  server: {
    handlers: {
      GET: () =>
        respondWithBoard(
          getStatusBoard,
          (board) =>
            new Response(prometheusMetrics(board), {
              headers: { ...PUBLIC_HEADERS, "Content-Type": METRICS_CONTENT_TYPE },
            }),
        ),
    },
  },
});
