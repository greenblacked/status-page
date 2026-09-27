import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchText, MAX_BODY_BYTES, meterBytes, PayloadError, readBodyCapped, SourceError } from "./http";

const CHUNK = 64 * 1024;

// A body that produces `total` bytes in CHUNK-sized pieces on demand, and
// records how much was pulled and whether the reader cancelled it, so a
// test can tell "stopped early" from "buffered everything, then refused".
function streamOf(total: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= total) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK, total - state.pulled);
      state.pulled += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function stubFetch(response: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
}

describe("readBodyCapped / fetchText size cap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a body under the cap in full", async () => {
    const { stream } = streamOf(3 * CHUNK + 5);
    const body = await readBodyCapped(new Response(stream), "https://status.example.com/a.json");
    expect(body.byteLength).toBe(3 * CHUNK + 5);
  });

  it("stops reading and cancels the stream as soon as the body crosses the cap", async () => {
    const { stream, state } = streamOf(MAX_BODY_BYTES * 4);
    stubFetch(() => new Response(stream, { headers: { "content-type": "application/json" } }));

    const error = await fetchText("https://status.example.com/huge.json").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PayloadError);
    expect((error as Error).message).toBe("Response from status.example.com is larger than 4 MiB");
    expect(state.cancelled).toBe(true);
    // One chunk past the cap at most, not the 16 MiB on offer.
    expect(state.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * CHUNK);
  });

  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const { stream, state } = streamOf(MAX_BODY_BYTES + 1);
    stubFetch(() => new Response(stream, { headers: { "content-length": String(MAX_BODY_BYTES + 1) } }));

    await expect(fetchText("https://status.example.com/declared.json")).rejects.toBeInstanceOf(PayloadError);
    expect(state.pulled).toBeLessThanOrEqual(CHUNK);
    expect(state.cancelled).toBe(true);
  });

  it("does not download an error response's body", async () => {
    const { stream, state } = streamOf(MAX_BODY_BYTES);
    stubFetch(() => new Response(stream, { status: 503, statusText: "Service Unavailable" }));

    const error = await fetchText("https://status.example.com/down.json").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceError);
    expect(error).not.toBeInstanceOf(PayloadError);
    expect((error as SourceError).status).toBe(503);
    expect(state.cancelled).toBe(true);
  });

  it("still times out a body that trickles in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(10));
            // Never closes; the abort signal is the only way out.
            init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        });
        return new Response(stream);
      }),
    );

    await expect(fetchText("https://status.example.com/slow.json", { timeoutMs: 20 })).rejects.toThrow(
      "Timed out fetching status.example.com",
    );
  });

  it("meterBytes counts what every fetch inside it read", async () => {
    stubFetch(() => new Response("x".repeat(1000)));

    const bytes = await meterBytes(async (meter) => {
      await fetchText("https://status.example.com/one.json");
      await fetchText("https://status.example.com/two.json");
      return meter.bytes;
    });

    expect(bytes).toBe(2000);
  });
});
