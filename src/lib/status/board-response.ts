import type { BoardSnapshot } from "./types.ts";

/**
 * Seconds a client should wait after a 503 from a board endpoint: long
 * enough for the next Workers cron tick or Node cache refill to have a go,
 * short enough that a feed reader or badge recovers within minutes.
 */
export const BOARD_RETRY_AFTER_SECONDS = 60;

/**
 * Loads the board and builds a response from it, or answers 503 with
 * Retry-After when there is no board to give: on Workers when KV and the
 * fallback collect both failed on an isolate with nothing cached, on Node
 * when a collect throws before anything is cached. A bare 500 reads as a
 * bug and is often retried at once; 503 with Retry-After tells feed
 * readers, Shields.io and scrapers that it is temporary and when to come
 * back. Takes the loader as an argument, so it is the same on both builds
 * and needs no server to test.
 */
export async function respondWithBoard(
  load: () => Promise<BoardSnapshot>,
  respond: (board: BoardSnapshot) => Response,
): Promise<Response> {
  let board: BoardSnapshot;
  try {
    board = await load();
  } catch (error) {
    console.error(
      JSON.stringify({ event: "board_unavailable", message: error instanceof Error ? error.message : String(error) }),
    );
    return Response.json(
      { error: "The board is temporarily unavailable. Try again shortly." },
      {
        status: 503,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "Retry-After": String(BOARD_RETRY_AFTER_SECONDS),
        },
      },
    );
  }
  return respond(board);
}
