import { afterEach, describe, expect, it, vi } from "vitest";
import { currentGate, withConnectionGate } from "./connection-gate";
import {
  fetchJson,
  fetchText,
  HEAD_BYTES,
  isRefusal,
  MAX_BODY_BYTES,
  meterBytes,
  PayloadError,
  RefusedError,
  readBodyCapped,
  SourceError,
  TimeoutError,
  unwrapJsonp,
} from "./http";
import { clearVendorValidators } from "./validator-cache";

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

  it("a head read keeps exactly HEAD_BYTES of a larger body, cancels it, and counts only what it kept", async () => {
    const { stream, state } = streamOf(MAX_BODY_BYTES * 4);
    stubFetch(() => new Response(stream, { headers: { "content-length": String(MAX_BODY_BYTES * 4) } }));

    const metered = await meterBytes(async (meter) => {
      const { bytes } = await fetchText("https://status.example.com/feed.xml", { head: true });
      return { length: bytes.byteLength, counted: meter.bytes };
    });

    expect(metered).toEqual({ length: HEAD_BYTES, counted: HEAD_BYTES });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(HEAD_BYTES + CHUNK);
  });

  it("a head read of a body shorter than HEAD_BYTES returns it whole", async () => {
    const { stream, state } = streamOf(HEAD_BYTES - 3);
    stubFetch(() => new Response(stream));
    const { bytes } = await fetchText("https://status.example.com/feed.xml", { head: true });
    expect(bytes.byteLength).toBe(HEAD_BYTES - 3);
    expect(state.cancelled).toBe(false);
  });

  it("a head read ends cleanly when the body is exactly HEAD_BYTES", async () => {
    const { stream } = streamOf(HEAD_BYTES);
    stubFetch(() => new Response(stream));
    const { bytes } = await fetchText("https://status.example.com/feed.xml", { head: true });
    expect(bytes.byteLength).toBe(HEAD_BYTES);
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

    const error = await fetchText("https://status.example.com/slow.json", { timeoutMs: 20 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as TimeoutError).name).toBe("TimeoutError");
    expect((error as TimeoutError).message).toBe("Timed out fetching status.example.com");
    expect((error as TimeoutError).status).toBeUndefined();
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

describe("fetchText on an HTTP error", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const messageFor = async (status: number, statusText: string) => {
    stubFetch(() => new Response("body", { status, statusText }));
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).status).toBe(status);
    return (error as SourceError).message;
  };

  it("names the standard phrase for the code, not the one the vendor sent", async () => {
    expect(await messageFor(503, "SECRET-REASON <b>")).toBe("503 Service Unavailable from status.example.com");
    expect(await messageFor(429, "")).toBe("429 Too Many Requests from status.example.com");
    expect(await messageFor(404, "Gone Fishing")).toBe("404 Not Found from status.example.com");
  });

  it("names a code with no standard phrase listed by its number alone", async () => {
    expect(await messageFor(599, "SECRET-REASON")).toBe("599 from status.example.com");
    expect(await messageFor(418, "I'm a teapot")).toBe("418 from status.example.com");
  });

  it.each([401, 403, 407, 429])("a %i is a refusal that keeps its status", async (status) => {
    stubFetch(() => new Response("body", { status }));
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RefusedError);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as RefusedError).status).toBe(status);
    expect(isRefusal(error)).toBe(true);
  });

  it.each([404, 500, 503])("a %i is a plain failure, not a refusal", async (status) => {
    stubFetch(() => new Response("body", { status }));
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).not.toBeInstanceOf(RefusedError);
    expect(isRefusal(error)).toBe(false);
  });

  it("a 503 marked cf-mitigated: challenge is a refusal", async () => {
    stubFetch(() => new Response("body", { status: 503, headers: { "cf-mitigated": "challenge" } }));
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect(isRefusal(error)).toBe(true);
    expect((error as RefusedError).status).toBe(503);
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

  it("follows Google's release-notes feed to docs.cloud.google.com, and only that one move", async () => {
    const calls = routed({
      "https://cloud.google.com/feeds/gcp-release-notes.xml": () =>
        redirect("https://docs.cloud.google.com/feeds/gcp-release-notes.xml", 301),
      "https://docs.cloud.google.com/feeds/gcp-release-notes.xml": () => new Response("<feed/>"),
    });
    expect((await fetchText("https://cloud.google.com/feeds/gcp-release-notes.xml")).body).toBe("<feed/>");
    expect(calls.map((call) => call.url)).toEqual([
      "https://cloud.google.com/feeds/gcp-release-notes.xml",
      "https://docs.cloud.google.com/feeds/gcp-release-notes.xml",
    ]);
    // The allowance is one way and one host: nothing else on google.com, and not back again.
    routed({ "https://cloud.google.com/feeds/x.xml": () => redirect("https://sites.google.com/x") });
    await expect(fetchText("https://cloud.google.com/feeds/x.xml")).rejects.toThrow("off the vendor's host");
    routed({ "https://docs.cloud.google.com/a": () => redirect("https://cloud.google.com/a") });
    await expect(fetchText("https://docs.cloud.google.com/a")).rejects.toThrow("off the vendor's host");
  });

  it.each([
    ["another site", "https://evil.example.net/steal", "evil.example.net"],
    ["a lookalike domain", "https://status.example.com.evil.net/", "status.example.com.evil.net"],
    ["a domain that only ends the same way", "https://notexample.com/", "notexample.com"],
    ["a sibling subdomain of the same domain", "https://sites.example.com/x", "sites.example.com"],
    ["the bare parent domain", "https://example.com/", "example.com"],
    ["a plain http URL on the same host", "http://status.example.com/b?token=secret", "http://status.example.com"],
    ["a URL with credentials", "https://user:pass@elsewhere.example.org/b", "elsewhere.example.org"],
    ["a non-http scheme", "javascript:alert(1)", "a non-https location"],
    ["a data URL", "data:text/html,SECRET-TEXT", "a non-https location"],
    ["a ftp URL", "ftp://files.example.org/x", "a non-https location"],
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

  it("clips a very long target host in the error", async () => {
    const host = `${"a".repeat(60)}.${"b".repeat(60)}.example.net`;
    routed({ "https://status.example.com/a": () => redirect(`https://${host}/x`) });
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    const message = (error as SourceError).message;
    expect(message).toBe(`Request to status.example.com redirected to ${host.slice(0, 99)}…, off the vendor's host`);
    expect(message.length).toBeLessThan(200);
  });

  it("refuses a redirect to another port of the same host, without requesting it", async () => {
    const calls = routed({
      "https://status.example.com/a": () => redirect("https://status.example.com:8443/a"),
      "https://status.example.com:8443/a": () => new Response("should never be fetched"),
    });
    await expect(fetchText("https://status.example.com/a")).rejects.toThrow(
      "Request to status.example.com redirected to status.example.com:8443, off the vendor's host",
    );
    expect(calls).toHaveLength(1);
    // The default port written out is the same host, not another one.
    routed({
      "https://status.example.com/a": () => redirect("https://status.example.com:443/b"),
      "https://status.example.com/b": () => new Response("ok"),
    });
    expect((await fetchText("https://status.example.com/a")).body).toBe("ok");
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
    routed({
      "https://status.example.com/a": () => new Response(null, { status: 302, statusText: "Moved Temporarily" }),
    });
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect((error as SourceError).status).toBe(302);
    expect((error as SourceError).message).toBe("302 Found from status.example.com");
  });
});

describe("fetchJson on a body that is not JSON", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (body: string, contentType?: string) =>
    stubFetch(() => new Response(body, { headers: contentType ? { "content-type": contentType } : {} }));
  const failure = async (): Promise<PayloadError> => {
    const error = await fetchJson("https://status.example.com/a.json").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PayloadError);
    return error as PayloadError;
  };

  it("says it looks like HTML, and what the content type was, without quoting the body", async () => {
    answer("  <html>SECRET-TEXT</html>", "text/html; charset=utf-8");
    expect((await failure()).message).toBe("SyntaxError: response was not valid JSON (looks like HTML, text/html)");
  });

  it("says an empty body is empty, and adds nothing for a JSON content type", async () => {
    answer("", "application/json");
    expect((await failure()).message).toBe("SyntaxError: response was not valid JSON (empty body)");
  });

  it("adds no hint for text it cannot describe, and ignores a content type of an unexpected shape", async () => {
    answer("SECRET-TEXT", "application/json");
    expect((await failure()).message).toBe("SyntaxError: response was not valid JSON");
    answer("SECRET-TEXT", "x/SECRET-TEXT; weird <b>");
    expect((await failure()).message).toBe("SyntaxError: response was not valid JSON");
    // A string body is labelled text/plain by the Response itself.
    answer("SECRET-TEXT");
    expect((await failure()).message).toBe("SyntaxError: response was not valid JSON (text/plain)");
  });

  it("still parses JSON, including a JSONP wrapper", async () => {
    answer('cb({"a":1});', "text/javascript");
    expect(await fetchJson("https://status.example.com/a.json")).toEqual({ a: 1 });
  });
});

// A fetch that answers each URL after `delays[url]` ms (default 1000) and
// fails with an AbortError when its signal fires first, recording when each
// request was started, so a test with fake timers can see queueing.
function timedFetch(delays: Record<string, number> = {}) {
  const started: Array<{ url: string; at: number }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          started.push({ url, at: Date.now() });
          const timer = setTimeout(() => resolve(new Response("ok")), delays[url] ?? 1000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ),
  );
  return started;
}

describe("fetchText inside a connection gate", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts a request's timeout when it gets a connection, not when it is queued", async () => {
    vi.useFakeTimers({ now: 0 });
    const started = timedFetch({ "https://status.example.com/a": 8_500, "https://status.example.com/b": 1_000 });
    await withConnectionGate({ limit: 1 }, async () => {
      const results = Promise.allSettled([
        fetchText("https://status.example.com/a", { timeoutMs: 9_000 }),
        fetchText("https://status.example.com/b", { timeoutMs: 9_000 }),
      ]);
      await vi.advanceTimersByTimeAsync(12_000);
      const [a, b] = await results;
      expect(a.status).toBe("fulfilled");
      // B waited 8.5 s for A's slot, then answered within its own 9 s.
      expect(b.status).toBe("fulfilled");
      expect(started).toEqual([
        { url: "https://status.example.com/a", at: 0 },
        { url: "https://status.example.com/b", at: 8_500 },
      ]);
    });
  });

  it("caps a request's timeout at the gate's deadline, and times out one still queued past it", async () => {
    vi.useFakeTimers({ now: 0 });
    const started = timedFetch({ "https://status.example.com/a": 60_000 });
    await withConnectionGate({ limit: 1, deadlineMs: 5_000 }, async () => {
      const results = Promise.allSettled([
        fetchText("https://status.example.com/a", { timeoutMs: 9_000 }),
        fetchText("https://status.example.com/b", { timeoutMs: 9_000 }),
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      const [a, b] = await results;
      expect(a.status === "rejected" && (a.reason as Error).message).toBe("Timed out fetching status.example.com");
      expect(a.status === "rejected" && a.reason).toBeInstanceOf(TimeoutError);
      expect(b.status === "rejected" && b.reason).toBeInstanceOf(TimeoutError);
      expect(b.status === "rejected" && (b.reason as Error).message).toBe(
        "Timed out waiting for a connection to status.example.com",
      );
      expect(started.map((request) => request.url)).toEqual(["https://status.example.com/a"]);
      expect(currentGate()!.active).toBe(0);
    });
  });

  it("starts low-priority requests after every queued high-priority one", async () => {
    vi.useFakeTimers({ now: 0 });
    const started = timedFetch();
    await withConnectionGate({ limit: 1 }, async () => {
      const results = Promise.all([
        fetchText("https://status.example.com/first"),
        fetchText("https://status.example.com/side", { priority: "low" }),
        fetchText("https://status.example.com/main-1"),
        fetchText("https://status.example.com/main-2", { priority: "high" }),
      ]);
      await vi.advanceTimersByTimeAsync(5_000);
      await results;
      expect(started.map((request) => request.url)).toEqual([
        "https://status.example.com/first",
        "https://status.example.com/main-1",
        "https://status.example.com/main-2",
        "https://status.example.com/side",
      ]);
    });
  });

  it("holds the slot until the body has been read", async () => {
    let finish = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
        finish = () => controller.close();
      },
    });
    stubFetch(() => new Response(stream));
    await withConnectionGate({ limit: 1 }, async () => {
      const gate = currentGate()!;
      const reading = fetchText("https://status.example.com/a");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(gate.active).toBe(1);
      finish();
      expect((await reading).bytes.byteLength).toBe(10);
      expect(gate.active).toBe(0);
    });
  });
});

describe("fetchText retries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Answers with each response in turn (the last one again once they run out) and counts the calls.
  function sequence(...responses: Array<() => Response>) {
    const fetchMock = vi.fn(async () => (responses.length > 1 ? responses.shift()! : responses[0]!)());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const gated = <T>(fn: () => Promise<T>, options = {}) => withConnectionGate(options, fn);
  const failure = (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);

  it("retries a 503 once inside a gate, and returns the retry's answer", async () => {
    const fetchMock = sequence(
      () => new Response("down", { status: 503 }),
      () => new Response("up"),
    );
    const { body } = await gated(() => fetchText("https://status.example.com/a"));
    expect(body).toBe("up");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([502, 504])("retries a %i once inside a gate", async (status) => {
    const fetchMock = sequence(
      () => new Response("down", { status }),
      () => new Response("up"),
    );
    expect((await gated(() => fetchText("https://status.example.com/a"))).body).toBe("up");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a dropped connection once inside a gate", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return new Response("up");
      }),
    );
    expect((await gated(() => fetchText("https://status.example.com/a"))).body).toBe("up");
    expect(calls).toBe(2);
  });

  it("throws the retry's own error when the retry fails too, and tries no third time", async () => {
    const fetchMock = sequence(
      () => new Response("down", { status: 503 }),
      () => new Response("down", { status: 502 }),
      () => new Response("up"),
    );
    const error = await failure(gated(() => fetchText("https://status.example.com/a")));
    expect((error as SourceError).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry outside a gate", async () => {
    const fetchMock = sequence(
      () => new Response("down", { status: 503 }),
      () => new Response("up"),
    );
    expect(((await failure(fetchText("https://status.example.com/a"))) as SourceError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 429", () => new Response("slow down", { status: 429 })],
    ["a 404", () => new Response("missing", { status: 404 })],
    ["a 500", () => new Response("broken", { status: 500 })],
    ["a challenge", () => new Response("challenge", { status: 503, headers: { "cf-mitigated": "challenge" } })],
    ["an oversized body", () => new Response("x", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } })],
  ])("does not retry %s", async (_name, response) => {
    const fetchMock = sequence(response, () => new Response("up"));
    expect(await failure(gated(() => fetchText("https://status.example.com/a")))).toBeInstanceOf(SourceError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a timeout", async () => {
    const started = timedFetch({ "https://status.example.com/a": 60_000 });
    const error = await failure(gated(() => fetchText("https://status.example.com/a", { timeoutMs: 50 })));
    expect((error as Error).message).toBe("Timed out fetching status.example.com");
    expect(started).toHaveLength(1);
  });

  it("does not retry once the gate's subrequest budget is spent", async () => {
    const fetchMock = sequence(
      () => new Response("down", { status: 503 }),
      () => new Response("up"),
    );
    const error = await failure(gated(() => fetchText("https://status.example.com/a"), { maxRequests: 1 }));
    expect((error as SourceError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets failures that land together retry only as far as the budget goes", async () => {
    // Four requests fail at once with three subrequests left: the first three of them that fail
    // take those, and the fourth does not retry, although none of the retries has been made yet.
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return calls.filter((seen) => seen === url).length === 1
          ? new Response("down", { status: 503 })
          : new Response("up");
      }),
    );
    const urls = ["a", "b", "c", "d"].map((path) => `https://status.example.com/${path}`);
    const results = await gated(() => Promise.allSettled(urls.map((url) => fetchText(url))), { maxRequests: 7 });
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(calls).toHaveLength(7);
  });

  it("does not retry with less than 3 s of the request's time left", async () => {
    const fetchMock = sequence(
      () => new Response("down", { status: 503 }),
      () => new Response("up"),
    );
    await failure(gated(() => fetchText("https://status.example.com/a", { timeoutMs: 2_900 })));
    await failure(gated(() => fetchText("https://status.example.com/a"), { deadlineMs: 2_900 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("counts every redirect hop and every retry as a subrequest", async () => {
    const responses: Record<string, Array<() => Response>> = {
      "https://status.example.com/a": [() => new Response(null, { status: 302, headers: { location: "/b" } })],
      "https://status.example.com/b": [() => new Response("down", { status: 503 }), () => new Response("up")],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const queue = responses[url]!;
        return (queue.length > 1 ? queue.shift()! : queue[0]!)();
      }),
    );
    const issued = await gated(async () => {
      await fetchText("https://status.example.com/a");
      return currentGate()!.issued;
    });
    // a -> b (503), then the retry: a -> b (200).
    expect(issued).toBe(4);
  });
});

describe("fetchText conditional requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearVendorValidators();
  });

  // Answers each request with the next response and records the headers it carried.
  function revalidating(...responses: Array<() => Response>) {
    const sent: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(new Headers(init.headers));
        return (responses.length > 1 ? responses.shift()! : responses[0]!)();
      }),
    );
    return sent;
  }

  it("sends the vendor's own ETag back, and answers a 304 with the body it stored", async () => {
    const sent = revalidating(
      () => new Response("[1,2]", { headers: { etag: 'W/"a"', "content-type": "application/json" } }),
      () => new Response(null, { status: 304, headers: { etag: 'W/"a"' } }),
    );
    const first = await fetchText("https://status.example.com/a.json");
    const metered = await meterBytes(async (meter) => ({
      second: await fetchText("https://status.example.com/a.json"),
      bytes: meter.bytes,
    }));
    expect(sent[0]!.has("if-none-match")).toBe(false);
    expect(sent[1]!.get("if-none-match")).toBe('W/"a"');
    expect(sent[1]!.has("if-modified-since")).toBe(false);
    expect(metered.second).toEqual({ ...first, contentRange: "", status: 200 });
    expect(metered.second.body).toBe("[1,2]");
    expect(metered.second.contentType).toBe("application/json");
    // Nothing was downloaded the second time.
    expect(metered.bytes).toBe(0);
    // The stored body is not handed out to be changed.
    expect(metered.second.bytes).not.toBe(first.bytes);
  });

  it("sends Last-Modified back as If-Modified-Since", async () => {
    const date = "Wed, 21 Oct 2026 07:28:00 GMT";
    const sent = revalidating(
      () => new Response("x", { headers: { "last-modified": date } }),
      () => new Response(null, { status: 304 }),
    );
    await fetchText("https://status.example.com/a");
    expect((await fetchText("https://status.example.com/a")).body).toBe("x");
    expect(sent[1]!.get("if-modified-since")).toBe(date);
    expect(sent[1]!.has("if-none-match")).toBe(false);
  });

  it("stores nothing and sends nothing for a response without validators", async () => {
    const sent = revalidating(() => new Response("x"));
    await fetchText("https://status.example.com/a");
    await fetchText("https://status.example.com/a");
    expect(sent[1]!.has("if-none-match")).toBe(false);
    expect(sent[1]!.has("if-modified-since")).toBe(false);
  });

  it("forgets a stored body once the vendor stops sending validators for it", async () => {
    const sent = revalidating(
      () => new Response("1", { headers: { etag: '"1"' } }),
      () => new Response("2"),
      () => new Response("3"),
    );
    await fetchText("https://status.example.com/a");
    await fetchText("https://status.example.com/a");
    await fetchText("https://status.example.com/a");
    expect(sent[1]!.get("if-none-match")).toBe('"1"');
    expect(sent[2]!.has("if-none-match")).toBe(false);
  });

  it("never revalidates a head read or a Range request", async () => {
    const sent = revalidating(() => new Response("x", { headers: { etag: '"1"' } }));
    await fetchText("https://status.example.com/feed.xml", { head: true });
    await fetchText("https://status.example.com/feed.xml", { head: true });
    await fetchText("https://status.example.com/r", { headers: { Range: "bytes=0-10" } });
    await fetchText("https://status.example.com/r", { headers: { Range: "bytes=0-10" } });
    for (const headers of sent) expect(headers.has("if-none-match")).toBe(false);
  });

  it("does not store a body over 512 KiB", async () => {
    const sent = revalidating(() => new Response(new Uint8Array(512 * 1024 + 1), { headers: { etag: '"big"' } }));
    await fetchText("https://status.example.com/big");
    await fetchText("https://status.example.com/big");
    expect(sent[1]!.has("if-none-match")).toBe(false);
  });

  it("fails a 304 it has no stored body for", async () => {
    revalidating(() => new Response(null, { status: 304 }));
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).toBe("304 Not Modified from status.example.com without a cached body");
  });
});

describe("fetchText binary decoding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answerBytes = (...bytes: number[][]) => {
    const body = new Uint8Array(bytes.flat());
    stubFetch(() => new Response(body));
  };
  const utf16le = (text: string) => [...text].flatMap((char) => [char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8]);
  const utf16be = (text: string) => [...text].flatMap((char) => [char.charCodeAt(0) >> 8, char.charCodeAt(0) & 0xff]);
  const utf8 = (text: string) => [...new TextEncoder().encode(text)];

  it("reads a body without a BOM as UTF-8", async () => {
    answerBytes(utf8("[]"));
    expect(await fetchJson("https://status.example.com/a", { binary: true })).toEqual([]);
    answerBytes(utf8('{"name":"Zürich"}'));
    expect(await fetchJson("https://status.example.com/a", { binary: true })).toEqual({ name: "Zürich" });
  });

  it("still reads UTF-16LE without a BOM", async () => {
    answerBytes(utf16le('[{"a":1}]'));
    expect(await fetchJson("https://status.example.com/a", { binary: true })).toEqual([{ a: 1 }]);
  });

  it("reads either UTF-16 byte order from its BOM", async () => {
    answerBytes([0xff, 0xfe], utf16le('{"a":"é"}'));
    expect(await fetchJson("https://status.example.com/a", { binary: true })).toEqual({ a: "é" });
    answerBytes([0xfe, 0xff], utf16be('{"a":"é"}'));
    expect(await fetchJson("https://status.example.com/a", { binary: true })).toEqual({ a: "é" });
  });

  it("reads an empty or one-byte body as UTF-8", async () => {
    answerBytes([]);
    expect((await fetchText("https://status.example.com/a", { binary: true })).body).toBe("");
    answerBytes(utf8("7"));
    expect((await fetchText("https://status.example.com/a", { binary: true })).body).toBe("7");
  });
});

describe("fetchText Retry-After", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const retryAfter = async (value: string | null, status = 503) => {
    stubFetch(() => new Response("busy", { status, headers: value === null ? {} : { "retry-after": value } }));
    const error = await fetchText("https://status.example.com/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    return (error as SourceError).retryAfterMs;
  };

  it("keeps a delay in seconds, on a refusal and on a failure alike", async () => {
    expect(await retryAfter("120")).toBe(120_000);
    expect(await retryAfter(" 30 ", 429)).toBe(30_000);
    expect(await retryAfter("0")).toBe(0);
  });

  it("keeps the time until an HTTP date", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-21T12:00:00Z") });
    expect(await retryAfter("Wed, 21 Oct 2026 12:01:30 GMT")).toBe(90_000);
    expect(await retryAfter("Wed, 21 Oct 2026 11:00:00 GMT")).toBe(0);
  });

  it("clamps a delay to ten minutes", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-21T12:00:00Z") });
    expect(await retryAfter("86400")).toBe(600_000);
    expect(await retryAfter("Thu, 22 Oct 2026 12:00:00 GMT", 429)).toBe(600_000);
  });

  it("has none without the header or with one it cannot read", async () => {
    expect(await retryAfter(null)).toBeUndefined();
    expect(await retryAfter("soon")).toBeUndefined();
    expect(await retryAfter("-5")).toBeUndefined();
    expect(await retryAfter("1.5")).toBeUndefined();
  });
});
