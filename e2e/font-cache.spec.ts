import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import { upstreamUrl } from "../scripts/ci/upstream-url.ts";

// A return visit draws the page in the self-hosted Inter only if the browser can use its copy of the font without
// asking the network: Inter is font-display: optional (src/styles.css), and Chromium uses an optional font that was
// not preloaded only if it is ready when the page starts to render. So this test does not stay in one browser
// session, where the font would come from the renderer's memory cache whatever the headers say. It closes the
// browser and starts a new one on the same profile (the disk cache is all that is left), through a proxy that sets
// the headers Cloudflare sends in production: the rules of public/_headers, or, as the control, Cloudflare's default
// for a file with no rule, "max-age=0, must-revalidate".

const CLOUDFLARE_DEFAULT = "public, max-age=0, must-revalidate";
/** The time the document takes to arrive, during which the font is read from disk. A real connection is never at zero. */
const DOCUMENT_DELAY_MS = 150;
/** The time a request for Inter takes when it does reach the server: a round trip, too late for an optional font. */
const FONT_DELAY_MS = 400;

type Rules = Array<{ pattern: string; headers: Record<string, string> }>;

/** The rules of public/_headers: a path pattern on a line of its own, then its headers, indented. */
function readHeaderRules(): Rules {
  const text = readFileSync(fileURLToPath(new URL("../public/_headers", import.meta.url)), "utf8");
  const rules: Rules = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line.trim(), headers: {} });
      continue;
    }
    const colon = line.indexOf(":");
    const rule = rules.at(-1);
    if (rule) rule.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return rules;
}

/** The headers Cloudflare adds to a static file at this path: the rules that match it, a trailing * being a prefix. */
function headersFor(rules: Rules, path: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const { pattern, headers } of rules) {
    const matches = pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
    if (matches) Object.assign(found, headers);
  }
  return found;
}

/** A server in front of the preview that sets the headers of the built files and holds the document back a little. */
async function serveLikeProduction(origin: string, shipped: boolean) {
  const rules = readHeaderRules();
  /** The requests for Inter that reached the server, "conditional" for a revalidation of a copy. */
  const fontRequests: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      // The host is the test's own preview, never the request's: anything but an origin-relative path is refused.
      const upstreamHref = upstreamUrl(origin, request.url ?? "/");
      if (upstreamHref === null) {
        response.writeHead(400).end();
        return;
      }
      const target = new URL(upstreamHref);
      const isFont = target.pathname.startsWith("/assets/inter-var");
      if (isFont) fontRequests.push(request.headers["if-none-match"] ? "conditional" : "full");
      const upstream = await fetch(upstreamHref, {
        headers: Object.fromEntries(
          ["accept", "if-none-match", "if-modified-since"].flatMap((name) => {
            const value = request.headers[name];
            return typeof value === "string" ? [[name, value]] : [];
          }),
        ),
        redirect: "manual",
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      const headers: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)) {
          headers[name] = value;
        }
      });
      if (target.pathname.startsWith("/assets/")) {
        headers["cache-control"] = CLOUDFLARE_DEFAULT;
        if (shipped) Object.assign(headers, headersFor(rules, target.pathname));
      }
      const delay = isFont
        ? FONT_DELAY_MS
        : (upstream.headers.get("content-type") ?? "").includes("text/html")
          ? DOCUMENT_DELAY_MS
          : 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      response.writeHead(upstream.status, { ...headers, "content-length": upstream.status === 304 ? 0 : body.length });
      response.end(upstream.status === 304 ? undefined : body);
    } catch {
      response.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, fontRequests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The font families Chromium really drew the text of the first element matching the selector in (Chrome DevTools). */
async function drawnFonts(context: BrowserContext, page: Page, selector: string): Promise<string[]> {
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((font) => font.familyName);
  } finally {
    await cdp.detach();
  }
}

/**
 * Visits the site in a browser session, closes the browser, and visits again in new sessions on the same profile, up
 * to `visits` times or until `stop` says enough. Returns what each return visit's headline was drawn in and what its
 * Inter request cost, and the requests for Inter the server saw after the first visit.
 */
async function returnVisits(origin: string, shipped: boolean, visits: number, stop: (fonts: string[]) => boolean) {
  const { server, fontRequests, url } = await serveLikeProduction(origin, shipped);
  const profile = await mkdtemp(join(tmpdir(), "font-cache-"));
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      baseURL: url,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      locale: "en-GB",
      timezoneId: "UTC",
    });
  try {
    const first = await launch();
    try {
      const page = await first.newPage();
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.load("400 16px Inter"));
      const status = await page.evaluate(
        () => [...document.fonts].find((face) => face.family.replaceAll('"', "") === "Inter")?.status,
      );
      expect(status, "the first visit loads Inter").toBe("loaded");
    } finally {
      await first.close();
    }
    expect(fontRequests, "the first visit fetches Inter").toEqual(["full"]);
    fontRequests.length = 0;

    const returns: Array<{ fonts: string[]; transferSizes: number[] }> = [];
    while (returns.length < visits) {
      const session = await launch();
      try {
        const page = await session.newPage();
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect(page.locator("h1")).toBeVisible();
        const fonts = await drawnFonts(session, page, "h1");
        // Let the request finish before the browser closes: one cut short leaves no copy to ask about next time.
        await page.evaluate(() => document.fonts.load("400 16px Inter"));
        const transferSizes = await page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .filter((entry) => entry.name.includes("/assets/inter-var"))
            .map((entry) => (entry as PerformanceResourceTiming).transferSize),
        );
        returns.push({ fonts, transferSizes });
        if (stop(fonts)) break;
      } finally {
        await session.close();
      }
    }
    return { returns, fontRequests };
  } finally {
    server.close();
    await rm(profile, { recursive: true, force: true });
  }
}

const isInter = (family: string) => family.startsWith("Inter");

test("draws the headline in the self-hosted Inter on a return visit in a new browser session", async ({
  browserName,
  baseURL,
}, testInfo) => {
  test.skip(
    browserName !== "chromium",
    "the disk cache and the fallback faces are what Chromium has on Android, Windows and Linux",
  );
  test.skip(testInfo.project.name !== "desktop", "it starts browsers of its own, so one project is enough");
  test.setTimeout(120_000);
  const origin = baseURL ?? "http://127.0.0.1:4173";

  // The rules the site ships cover the fonts, whatever their hashed names.
  expect(headersFor(readHeaderRules(), "/assets/inter-var-AbCd1234.woff2")["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );

  // The control, Cloudflare's default: the copy has to be checked with the server before it is used, which is too late
  // for an optional font, so the headline is in the system font every time. This is what the rules above are for.
  const revalidated = await returnVisits(origin, false, 2, () => false);
  for (const { fonts } of revalidated.returns) {
    expect(fonts.length, "the headline is drawn in some font").toBeGreaterThan(0);
    expect(fonts.some(isInter), `a copy that must be revalidated is not used (${fonts})`).toBe(false);
  }
  expect(revalidated.fontRequests, "each return visit asks the server about its copy").toEqual([
    "conditional",
    "conditional",
  ]);

  // With the shipped rules the copy is fresh for a year: nothing is asked of the network, and the headline can be in
  // Inter from the first paint. Whether it is depends on the disk cache answering before the page starts to render, which
  // is a race (about one visit in ten loses it), so a few new sessions are allowed to win it.
  const cached = await returnVisits(origin, true, 6, (fonts) => fonts.some(isInter));
  expect(cached.fontRequests, "no return visit asks the server for Inter").toEqual([]);
  for (const { transferSizes } of cached.returns) {
    expect(transferSizes.length, "the return visit uses Inter").toBeGreaterThan(0);
    expect(transferSizes, "Inter needs no transfer").toEqual(transferSizes.map(() => 0));
  }
  const fonts = cached.returns.map((visit) => visit.fonts.join(", "));
  expect(
    cached.returns.some((visit) => visit.fonts.some(isInter)),
    `a return visit's headline is drawn in Inter (drawn in ${fonts.join("; ")})`,
  ).toBe(true);
});
