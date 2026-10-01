import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const moduleUrl = new URL("./sources.server.ts", import.meta.url).href;

function runBounded(source: string): void {
  // A subprocess lets the deadline stop a synchronous parser regression; a
  // Vitest timeout alone cannot interrupt a blocked event loop.
  const child = spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--experimental-strip-types", "--input-type=module", "-e", source],
    {
      encoding: "utf8",
      timeout: 6_000,
    },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
}

describe("bounded vendor payload parsing", () => {
  it("reads a near-limit uppercase RSS field within the subprocess memory budget", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { parseRssItems, grokItemHealth } from ${JSON.stringify(moduleUrl)};
      const title = "A".repeat(4 * 1024 * 1024 - 200);
      const xml = "<rss><channel><item><title>" + title + "</title></item></channel></rss>";
      assert.ok(Buffer.byteLength(xml) < 4 * 1024 * 1024);
      assert.equal(parseRssItems(xml)[0].title, title);
      assert.equal(grokItemHealth("<!--".repeat(1_000_000) + "Status: Resolved"), "operational");
    `);
  }, 10_000);

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
  }, 10_000);

  it("handles repeated unclosed RSS field openers", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { parseRssItems } from ${JSON.stringify(moduleUrl)};
      const rows = parseRssItems("<item>" + "<title>".repeat(80_000) + "<description>Working</description></item>");
      assert.deepEqual(rows, [{ title: "", description: "Working", pubDate: undefined, link: undefined }]);
    `);
  }, 10_000);

  it("handles repeated unclosed HTML comment openers", () => {
    runBounded(`
      import assert from "node:assert/strict";
      import { grokItemHealth } from ${JSON.stringify(moduleUrl)};
      assert.equal(grokItemHealth("<!--".repeat(100_000) + "Status: Resolved"), "operational");
    `);
  }, 10_000);

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
  }, 10_000);

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
  }, 10_000);
});
