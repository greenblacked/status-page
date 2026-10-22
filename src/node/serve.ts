// Runs the production build as a server: `pnpm run build`, then
// `node src/node/serve.ts` (or `pnpm start`). The Docker image runs the same
// file. Configuration is the environment:
//
//   PORT         port to listen on (default 3000)
//   HOST         address to bind (default 127.0.0.1; the image sets 0.0.0.0)
//   TRUST_PROXY  1 when a reverse proxy in front sets X-Forwarded-Proto and
//                X-Forwarded-Host, so the app sees its public https:// origin
//   PUBLIC_ORIGIN  the site's own origin, such as https://status.example.com;
//                when set, the app's request URLs (and the feed's self links)
//                are built on it and Host and X-Forwarded-* are ignored. A
//                value that is not an http(s) origin fails at start
//   HSTS         Strict-Transport-Security: max-age=31536000 by default;
//                "subdomains" adds includeSubDomains, "off" sends no header
//   SHUTDOWN_TIMEOUT_MS  how long a SIGTERM waits for open requests (default
//                5000, under the 10 s `docker stop` allows before SIGKILL)
//
// One JSON line per request goes to stdout, so `docker logs` and any log
// shipper read it as it is. SIGTERM and SIGINT stop accepting connections,
// let requests in flight finish and exit 0. A promise rejected with no
// handler is logged and the server keeps going; an uncaught exception is
// logged and shuts the server down the same way, exiting 1.
//
// Once listening, the server asks itself for /readyz, in-process, so the
// first board is collected before the first visitor asks for it.
//
// It runs under Node's own type stripping, so it imports with `.ts` extensions
// and nothing here needs a build step of its own.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createNodeServer, hstsFromEnv, publicOriginFromEnv } from "./server.ts";
import { indexStaticFiles } from "./static.ts";

// React and the server entry pick their production code from NODE_ENV when
// they load, so it has to be set before the import below.
process.env.NODE_ENV ??= "production";

function log(entry: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

function port(value: string | undefined): number {
  if (value === undefined || value === "") return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`PORT must be a number from 0 to 65535, got "${value}"`);
  }
  return parsed;
}

let server: Server | undefined;
let stopping = false;

/**
 * Stops taking new connections, lets requests in flight finish (up to
 * SHUTDOWN_TIMEOUT_MS) and exits with `code`, or 1 if closing failed.
 * Before the server exists there is nothing to wait for.
 */
function shutdown(reason: string, code = 0): void {
  if (stopping) return;
  stopping = true;
  log({ level: "info", msg: "shutting down", signal: reason });
  const running = server;
  if (!running) {
    process.exit(code);
    return;
  }
  const timeout = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 5_000;
  // Stop taking new connections; idle ones (keep-alive, or connected and silent) close now, busy ones when their response ends.
  running.close((error) => {
    if (error) log({ level: "error", msg: "close failed", error: String(error) });
    log({ level: "info", msg: "stopped" });
    process.exit(error ? 1 : code);
  });
  running.closeIdleConnections();
  setTimeout(() => {
    log({ level: "warn", msg: "shutdown timed out, closing open connections" });
    running.closeAllConnections();
  }, timeout).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// A rejection nothing handled is a bug to fix, not a reason to drop every
// open request: log it and keep serving.
process.on("unhandledRejection", (error: unknown) =>
  log({ level: "error", msg: "unhandled rejection", error: String(error) }),
);
// After an uncaught exception the process may be in any state, so it stops,
// but as a SIGTERM would: requests in flight still get their answers.
process.on("uncaughtException", (error: Error) => {
  log({ level: "error", msg: "uncaught exception", error: String(error) });
  shutdown("uncaughtException", 1);
});

async function main(): Promise<void> {
  // Settings first, so a bad value fails before the app loads.
  const host = process.env.HOST || "127.0.0.1";
  const listenPort = port(process.env.PORT);
  const hsts = hstsFromEnv(process.env.HSTS);
  const publicOrigin = publicOriginFromEnv(process.env.PUBLIC_ORIGIN);

  const root = new URL("../../dist/", import.meta.url);
  const entry = new URL("server/server.js", root);
  let app: { default: { fetch: (request: Request) => Promise<Response> | Response } };
  try {
    app = await import(entry.href);
  } catch (error) {
    throw new Error(`cannot load ${fileURLToPath(entry)}: run \`pnpm run build\` first (${String(error)})`);
  }
  const staticFiles = await indexStaticFiles(fileURLToPath(new URL("client", root)));

  const created = createNodeServer({
    handler: (request) => app.default.fetch(request),
    staticFiles,
    hsts,
    trustProxy: ["1", "true"].includes((process.env.TRUST_PROXY ?? "").toLowerCase()),
    publicOrigin,
    log,
  });

  server = created;

  created.on("error", (error) => {
    log({ level: "error", msg: "server error", error: String(error) });
    process.exit(1);
  });
  created.listen(listenPort, host, () => {
    const { address, port: bound } = created.address() as AddressInfo;
    log({ level: "info", msg: "listening", address, port: bound, files: staticFiles.size, node: process.version });
    // Warm the board through the app itself: importing board-cache here
    // would load a second copy of it, outside the bundle, with its own cache.
    const warming = performance.now();
    Promise.resolve()
      .then(() => app.default.fetch(new Request(`http://127.0.0.1:${bound}/readyz`)))
      .then(async (response) => {
        await response.body?.cancel();
        log({
          level: "info",
          msg: "board warmed",
          status: response.status,
          ms: Math.round(performance.now() - warming),
        });
      })
      .catch((error: unknown) => log({ level: "warn", msg: "warm-up failed", error: String(error) }));
  });
}

main().catch((error: unknown) => {
  log({ level: "error", msg: "failed to start", error: String(error) });
  process.exit(1);
});
