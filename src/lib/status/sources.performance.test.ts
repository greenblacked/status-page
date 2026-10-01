import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

// The in-process budgets in redos.test.ts cannot stop a parser that blocks
// the event loop, and cannot see memory. Each case here runs the real
// exported parsers in a child process with a small heap and a hard deadline,
// so a quadratic or unbounded regression is killed rather than hanging the
// run. The budgets are far above what the linear parsers need (tens of
// milliseconds, a few megabytes) so a slow CI runner never trips them.
//
// The child runs outside Vite, on Node's own type stripping: everything
// sources.server.ts imports, directly or not, must use relative imports
// with the .ts extension and plain erasable syntax. An "@/" alias, an
// extensionless import, import.meta.env or an enum breaks every case here,
// with only the child's stderr to go on.
const moduleUrl = new URL("./sources.server.ts", import.meta.url).href;
const DEADLINE_MS = 8_000;
const HEAP_MB = 128;

function runBounded(source: string): void {
  const child = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${HEAP_MB}`,
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      source,
    ],
    { encoding: "utf8", timeout: DEADLINE_MS },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
}

describe("bounded vendor payload parsing", () => {
  it("reads a near-limit uppercase RSS field and a huge run of comment openers within the budget", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { parseRssItems, grokItemHealth } from ${JSON.stringify(moduleUrl)};
      const title = "A".repeat(4 * 1024 * 1024 - 200);
      const xml = "<RSS><CHANNEL><ITEM><TITLE>" + title + "</TITLE></ITEM></CHANNEL></RSS>";
      assert.ok(Buffer.byteLength(xml) < 4 * 1024 * 1024);
      assert.equal(parseRssItems(xml)[0].title, title);
      assert.equal(grokItemHealth("<!--".repeat(1_000_000) + "Status: Resolved"), "operational");
    `);
  }, 12_000);

  it("handles repeated unclosed CDATA openers", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { decodeXmlField } from ${JSON.stringify(moduleUrl)};
      const raw = "<![CDATA[".repeat(100_000) + "&amp;";
      const result = decodeXmlField(raw);
      assert.equal(result.length, raw.length - "<![CDATA[".length);
      assert.ok(result.startsWith("<![CDATA["));
      assert.ok(result.endsWith("&amp;"));
    `);
  }, 12_000);

  it("handles repeated unclosed RSS field openers", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { parseRssItems } from ${JSON.stringify(moduleUrl)};
      const rows = parseRssItems("<item>" + "<title>".repeat(80_000) + "<description>Working</description></item>");
      assert.deepEqual(rows, [{ title: "", description: "Working", pubDate: undefined, link: undefined }]);
    `);
  }, 12_000);

  it("caps a feed of many items at the scan and keep bounds", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { parseRssItems, MAX_RSS_ITEMS, MAX_RSS_SCANNED } from ${JSON.stringify(moduleUrl)};
      const xml = Array.from({ length: MAX_RSS_SCANNED * 4 }, (_, i) => "<item><title>t" + i + "</title></item>").join("");
      const rows = parseRssItems(xml);
      assert.equal(rows.length, MAX_RSS_ITEMS);
      assert.equal(rows[0].title, "t0");
    `);
  }, 12_000);

  it("matches a large catalogue of distinct affected products", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { googleComponents } from ${JSON.stringify(moduleUrl)};
      const products = Array.from({ length: 25_000 }, (_, i) => ({ id: String(i), title: "Product " + i }));
      const refs = products.map(({ id }) => ({ id }));
      const rows = googleComponents(products, [{ status_impact: "SERVICE_DISRUPTION", affected_products: refs }]);
      assert.equal(rows.length, products.length);
      assert.ok(rows.every((row) => row.health === "degraded"));
      assert.equal(rows.at(-1).name, "Product 24999");
    `);
  }, 12_000);

  it("appends many distinct affected products missing from a catalogue", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { googleComponents } from ${JSON.stringify(moduleUrl)};
      const refs = Array.from({ length: 25_000 }, (_, i) => ({ id: String(i), title: "New product " + i }));
      const rows = googleComponents([{ id: "seed", title: "Seed" }], [
        { status_impact: "SERVICE_DISRUPTION", affected_products: refs },
      ]);
      assert.equal(rows.length, refs.length + 1);
      assert.deepEqual(rows[0], { name: "Seed", health: "operational" });
      assert.equal(rows.at(-1).name, "New product 24999");
      assert.ok(rows.slice(1).every((row) => row.health === "degraded"));
    `);
  }, 12_000);
});
