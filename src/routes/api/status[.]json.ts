import { createFileRoute } from "@tanstack/react-router";
import { getStatusBoard } from "@/lib/status/board";
import { respondWithBoard } from "@/lib/status/board-response";
import { PUBLIC_HEADERS, publicStatus } from "@/lib/status/integrations";

// GET /api/status.json: the whole board for scripts, dashboards (Grafana's
// Infinity data source, Home Assistant's REST sensor) and other boards.
export const Route = createFileRoute("/api/status.json")({
  server: {
    handlers: {
      GET: () =>
        respondWithBoard(getStatusBoard, (board) => Response.json(publicStatus(board), { headers: PUBLIC_HEADERS })),
    },
  },
});
