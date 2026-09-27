// A routing fake for the global fetch, so collector tests read canned vendor
// payloads instead of the network. Routes are keyed by the exact URL a
// collector fetches; anything unrouted answers 404, never the real network.
import { vi } from "vitest";

export type Handler = () => Response | Promise<Response>;

type Init = { status?: number; statusText?: string };

export function json(body: unknown, init: Init = {}): Handler {
  return () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      statusText: init.statusText,
      headers: { "content-type": "application/json" },
    });
}

export function text(body: string, init: Init = {}): Handler {
  return () =>
    new Response(body, {
      status: init.status ?? 200,
      statusText: init.statusText,
      headers: { "content-type": "text/xml" },
    });
}

// Raw bytes, for a vendor whose payload is not UTF-8 text: the AWS collector
// reads its Health feed as UTF-16 (fetchText's `binary` mode).
export function bytes(body: Uint8Array<ArrayBuffer>, init: Init = {}): Handler {
  return () =>
    new Response(body, {
      status: init.status ?? 200,
      statusText: init.statusText,
      headers: { "content-type": "application/json" },
    });
}

/** `text` encoded as UTF-16LE behind a byte-order mark. */
export function utf16(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(`\uFEFF${text}`, "utf16le"));
}

// Simulates a network-level failure (DNS, connection reset, …) rather than
// an HTTP error response: the handler rejects instead of returning a Response.
export function networkError(message = "fetch failed"): Handler {
  return () => Promise.reject(new TypeError(message));
}

export function stubFetch(routes: Partial<Record<string, Handler>>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = routes[url];
    if (!handler) return new Response("not found", { status: 404, statusText: "Not Found" });
    return handler();
  });
}
