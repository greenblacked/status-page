import { expect, test } from "./test";

// The board served by the production Node server (src/node/serve.ts), the one the Docker image runs. These run
// only under E2E_SERVER=node, which makes playwright.config.ts start that server instead of `vite preview`
// (CI's "browser tests (node server)" job): the page, its script and its font come from one origin, so what
// they prove is that the cache rules, the compression and the headers reach a browser as the README promises.

test.skip(process.env.E2E_SERVER !== "node", "needs the production Node server: E2E_SERVER=node");

const SECURITY_HEADERS = [
  "content-security-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
];

test.describe("@node-server the board behind the production server", () => {
  test("renders the board and hydrates it", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/^(\(\d+\) )?Status$/);
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    await expect(page.locator('article[id^="service-"]').first()).toBeVisible();
    await expect(page.locator('article[id^="service-"]')).toHaveCount(20);
  });

  test("loads the page's own script, stylesheet and fonts with a one-year immutable cache", async ({ page }) => {
    const assets: { url: string; status: number; cache: string | null; type: string | null }[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/assets/")) {
        assets.push({
          url: url.pathname,
          status: response.status(),
          cache: response.headers()["cache-control"] ?? null,
          type: response.headers()["content-type"] ?? null,
        });
      }
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    expect(assets.some((asset) => asset.url.endsWith(".js"))).toBe(true);
    expect(assets.some((asset) => asset.url.endsWith(".css"))).toBe(true);
    for (const asset of assets) {
      expect(asset.status, asset.url).toBe(200);
      expect(asset.cache, asset.url).toBe("public, max-age=31536000, immutable");
    }
  });

  test("compresses text and revalidates with an ETag", async ({ request, page }) => {
    await page.goto("/");
    const script = await page.locator('script[type="module"][src^="/assets/"]').first().getAttribute("src");
    expect(script).toBeTruthy();
    const first = await request.get(script ?? "", { headers: { "Accept-Encoding": "br, gzip" } });
    expect(first.status()).toBe(200);
    expect(first.headers()["content-encoding"]).toBe("br");
    expect(first.headers().vary).toContain("Accept-Encoding");
    const etag = first.headers().etag;
    expect(etag).toBeTruthy();
    const again = await request.get(script ?? "", { headers: { "If-None-Match": etag ?? "" } });
    expect(again.status()).toBe(304);
    expect(again.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("sends the security headers on the page, the API and a static file", async ({ request }) => {
    for (const path of ["/", "/api/status.json", "/healthz", "/favicon.svg", "/nope"]) {
      const response = await request.get(path);
      for (const name of SECURITY_HEADERS) expect(response.headers()[name], `${path} ${name}`).toBeTruthy();
    }
    const icon = await request.get("/favicon.svg");
    expect(icon.headers()["cache-control"]).toBe("public, max-age=3600");
  });

  test("answers /healthz, /readyz and the API like any other host", async ({ request }) => {
    expect(await (await request.get("/healthz")).text()).toBe("ok\n");
    expect([200, 503]).toContain((await request.get("/readyz")).status());
    const board = await (await request.get("/api/status.json")).json();
    expect(board.services).toHaveLength(20);
  });
});
