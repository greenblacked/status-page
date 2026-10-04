// A production HTTP server for the Node build, on node:http alone. `pnpm run
// build` leaves a Fetch-style handler in dist/server/server.js and the browser
// files in dist/client; this puts them behind a socket:
//
//   - the files of dist/client are served from memory (/assets/* immutable for
//     a year, everything else an hour), Brotli or gzip when the request
//     accepts it, with ETag and 304;
//   - every other request goes to the handler, its body streamed through gzip
//     or Brotli when it is text, JSON or XML;
//   - every response, static or not, leaves with the headers of
//     src/lib/security-headers.ts, whichever of the two made it.
//
// serve.ts runs it (environment, signals, logs). This file has no global state
// so the tests can start it on a port of their own.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import { createNonce, securityHeaders } from "../lib/security-headers.ts";
import {
  decodePathname,
  type Encoding,
  etagMatches,
  isCompressible,
  MIN_COMPRESS_BYTES,
  negotiateEncoding,
  type StaticFile,
  type StaticIndex,
} from "./static.ts";

export interface NodeServerOptions {
  /** The app: dist/server/server.js's `fetch`. */
  handler: (request: Request) => Promise<Response> | Response;
  /** The built browser files, from `indexStaticFiles`. */
  staticFiles: StaticIndex;
  /**
   * Read the scheme and host from X-Forwarded-Proto and X-Forwarded-Host.
   * Only for a server that sits behind a reverse proxy that sets them. A
   * server that is reached directly would believe whatever a client sends.
   */
  trustProxy?: boolean;
  /** One structured line per request, and per failure. */
  log?: (entry: Record<string, unknown>) => void;
  /** A request body larger than this is refused with 413. The board takes none, so the default is small. */
  maxBodyBytes?: number;
  /**
   * The Strict-Transport-Security value for every response, or false to send
   * none. The app's own header (it includes subdomains, for the Cloudflare
   * staging site) is replaced: a self-hoster's domain may carry plain-HTTP
   * services. Default: max-age=31536000.
   */
  hsts?: string | false;
}

export const DEFAULT_NODE_HSTS = "max-age=31536000";

/** The HSTS environment variable: "on" (default), "subdomains" or "off". */
export function hstsFromEnv(value: string | undefined): string | false {
  switch ((value ?? "").trim().toLowerCase()) {
    case "":
    case "on":
    case "1":
    case "true":
      return DEFAULT_NODE_HSTS;
    case "subdomains":
      return `${DEFAULT_NODE_HSTS}; includeSubDomains`;
    case "off":
    case "0":
    case "false":
      return false;
    default:
      throw new Error(`HSTS must be "on", "subdomains" or "off", got "${value}"`);
  }
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const NO_BODY_STATUSES = new Set([204, 205, 304]);

/** The text of a response the server makes itself (bad request, failure), with the security headers. */
function plain(res: ServerResponse, status: number, text: string, head: boolean, hsts: string | false): void {
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  addSecurityHeaders(headers, hsts);
  headers.set("Content-Length", String(Buffer.byteLength(text)));
  writeHead(res, status, headers);
  res.end(head ? undefined : text);
}

function addSecurityHeaders(headers: Headers, hsts: string | false): void {
  // The app's own responses already carry the policy with their page's nonce
  // (src/start.ts); a file or error text made here has no inline script, so
  // a fresh nonce that nothing uses is all its policy needs.
  for (const [name, value] of Object.entries(securityHeaders({ dev: false, nonce: createNonce(), hsts }))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  // The server decides HSTS, whatever the app put on its response.
  if (hsts === false) headers.delete("Strict-Transport-Security");
  else headers.set("Strict-Transport-Security", hsts);
}

/** Sends the status line and headers; Set-Cookie stays one header per cookie. */
function writeHead(res: ServerResponse, status: number, headers: Headers): void {
  const flat: string[] = [];
  for (const [name, value] of headers) {
    if (name !== "set-cookie") flat.push(name, value);
  }
  for (const cookie of headers.getSetCookie()) flat.push("set-cookie", cookie);
  res.writeHead(status, flat);
}

function appendVary(headers: Headers, field: string): void {
  const current = headers.get("vary");
  if (current === "*") return;
  if (current?.split(",").some((part) => part.trim().toLowerCase() === field.toLowerCase())) return;
  headers.set("vary", current ? `${current}, ${field}` : field);
}

/** The first value of a (possibly comma-joined) forwarded header. */
function firstValue(value: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(value) ? value[0] : value;
  return joined?.split(",")[0]?.trim() || undefined;
}

/** `scheme://host` for the Request URL; a Host header that is not a plain host[:port] falls back to localhost. */
function requestOrigin(req: IncomingMessage, trustProxy: boolean): string {
  const proto = trustProxy ? firstValue(req.headers["x-forwarded-proto"]) : undefined;
  const host = (trustProxy ? firstValue(req.headers["x-forwarded-host"]) : undefined) ?? req.headers.host;
  const scheme = proto === "https" ? "https" : "http";
  return `${scheme}://${host && /^[A-Za-z0-9._:[\]-]+$/.test(host) ? host : "localhost"}`;
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

class BodyTooLarge extends Error {}

/** The request body as a web stream, failing with BodyTooLarge once it passes `max` bytes. */
function limitedBody(req: IncomingMessage, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      callback(seen > max ? new BodyTooLarge("request body too large") : null, chunk);
    },
  });
  pipeline(req, counter).catch(() => {});
  return Readable.toWeb(counter) as unknown as ReadableStream<Uint8Array>;
}

/** Streams the handler's body to the socket, compressed when the response allows and the client accepts it. */
async function sendResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  head: boolean,
  hsts: string | false,
): Promise<void> {
  const headers = new Headers(response.headers);
  addSecurityHeaders(headers, hsts);
  const { status, body } = response;
  const empty = head || !body || NO_BODY_STATUSES.has(status);

  let encoding: Encoding | null = null;
  if (isCompressible(headers.get("content-type"))) {
    appendVary(headers, "Accept-Encoding");
    const transform = /\bno-transform\b/i.test(headers.get("cache-control") ?? "");
    const length = Number(headers.get("content-length") ?? Number.POSITIVE_INFINITY);
    if (
      !empty &&
      !transform &&
      length >= MIN_COMPRESS_BYTES &&
      !headers.has("content-encoding") &&
      !headers.has("content-range")
    ) {
      encoding = negotiateEncoding(req.headers["accept-encoding"]);
    }
  }
  if (encoding) {
    headers.delete("content-length");
    headers.set("content-encoding", encoding);
    // A compressed body is not byte-for-byte the representation the validator named.
    const etag = headers.get("etag");
    if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
  }

  writeHead(res, status, headers);
  if (empty) {
    await body?.cancel().catch(() => {});
    res.end();
    return;
  }

  const source = Readable.fromWeb(body as unknown as NodeReadableStream);
  if (!encoding) {
    await pipeline(source, res);
    return;
  }
  // Flushing after every chunk keeps a streamed page streaming: the compressor
  // would otherwise hold a chunk back until it had enough to fill a block.
  const compressor =
    encoding === "br"
      ? createBrotliCompress({
          params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
          flush: constants.BROTLI_OPERATION_FLUSH,
        })
      : createGzip({ level: 6, flush: constants.Z_SYNC_FLUSH });
  await pipeline(source, compressor, res);
}

/** A file from dist/client, from memory, with a validator and the encoding the request asked for. */
async function sendStatic(
  req: IncomingMessage,
  res: ServerResponse,
  file: StaticFile,
  head: boolean,
  hsts: string | false,
): Promise<void> {
  const headers = new Headers({
    "Content-Type": file.contentType,
    "Cache-Control": file.cacheControl,
    ETag: file.etag,
  });
  addSecurityHeaders(headers, hsts);
  if (file.compressible) appendVary(headers, "Accept-Encoding");

  if (etagMatches(req.headers["if-none-match"], file.etag)) {
    writeHead(res, 304, headers);
    res.end();
    return;
  }

  let body = file.body;
  const encoding = negotiateEncoding(req.headers["accept-encoding"]);
  const encoded = encoding ? await file.encoded(encoding) : null;
  if (encoding && encoded) {
    body = encoded;
    headers.set("Content-Encoding", encoding);
  }
  headers.set("Content-Length", String(body.length));
  writeHead(res, 200, headers);
  res.end(head ? undefined : body);
}

export function createNodeServer(options: NodeServerOptions): Server {
  const {
    handler,
    staticFiles,
    trustProxy = false,
    log,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    hsts = DEFAULT_NODE_HSTS,
  } = options;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const head = method === "HEAD";
    const rawUrl = req.url ?? "/";
    // Only origin-form targets ("/path?query"); a proxy-style absolute URL or "*" is not a request for this server.
    if (!rawUrl.startsWith("/")) return plain(res, 400, "Bad Request\n", head, hsts);
    let url: URL;
    let headers: Headers;
    try {
      url = new URL(`${requestOrigin(req, trustProxy)}${rawUrl}`);
      headers = toHeaders(req);
    } catch {
      return plain(res, 400, "Bad Request\n", head, hsts);
    }

    if (method === "GET" || head) {
      const path = decodePathname(url.pathname);
      const file = path === null ? undefined : staticFiles.get(path);
      if (file) return sendStatic(req, res, file, head, hsts);
    }

    const hasBody = method !== "GET" && !head;
    if (hasBody && Number(req.headers["content-length"]) > maxBodyBytes) {
      return plain(res, 413, "Payload Too Large\n", head, hsts);
    }
    // A client that hangs up cancels the request the app is still working on.
    const abort = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const request = new Request(url, {
      method,
      headers,
      signal: abort.signal,
      ...(hasBody ? { body: limitedBody(req, maxBodyBytes), duplex: "half" } : {}),
    } as RequestInit);

    let response: Response;
    try {
      response = await handler(request);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof BodyTooLarge || (error as { cause?: unknown })?.cause instanceof BodyTooLarge) {
        return plain(res, 413, "Payload Too Large\n", head, hsts);
      }
      log?.({ level: "error", msg: "handler failed", path: url.pathname, error: String(error) });
      return plain(res, 500, "Internal Server Error\n", head, hsts);
    }
    await sendResponse(req, res, response, head, hsts);
  }

  // Requests in flight per socket. Node's closeIdleConnections() skips a
  // socket that has connected but sent nothing yet (a browser preconnect, a
  // proxy's pooled connection), and that would hold a graceful shutdown until
  // its timeout; so the sockets are counted here and closeIdleConnections is
  // extended to destroy the ones with no request in flight.
  const inFlight = new Map<Socket, number>();

  const server = createServer((req, res) => {
    const started = performance.now();
    const socket = req.socket;
    inFlight.set(socket, (inFlight.get(socket) ?? 0) + 1);
    res.once("close", () => {
      const count = inFlight.get(socket);
      if (count !== undefined) inFlight.set(socket, Math.max(0, count - 1));
    });
    res.once("close", () => {
      const path = (req.url ?? "").split("?")[0];
      // Probes every few seconds would drown the log; a failing one is still written.
      if (path === "/healthz" && res.statusCode === 200) return;
      log?.({
        level: "info",
        msg: "request",
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
        ...(res.writableFinished ? {} : { aborted: true }),
      });
    });
    handle(req, res).catch((error: unknown) => {
      // A failure while streaming: the status line is gone, so all that is left is to drop the connection.
      if (!res.headersSent) {
        log?.({ level: "error", msg: "request failed", path: req.url, error: String(error) });
        plain(res, 500, "Internal Server Error\n", req.method === "HEAD", hsts);
      } else {
        res.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    inFlight.set(socket, 0);
    socket.once("close", () => inFlight.delete(socket));
  });
  const closeIdleConnections = server.closeIdleConnections.bind(server);
  server.closeIdleConnections = () => {
    closeIdleConnections();
    for (const [socket, count] of inFlight) {
      if (count === 0) socket.destroy();
    }
  };
  // Longer than the 60 s idle timeout most load balancers use, so the proxy
  // closes a connection first and never writes to one this server just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  return server;
}
