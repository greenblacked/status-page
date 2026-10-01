import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchText, MAX_BODY_BYTES, meterBytes, PayloadError, readBodyCapped, SourceError, unwrapJsonp } from "./http";

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

describe("unwrapJsonp", () => {
  it("unwraps a callback call, with or without a trailing semicolon and whitespace", () => {
    expect(unwrapJsonp('cb({"a":1})')).toBe('{"a":1}');
    expect(unwrapJsonp('cb({"a":1});')).toBe('{"a":1}');
    expect(unwrapJsonp('$_cb1({"a":(1)})  ;  \n')).toBe('{"a":(1)}');
    expect(unwrapJsonp("cb([1, 2])")).toBe("[1, 2]");
  });

  it("leaves anything that is not a plain callback call unchanged", () => {
    for (const body of [
      '{"a":(1)}',
      "[1]",
      "",
      "cb()",
      "1cb({})",
      "a.b({})",
      "a b({})",
      "(1)",
      "cb({}) x",
      "cb({});;",
      "cb({}",
      "cb{})",
    ]) {
      expect(unwrapJsonp(body)).toBe(body);
    }
  });
});

describe("fetchText redirects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const redirect = (location: string | null, status = 302) =>
    new Response(null, { status, headers: location === null ? {} : { location } });

  // Answers each URL from `routes` and records every request made.
  function routed(routes: Record<string, () => Response>) {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, redirect: init.redirect });
        const route = routes[url];
        return route ? route() : new Response("not found", { status: 404, statusText: "Not Found" });
      }),
    );
    return calls;
  }

  it("asks for redirects by hand, so none is followed without being checked", async () => {
    const calls = routed({ "https://status.example.com/a": () => new Response("ok") });
    await fetchText("https://status.example.com/a");
    expect(calls).toEqual([{ url: "https://status.example.com/a", redirect: "manual" }]);
  });

  it("follows a redirect on the same host, relative or absolute, and reads the final body", async () => {
    const calls = routed({
      "https://status.example.com/a": () => redirect("/b", 301),
      "https://status.example.com/b": () => redirect("https://status.example.com/c", 307),
      "https://status.example.com/c": () => new Response("final"),
    });
    const { body } = await fetchText("https://status.example.com/a");
    expect(body).toBe("final");
    expect(calls.map((call) => call.url)).toEqual([
      "https://status.example.com/a",
      "https://status.example.com/b",
      "https://status.example.com/c",
    ]);
  });

  it("follows a redirect to a host the vendor is known to use for the same data", async () => {
    routed({
      "https://upgrade.mikrotik.com/routeros/NEWESTa7.stable": () =>
        redirect("https://download.mikrotik.com/routeros/NEWESTa7.stable"),
      "https://download.mikrotik.com/routeros/NEWESTa7.stable": () => new Response("7.16"),
    });
    expect((await fetchText("https://upgrade.mikrotik.com/routeros/NEWESTa7.stable")).body).toBe("7.16");
  });

  it.each([
    ["another site", "https://evil.example.net/steal", "evil.example.net"],
    ["a lookalike domain", "https://status.example.com.evil.net/", "status.example.com.evil.net"],
    ["a domain that only ends the same way", "https://notexample.com/", "notexample.com"],
    ["a sibling subdomain of the same domain", "https://sites.example.com/x", "sites.example.com"],
    ["the bare parent domain", "https://example.com/", "example.com"],
    ["a plain http URL on the same host", "http://status.example.com/b?token=secret", "http://status.example.com"],
    ["a URL with credentials", "https://user:pass@elsewhere.example.org/b", "elsewhere.example.org"],
    ["a non-http scheme", "javascript:alert(1)", "javascript://"],
    ["a location that is not a URL", "https://", "an unreadable location"],
  ])("refuses a redirect to %s, naming only where it went, without requesting it", async (_name, location, named) => {
    const calls = routed({
      "https://status.example.com/a": () => redirect(location),
      [location]: () => new Response("should never be fetched"),
    });
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toBe(
      `Request to status.example.com redirected to ${named}, off the vendor's host`,
    );
    expect(calls).toHaveLength(1);
  });

  it("names the target host when a vendor moves to another domain", async () => {
    routed({ "https://spotify.statuspage.io/api": () => redirect("https://status.spotify.com/api") });
    await expect(fetchText("https://spotify.statuspage.io/api")).rejects.toThrow(
      "Request to spotify.statuspage.io redirected to status.spotify.com, off the vendor's host",
    );
  });

  it("does not let the allow-list of one host apply to another", async () => {
    routed({ "https://status.example.com/a": () => redirect("https://download.mikrotik.com/x") });
    await expect(fetchText("https://status.example.com/a")).rejects.toThrow("off the vendor's host");
  });

  it("does not follow a redirect from one Statuspage tenant to another", async () => {
    const calls = routed({
      "https://spotify.statuspage.io/api": () => redirect("https://other.statuspage.io/api"),
      "https://other.statuspage.io/api": () => new Response("x"),
    });
    await expect(fetchText("https://spotify.statuspage.io/api")).rejects.toThrow("off the vendor's host");
    expect(calls).toHaveLength(1);
  });

  it("follows at most three redirects", async () => {
    const hop = (n: number) => `https://status.example.com/${n}`;
    const calls = routed({
      [hop(0)]: () => redirect(hop(1)),
      [hop(1)]: () => redirect(hop(2)),
      [hop(2)]: () => redirect(hop(3)),
      [hop(3)]: () => new Response("third hop"),
    });
    expect((await fetchText(hop(0))).body).toBe("third hop");
    expect(calls).toHaveLength(4);

    const loop = routed({ [hop(0)]: () => redirect(hop(0)) });
    const error = await fetchText(hop(0)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toBe("Too many redirects from status.example.com");
    expect(loop).toHaveLength(4);
  });

  it("reports a redirect with no Location as the HTTP status, like any other non-2xx", async () => {
    routed({ "https://status.example.com/a": () => new Response(null, { status: 302, statusText: "Found" }) });
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect((error as SourceError).status).toBe(302);
    expect((error as SourceError).message).toBe("302 Found from status.example.com");
  });
});
