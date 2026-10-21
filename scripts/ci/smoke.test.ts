import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./smoke.sh", import.meta.url));
const FOOTER =
  "Independent project, not affiliated with or endorsed by any of the vendors listed. Status data comes from their official public status pages and feeds.";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** Serves `page` at / and a bare 200 elsewhere; resolves to the base URL. */
async function serve(page: string): Promise<string> {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/" ? page : "ok\n");
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Runs smoke.sh against `base`; the other checks fail on this stub, only the footer one is read. */
function smoke(base: string, ...args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(SCRIPT, [base, ...args]);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", () => resolve(output));
  });
}

// The footer comes first, on a line of its own, and the rest of the page is far over a pipe buffer
// (64 KiB): grep -q would stop at the footer while sed is still writing, and
// under pipefail the SIGPIPE would fail the check on a good page.
const FILLER = `\n${`<div>${"x".repeat(100)}</div>\n`.repeat(20_000)}`;

describe("smoke.sh footer check", () => {
  it("finds the footer, with React's <!-- --> separators, at the top of a large page", async () => {
    const output = await smoke(
      await serve(
        `<p>Independent project, not<!-- --> affiliated with or endorsed by any of the vendors listed. Status data comes from their<!-- --> official public status pages and feeds.</p>${FILLER}`,
      ),
    );
    expect(output).not.toContain("no footer line");
  }, 30_000);

  it("reports a page without the footer", async () => {
    const output = await smoke(await serve(`<p>hello</p>${FILLER}`));
    expect(output).toContain(`/: no footer line "${FOOTER}"`);
  }, 30_000);
});

const VERSION = "8842dd8a-be26-460d-a3ea-2890e9015024";

/**
 * Serves what Cloudflare does: the Worker's answers carry X-Worker-Version, a static asset under /assets/ does not
 * (it is served without invoking the Worker). `fontCache` is the font's Cache-Control.
 */
async function serveLikeCloudflare(fontCache: string): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === "/assets/inter-var-AbCd1234.woff2") {
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": fontCache });
      res.end("font");
    } else if (req.url === "/assets/index-AbCd1234.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end('@font-face{src:url("/assets/inter-var-AbCd1234.woff2") format("woff2")}');
    } else {
      res.writeHead(200, { "content-type": "text/html", "x-worker-version": VERSION });
      res.end(req.url === "/" ? '<link rel="stylesheet" href="/assets/index-AbCd1234.css">' : "ok\n");
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("smoke.sh font cache check", () => {
  it("does not ask the static font for a Worker version, and takes its year-long cache", async () => {
    const output = await smoke(
      await serveLikeCloudflare("public, max-age=31536000, immutable"),
      "--expect-version",
      VERSION,
      "--require-asset-cache",
    );
    expect(output).not.toContain("woff2: answered by version");
    expect(output).not.toContain("woff2: Cache-Control");
  }, 30_000);

  it("still fails a font without the year-long cache", async () => {
    const output = await smoke(
      await serveLikeCloudflare("public, max-age=0, must-revalidate"),
      "--expect-version",
      VERSION,
      "--require-asset-cache",
    );
    expect(output).toContain('woff2: Cache-Control "public, max-age=0, must-revalidate", expected max-age=31536000');
  }, 30_000);
});

/** Serves a bare 200 for GET; `methods` answers any other method, or the stub answers 200 to it too. */
async function serveMethods(methods: (method: string, res: ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return methods(req.method ?? "", res);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("ok\n");
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("smoke.sh method checks", () => {
  it("takes a 204 preflight for any origin and a 405 with Allow for a POST", async () => {
    const output = await smoke(
      await serveMethods((method, res) => {
        if (method === "OPTIONS") {
          res.writeHead(204, { "access-control-allow-origin": "*", allow: "GET, HEAD, OPTIONS" });
        } else {
          res.writeHead(405, { allow: "GET, HEAD, OPTIONS", "content-type": "text/plain" });
        }
        res.end();
      }),
    );
    expect(output).not.toContain("OPTIONS /api/status.json:");
    expect(output).not.toContain("POST /api/status.json:");
  }, 30_000);

  it("fails a server that answers every method with its page", async () => {
    const output = await smoke(
      await serveMethods((_method, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html>");
      }),
    );
    expect(output).toContain("OPTIONS /api/status.json: 200, expected 204");
    expect(output).toContain("POST /api/status.json: 200, expected 405");
  }, 30_000);

  it("fails a preflight without CORS and a 405 without Allow", async () => {
    const output = await smoke(
      await serveMethods((method, res) => {
        res.writeHead(method === "OPTIONS" ? 204 : 405);
        res.end();
      }),
    );
    expect(output).toContain('OPTIONS /api/status.json: Access-Control-Allow-Origin "", expected *');
    expect(output).toContain("POST /api/status.json: 405 without an Allow header");
  }, 30_000);
});

/** Serves /api/status.json with `etag` (none when empty), answering a matching If-None-Match with 304 if `honour`. */
async function serveValidator(etag: string, honour: boolean): Promise<string> {
  server = createServer((req, res) => {
    if (req.url !== "/api/status.json") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("ok\n");
      return;
    }
    const headers: Record<string, string> = { "content-type": "application/json", ...(etag ? { etag } : {}) };
    if (honour && etag && req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("smoke.sh validator check", () => {
  it("takes an ETag that a repeat turns into 304", async () => {
    const output = await smoke(await serveValidator('W/"0123456789abcdef"', true));
    expect(output).not.toContain("no ETag header");
    expect(output).not.toContain("with If-None-Match");
  }, 30_000);

  it("fails an answer without an ETag", async () => {
    expect(await smoke(await serveValidator("", true))).toContain("/api/status.json: no ETag header");
  }, 30_000);

  it("fails a server that ignores If-None-Match", async () => {
    const output = await smoke(await serveValidator('W/"0123456789abcdef"', false));
    expect(output).toContain('/api/status.json with If-None-Match: W/"0123456789abcdef": 200, expected 304');
  }, 30_000);
});

/** Serves /favicon.svg with `nosniff` as its X-Content-Type-Options (none when empty), and a bare 200 elsewhere. */
async function serveStatic(nosniff: string): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === "/favicon.svg") {
      res.writeHead(200, {
        "content-type": "image/svg+xml",
        ...(nosniff ? { "x-content-type-options": nosniff } : {}),
      });
      res.end("<svg/>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("ok\n");
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("smoke.sh static file check", () => {
  it("takes a static file with nosniff", async () => {
    expect(await smoke(await serveStatic("nosniff"))).not.toContain("/favicon.svg:");
  }, 30_000);

  it("fails a static file without it", async () => {
    expect(await smoke(await serveStatic(""))).toContain('/favicon.svg: X-Content-Type-Options "", expected nosniff');
  }, 30_000);
});
