import { createFileRoute } from "@tanstack/react-router";
import { getStatusBoard } from "@/lib/status/board-cache.server";
import { respondWithBoard } from "@/lib/status/board-response";
import { atomFeed, PUBLIC_HEADERS } from "@/lib/status/integrations";

// GET /feed.xml: an Atom feed of the services that need attention.
export const Route = createFileRoute("/feed.xml")({
  server: {
    handlers: {
      GET: ({ request }) =>
        respondWithBoard(
          getStatusBoard,
          (board) =>
            new Response(atomFeed(board, new URL(request.url).origin), {
              headers: { ...PUBLIC_HEADERS, "Content-Type": "application/atom+xml; charset=utf-8" },
            }),
        ),
    },
  },
});
