import { findCloudflareContext } from "./cloudflare-context";
import { SHARED_SNAPSHOT_MAX_AGE_S } from "./schedule";
import type { Entry, SharedStore } from "./ttl-cache";
import type { BoardSnapshot } from "./types";

// The board snapshot the isolates of one Cloudflare data center share: the
// second level of the board cache (board-cache.server.ts), kept in the Workers
// Cache API (`caches.default`), which is local to a data center and needs no
// binding. A cold isolate starts from it instead of a vendor sweep, and an
// isolate whose own snapshot has expired adopts a fresher one a peer wrote.
//
// It is keyed by the request's origin and the Worker version, so production
// and stage never share a snapshot, and a deploy, whose board may have another
// shape, starts with an empty one. It is never served to anyone: the key is
// only ever read here, by `match`, inside the Worker.
//
// Fail-soft: the Cache API is not there in every place a Worker runs (behind
// Cloudflare Access, on workers.dev, in local tools), so the first call that
// throws or rejects turns the store off for the isolate, and the board cache
// carries on with its own level alone.

const COLLECTED_AT_HEADER = "X-Board-Collected-At";
const KEY_PATH = "/__status-board/snapshot";

/** The part of the Workers Cache API this uses. */
type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

let disabled = false;

function disable(error: unknown): void {
  if (disabled) return;
  disabled = true;
  console.warn(
    JSON.stringify({
      event: "board_store_disabled",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** `caches.default` on Workers; undefined in Node, where `caches` is absent or has no `default`. */
function edgeCache(): EdgeCache | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { default?: EdgeCache }).default;
}

/** The minimal shape of a board: enough that a damaged entry is a miss rather than a broken page. */
function isBoard(value: unknown): value is BoardSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const board = value as Record<string, unknown>;
  return (
    typeof board.generatedAt === "string" &&
    Array.isArray(board.services) &&
    typeof board.counts === "object" &&
    board.counts !== null
  );
}

/**
 * The shared store for the request in hand, or undefined where there is none:
 * outside a Worker request, without the version metadata or the request's
 * origin, without the Cache API, or once it has failed in this isolate.
 */
export function cloudflareBoardStore(): SharedStore<BoardSnapshot> | undefined {
  if (disabled) return undefined;
  const context = findCloudflareContext();
  const versionId = context?.env.CF_VERSION_METADATA?.id;
  const cache = edgeCache();
  if (!context?.origin || !versionId || !cache) return undefined;
  const url = `${context.origin}${KEY_PATH}?v=${encodeURIComponent(versionId)}`;
  const key = () => new Request(url, { method: "GET" });

  return {
    async read(): Promise<Entry<BoardSnapshot> | undefined> {
      let response: Response | undefined;
      try {
        response = await cache.match(key());
      } catch (error) {
        disable(error);
        return undefined;
      }
      if (!response) return undefined;
      const at = Number(response.headers.get(COLLECTED_AT_HEADER));
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return undefined;
      }
      if (!Number.isFinite(at) || at <= 0 || !isBoard(value)) return undefined;
      return { at, value };
    },

    write(entry: Entry<BoardSnapshot>): void {
      try {
        const response = new Response(JSON.stringify(entry.value), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${SHARED_SNAPSHOT_MAX_AGE_S}`,
            [COLLECTED_AT_HEADER]: String(entry.at),
          },
        });
        context.waitUntil(cache.put(key(), response).catch(disable));
      } catch (error) {
        disable(error);
      }
    },
  };
}

/** Turns the store back on after a test turned it off. */
export function __resetBoardStoreForTests(): void {
  disabled = false;
}
