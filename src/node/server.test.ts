import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_HSTS, securityHeaders } from "../lib/security-headers.ts";
import { createNodeServer, DEFAULT_NODE_HSTS, hstsFromEnv } from "./server.ts";
import { IMMUTABLE_CACHE_CONTROL, indexStaticFiles, SHORT_CACHE_CONTROL } from "./static.ts";

const css = "body { color: red; }\n".repeat(200);
const page = `<!doctype html><title>Board</title>${"<p>service</p>".repeat(200)}`;

let root: string;
let server: Server;
let base: string;
const logs: Record<string, unknown>[] = [];
const seen: { url: string; method: string; headers: Headers; body: string }[] = [];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "node-server-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "app-abc.css"), css);
  await writeFile(join(root, "favicon.svg"), `<svg>${"<path/>".repeat(300)}</svg>`);
  await writeFile(join(root, "og.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  await writeFile(join(root, "_headers"), "/assets/*\n  Cache-Control: x\n");

  server = createNodeServer({
    staticFiles: await indexStaticFiles(root),
    log: (entry) => logs.push(entry),
    maxBodyBytes: 16,
    async handler(request) {
      const { pathname } = new URL(request.url);
      seen.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body ? await request.text() : "",
      });
      if (pathname === "/healthz") return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
      if (pathname === "/throw") throw new Error("boom");
      if (pathname === "/app-hsts")
        return new Response("x", { headers: { "Strict-Transport-Security": DEFAULT_HSTS } });
      if (pathname === "/with-header")
        return new Response("x", { headers: { "X-Frame-Options": "SAMEORIGIN", "Set-Cookie": "a=1" } });
      if (pathname === "/cookies") {
        const headers = new Headers({ "Content-Type": "text/plain" });
        headers.append("Set-Cookie", "a=1");
        headers.append("Set-Cookie", "b=2");
        return new Response("c", { headers });
      }
      if (pathname === "/tiny")
        return new Response("ok\n", { headers: { "Content-Type": "text/plain", "Content-Length": "3" } });
      if (pathname === "/gone") return new Response(null, { status: 204 });
      if (pathname === "/image") return new Response(page, { headers: { "Content-Type": "image/png" } });
      if (pathname === "/no-transform")
        return new Response(page, { headers: { "Content-Type": "text/html", "Cache-Control": "no-transform" } });
      if (pathname === "/stream") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 3; i++) {
                controller.enqueue(encoder.encode(page));
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (pathname === "/page") {
        return new Response(page, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(page.length) },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

// node:http, not fetch(): fetch adds its own Accept-Encoding and unzips the body, and these tests need the raw bytes.
function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ response: { status: number; headers: Headers }; bytes: Buffer }>((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      { method, headers: { "Accept-Encoding": "identity", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const received = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") received.set(name, value);
          }
          resolve({ response: { status: res.statusCode ?? 0, headers: received }, bytes: Buffer.concat(chunks) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const expectedSecurity = securityHeaders({ dev: false, hsts: DEFAULT_NODE_HSTS });
function expectSecurityHeaders(response: { headers: Headers }) {
  for (const [name, value] of Object.entries(expectedSecurity)) expect(response.headers.get(name), name).toBe(value);
}

describe("static files", () => {
  it("serves a hashed asset with a one-year immutable Cache-Control and the security headers", async () => {
    const { response, bytes } = await get("/assets/app-abc.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(response.headers.get("content-length")).toBe(String(css.length));
    expect(bytes.toString()).toBe(css);
    expectSecurityHeaders(response);
  });

  it("gives other static files a short cache", async () => {
    const { response } = await get("/og.jpg");
    expect(response.headers.get("cache-control")).toBe(SHORT_CACHE_CONTROL);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.has("vary")).toBe(false);
    expectSecurityHeaders(response);
  });

  it("answers 304 to a matching If-None-Match, with the cache and security headers", async () => {
    const first = await get("/assets/app-abc.css");
    const etag = first.response.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\//);
    const { response, bytes } = await get("/assets/app-abc.css", { "If-None-Match": etag });
    expect(response.status).toBe(304);
    expect(bytes.length).toBe(0);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expectSecurityHeaders(response);
    expect((await get("/assets/app-abc.css", { "If-None-Match": '"other"' })).response.status).toBe(200);
  });

  it("compresses text with Brotli or gzip when asked, and says so in Vary", async () => {
    const br = await get("/assets/app-abc.css", { "Accept-Encoding": "gzip, br" });
    expect(br.response.headers.get("content-encoding")).toBe("br");
    expect(br.response.headers.get("vary")).toBe("Accept-Encoding");
    expect(brotliDecompressSync(br.bytes).toString()).toBe(css);
    expect(br.response.headers.get("content-length")).toBe(String(br.bytes.length));
    expect(br.bytes.length).toBeLessThan(css.length);

    const gz = await get("/assets/app-abc.css", { "Accept-Encoding": "gzip" });
    expect(gz.response.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(gz.bytes).toString()).toBe(css);

    const plain = await get("/assets/app-abc.css");
    expect(plain.response.headers.has("content-encoding")).toBe(false);
    expect(plain.response.headers.get("vary")).toBe("Accept-Encoding");
    expect(brotliDecompressSync((await get("/favicon.svg", { "Accept-Encoding": "br" })).bytes).toString()).toContain(
      "<svg>",
    );
  });

  it("answers HEAD with the headers and no body", async () => {
    const { response, bytes } = await get("/assets/app-abc.css", {}, "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(css.length));
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(bytes.length).toBe(0);
  });

  it("never serves _headers, and a directory or a missing file falls through to the app", async () => {
    expect((await get("/_headers")).response.status).toBe(404);
    expect((await get("/assets/")).response.status).toBe(404);
    expect((await get("/assets/missing.js")).response.status).toBe(404);
    expect(seen.some((entry) => entry.url.endsWith("/_headers"))).toBe(true);
  });

  it("cannot be walked out of the directory", async () => {
    const before = seen.length;
    for (const path of ["/assets/../../package.json", "/%2e%2e/package.json", "/..%2f..%2fetc/passwd", "/assets/%00"]) {
      const { response, bytes } = await get(path);
      expect(response.status, path).not.toBe(200);
      expect(bytes.toString(), path).not.toContain("root:");
    }
    expect(seen.length).toBeGreaterThanOrEqual(before);
  });

  it("does not serve a file for a POST", async () => {
    const response = await fetch(`${base}/assets/app-abc.css`, { method: "POST", body: "x" });
    expect(response.status).toBe(404);
  });
});

describe("the app handler", () => {
  it("hands the request over with its method, URL, headers and body", async () => {
    seen.length = 0;
    const response = await fetch(`${base}/page?x=1`, { headers: { "X-Probe": "1" } });
    expect(response.status).toBe(200);
    expect(seen[0]?.url).toBe(`${base}/page?x=1`);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers.get("x-probe")).toBe("1");

    await fetch(`${base}/echo`, { method: "POST", body: "hello" });
    expect(seen.at(-1)?.method).toBe("POST");
    expect(seen.at(-1)?.body).toBe("hello");
  });

  it("adds the security headers to its responses and keeps ones it set itself", async () => {
    const { response } = await get("/page");
    expectSecurityHeaders(response);
    const own = await get("/with-header");
    expect(own.response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(own.response.headers.get("strict-transport-security")).toBe(expectedSecurity["Strict-Transport-Security"]);
  });

  it("keeps each Set-Cookie as its own header", async () => {
    const cookies = await new Promise<string[]>((resolve, reject) => {
      httpRequest(`${base}/cookies`, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers["set-cookie"] ?? []));
      })
        .on("error", reject)
        .end();
    });
    expect(cookies).toEqual(["a=1", "b=2"]);
  });

  it("answers /healthz and does not log it", async () => {
    logs.length = 0;
    const { response, bytes } = await get("/healthz");
    expect(response.status).toBe(200);
    expect(bytes.toString()).toBe("ok\n");
    // The request line is logged when the response closes; wait for the next request's line to be sure it was not.
    await get("/page");
    await vi.waitFor(() => expect(logs.some((entry) => entry.path === "/page")).toBe(true));
    expect(logs.filter((entry) => entry.path === "/healthz")).toEqual([]);
  });

  it("compresses a text response and leaves an image or a no-transform one alone", async () => {
    const gz = await get("/page", { "Accept-Encoding": "gzip" });
    expect(gz.response.headers.get("content-encoding")).toBe("gzip");
    expect(gz.response.headers.has("content-length")).toBe(false);
    expect(gz.response.headers.get("vary")).toBe("Accept-Encoding");
    expect(gunzipSync(gz.bytes).toString()).toBe(page);

    const br = await get("/page", { "Accept-Encoding": "br" });
    expect(brotliDecompressSync(br.bytes).toString()).toBe(page);

    expect((await get("/image", { "Accept-Encoding": "br" })).response.headers.has("content-encoding")).toBe(false);
    expect((await get("/no-transform", { "Accept-Encoding": "br" })).response.headers.has("content-encoding")).toBe(
      false,
    );
    // A body known to be under 1 KiB is not worth the CPU.
    expect((await get("/tiny", { "Accept-Encoding": "br" })).response.headers.has("content-encoding")).toBe(false);
  });

  it("streams a compressed body in full", async () => {
    const { response, bytes } = await get("/stream", { "Accept-Encoding": "br" });
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(brotliDecompressSync(bytes).toString()).toBe(page.repeat(3));
    const plain = await get("/stream");
    expect(plain.bytes.toString()).toBe(page.repeat(3));
  });

  it("answers HEAD without a body and passes a 204 through", async () => {
    const head = await get("/page", { "Accept-Encoding": "gzip" }, "HEAD");
    expect(head.response.status).toBe(200);
    expect(head.bytes.length).toBe(0);
    expect((await get("/gone")).response.status).toBe(204);
  });

  it("turns a handler that throws into a 500 with the security headers, and logs it", async () => {
    logs.length = 0;
    const { response, bytes } = await get("/throw");
    expect(response.status).toBe(500);
    expect(bytes.toString()).toBe("Internal Server Error\n");
    expectSecurityHeaders(response);
    expect(logs.some((entry) => entry.level === "error" && entry.msg === "handler failed")).toBe(true);
    // The error text is for the log, not the client.
    expect(bytes.toString()).not.toContain("boom");
  });

  it("refuses a request body over the limit with 413", async () => {
    const declared = await fetch(`${base}/echo`, { method: "POST", body: "x".repeat(64) });
    expect(declared.status).toBe(413);
    expectSecurityHeaders(declared);
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/echo`, { method: "POST" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.write("y".repeat(10));
      req.write("y".repeat(10));
      req.end();
    });
    expect(streamed).toBe(413);
  });

  it("logs a line per request with method, path without the query, status and time", async () => {
    logs.length = 0;
    await get("/page?secret=1");
    await vi.waitFor(() => expect(logs.some((entry) => entry.path === "/page")).toBe(true));
    const line = logs.find((entry) => entry.path === "/page");
    expect(line).toMatchObject({ level: "info", msg: "request", method: "GET", status: 200 });
    expect(typeof line?.ms).toBe("number");
    expect(JSON.stringify(logs)).not.toContain("secret");
  });
});

describe("HSTS", () => {
  async function hstsOf(hsts: string | false | undefined, path: string): Promise<string | null> {
    const custom = createNodeServer({
      staticFiles: new Map(),
      ...(hsts === undefined ? {} : { hsts }),
      handler: () => new Response("x", { headers: { "Strict-Transport-Security": DEFAULT_HSTS } }),
    });
    await new Promise<void>((resolve) => custom.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(custom.address() as AddressInfo).port}${path}`);
      return response.headers.get("strict-transport-security");
    } finally {
      custom.closeAllConnections();
      await new Promise((resolve) => custom.close(resolve));
    }
  }

  it("sends no includeSubDomains by default, replacing the app's own header", async () => {
    expect(DEFAULT_HSTS).toContain("includeSubDomains");
    expect(DEFAULT_NODE_HSTS).toBe("max-age=31536000");
    expect((await get("/app-hsts")).response.headers.get("strict-transport-security")).toBe(DEFAULT_NODE_HSTS);
    expect((await get("/page")).response.headers.get("strict-transport-security")).toBe(DEFAULT_NODE_HSTS);
    expect((await get("/assets/app-abc.css")).response.headers.get("strict-transport-security")).toBe(
      DEFAULT_NODE_HSTS,
    );
  });

  it("can be changed or left out, on the app's responses and the server's own", async () => {
    expect(await hstsOf("max-age=60", "/")).toBe("max-age=60");
    expect(await hstsOf(false, "/")).toBeNull();
    expect(await hstsOf(false, "/bad target")).toBeNull();
  });

  it("reads the HSTS variable", () => {
    expect(hstsFromEnv(undefined)).toBe(DEFAULT_NODE_HSTS);
    expect(hstsFromEnv("")).toBe(DEFAULT_NODE_HSTS);
    expect(hstsFromEnv("on")).toBe(DEFAULT_NODE_HSTS);
    expect(hstsFromEnv("Subdomains")).toBe(`${DEFAULT_NODE_HSTS}; includeSubDomains`);
    expect(hstsFromEnv("off")).toBe(false);
    expect(hstsFromEnv("0")).toBe(false);
    expect(() => hstsFromEnv("maybe")).toThrow(/HSTS must be/);
  });
});

describe("closing idle connections", () => {
  async function startServer() {
    const own = createNodeServer({
      staticFiles: new Map(),
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return new Response("slow done", { headers: { "Content-Type": "text/plain" } });
      },
    });
    await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
    const port = (own.address() as AddressInfo).port;
    // A socket that connects and never sends a byte; resolves once the server has accepted it.
    async function silentSocket() {
      const accepted = new Promise<void>((resolve) => own.once("connection", () => resolve()));
      const socket = connect(port, "127.0.0.1");
      await accepted;
      return socket;
    }
    return { own, port, silentSocket };
  }

  it("destroys a socket that connected and sent nothing, so a graceful close is quick", async () => {
    const { own, silentSocket } = await startServer();
    const silent = await silentSocket();
    // Node's own closeIdleConnections() leaves this socket open.
    const closed = new Promise<void>((resolve) => silent.once("close", resolve));
    const began = performance.now();
    const stopped = new Promise((resolve) => own.close(resolve));
    own.closeIdleConnections();
    await closed;
    await stopped;
    expect(performance.now() - began).toBeLessThan(1000);
  });

  it("lets a request in flight finish while the idle sockets go", async () => {
    const { own, port, silentSocket } = await startServer();
    const silent = await silentSocket();
    const silentClosed = new Promise<void>((resolve) => silent.once("close", resolve));
    const busy = new Promise<string>((resolve, reject) => {
      httpRequest(`http://127.0.0.1:${port}/`, { agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      })
        .on("error", reject)
        .end();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = new Promise((resolve) => own.close(resolve));
    own.closeIdleConnections();
    await silentClosed;
    expect(await busy).toBe("slow done");
    await stopped;
  });
});

describe("bad requests", () => {
  function raw(target: string, headers: string[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: Number(new URL(base).port), method: "GET", path: target, headers: {} },
        (res) => {
          res.resume();
          resolve(`${res.statusCode} ${res.headers["x-frame-options"]} ${headers.join()}`);
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("refuses a request target that is not a path", async () => {
    expect(await raw("http://evil.example/")).toMatch(/^400 DENY/);
    expect(await raw("*")).toMatch(/^400 DENY/);
  });

  it("does not let a protocol-relative target change the host the app sees", async () => {
    seen.length = 0;
    await raw("//evil.example/x");
    expect(new URL(seen.at(-1)?.url ?? "").host).toBe(new URL(base).host);
  });
});

describe("trustProxy", () => {
  async function origin(trustProxy: boolean, headers: Record<string, string>): Promise<string> {
    let url = "";
    const proxied = createNodeServer({
      staticFiles: new Map(),
      trustProxy,
      handler: (request) => {
        url = request.url;
        return new Response("ok");
      },
    });
    await new Promise<void>((resolve) => proxied.listen(0, "127.0.0.1", resolve));
    try {
      await fetch(`http://127.0.0.1:${(proxied.address() as AddressInfo).port}/p?q=1`, { headers });
    } finally {
      proxied.closeAllConnections();
      await new Promise((resolve) => proxied.close(resolve));
    }
    return url;
  }

  it("ignores X-Forwarded-* unless told to trust the proxy", async () => {
    const url = await origin(false, { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "status.example.com" });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\?q=1$/);
  });

  it("uses the first X-Forwarded-Proto and X-Forwarded-Host when it is", async () => {
    const url = await origin(true, {
      "X-Forwarded-Proto": "https, http",
      "X-Forwarded-Host": "status.example.com, internal",
    });
    expect(url).toBe("https://status.example.com/p?q=1");
  });

  it("falls back to http and the Host header for anything else", async () => {
    const url = await origin(true, { "X-Forwarded-Proto": "javascript", "X-Forwarded-Host": "bad host/with spaces" });
    expect(url).toMatch(/^http:\/\/localhost\/p\?q=1$/);
  });
});
