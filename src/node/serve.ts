// Runs the production build as a server: `pnpm run build`, then
// `node src/node/serve.ts` (or `pnpm start`). The Docker image runs the same
// file. Configuration is the environment:
//
//   PORT         port to listen on (default 3000)
//   HOST         address to bind (default 127.0.0.1; the image sets 0.0.0.0)
//   TRUST_PROXY  1 when a reverse proxy in front sets X-Forwarded-Proto and
//                X-Forwarded-Host, so the app sees its public https:// origin
//   HSTS         Strict-Transport-Security: max-age=31536000 by default;
//                "subdomains" adds includeSubDomains, "off" sends no header
//   SHUTDOWN_TIMEOUT_MS  how long a SIGTERM waits for open requests (default
//                5000, under the 10 s `docker stop` allows before SIGKILL)
//
// One JSON line per request goes to stdout, so `docker logs` and any log
// shipper read it as it is. SIGTERM and SIGINT stop accepting connections,
// let requests in flight finish and exit 0.
//
// It runs under Node's own type stripping, so it imports with `.ts` extensions
// and nothing here needs a build step of its own.

import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createNodeServer, hstsFromEnv } from "./server.ts";
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

async function main(): Promise<void> {
  const root = new URL("../../dist/", import.meta.url);
  const entry = new URL("server/server.js", root);
  let app: { default: { fetch: (request: Request) => Promise<Response> | Response } };
  try {
    app = await import(entry.href);
  } catch (error) {
    throw new Error(`cannot load ${fileURLToPath(entry)}: run \`pnpm run build\` first (${String(error)})`);
  }
  const staticFiles = await indexStaticFiles(fileURLToPath(new URL("client", root)));

  const host = process.env.HOST || "127.0.0.1";
  const listenPort = port(process.env.PORT);
  const server = createNodeServer({
    handler: (request) => app.default.fetch(request),
    staticFiles,
    hsts: hstsFromEnv(process.env.HSTS),
    trustProxy: ["1", "true"].includes((process.env.TRUST_PROXY ?? "").toLowerCase()),
    log,
  });

  let stopping = false;
  function shutdown(signal: string): void {
    if (stopping) return;
    stopping = true;
    const timeout = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 5_000;
    log({ level: "info", msg: "shutting down", signal });
    // Stop taking new connections; idle ones (keep-alive, or connected and silent) close now, busy ones when their response ends.
    server.close((error) => {
      if (error) log({ level: "error", msg: "close failed", error: String(error) });
      log({ level: "info", msg: "stopped" });
      process.exit(error ? 1 : 0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      log({ level: "warn", msg: "shutdown timed out, closing open connections" });
      server.closeAllConnections();
    }, timeout).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  server.on("error", (error) => {
    log({ level: "error", msg: "server error", error: String(error) });
    process.exit(1);
  });
  server.listen(listenPort, host, () => {
    const { address, port: bound } = server.address() as AddressInfo;
    log({ level: "info", msg: "listening", address, port: bound, files: staticFiles.size, node: process.version });
  });
}

main().catch((error: unknown) => {
  log({ level: "error", msg: "failed to start", error: String(error) });
  process.exit(1);
});
