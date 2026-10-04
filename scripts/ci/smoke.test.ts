import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
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
