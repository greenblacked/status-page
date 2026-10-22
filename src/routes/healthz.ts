import { createFileRoute } from "@tanstack/react-router";

// GET /healthz: liveness for load balancers and Kubernetes probes. It answers
// from the process alone and never reads the board, so a slow vendor cannot
// fail a probe and get a healthy server restarted. The declared length tells
// the Node server the three bytes are not worth compressing.
export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: () =>
        new Response("ok\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Length": "3" },
        }),
    },
  },
});
