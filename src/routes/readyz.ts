import { createFileRoute } from "@tanstack/react-router";
import { getStatusBoard } from "@/lib/status/board-cache.server";
import { readiness } from "@/lib/status/readiness";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// GET /readyz: whether the board is fit to serve, for deploy checks, uptime
// monitors and source-health.yml. 200 when the snapshot is under ten minutes
// old and at least one source answered; 503 otherwise, with the same JSON
// saying why. Unlike /healthz it reads the board, so a vendor-wide network
// failures turn it red: never use it as a liveness probe,
// or an orchestrator restarts a healthy server over something a restart
// cannot fix.
export const Route = createFileRoute("/readyz")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const result = readiness(await getStatusBoard(), Date.now());
          return Response.json(result, { status: result.status === "ready" ? 200 : 503, headers: NO_STORE });
        } catch {
          // No board at all (the collection failed):
          // still a well-formed answer, so a monitor sees why, not a bare 500.
          return Response.json({ status: "error" }, { status: 503, headers: NO_STORE });
        }
      },
    },
  },
});
