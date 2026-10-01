import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./smoke.sh", import.meta.url));
const FOOTER = "Not affiliated with any of these vendors. I only read their public status pages.";

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
function smoke(base: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(SCRIPT, [base]);
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
        `<p>Not<!-- --> affiliated with any of these vendors. I only read their public<!-- --> status pages.</p>${FILLER}`,
      ),
    );
    expect(output).not.toContain("no footer line");
  }, 30_000);

  it("reports a page without the footer", async () => {
    const output = await smoke(await serve(`<p>hello</p>${FILLER}`));
    expect(output).toContain(`/: no footer line "${FOOTER}"`);
  }, 30_000);
});
