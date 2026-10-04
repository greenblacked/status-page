import type { Page } from "@playwright/test";
import { ALERTS_UNSUPPORTED_ATTRIBUTE } from "../src/lib/status/alerts-support.ts";
import { BACKGROUND_STORAGE_KEY } from "../src/lib/status/background.ts";
import { expect, test } from "./test";

// The Content-Security-Policy runs a script only by the nonce of its own response (src/lib/security-headers.ts),
// with no 'unsafe-inline'. A mistake in that wiring (a script the router did not stamp, a nonce that does not match
// the header) does not fail the build: the browser blocks the script, hydration never happens and the page looks
// like a still picture. So these tests load the real build and read what the browser itself reports.

const SERVICES = 20;
const cards = (page: Page) => page.locator('article[id^="service-"]');

/** The `script-src` directive of a policy, the part the nonce is in. */
const scriptSrc = (policy: string): string => policy.split(/;\s*/).find((part) => part.startsWith("script-src ")) ?? "";

/**
 * Collects what the browser says about the policy: `securitypolicyviolation` events (installed before any script of
 * the page runs) and console errors, which is where Chromium and WebKit print "Refused to execute ...". The list is
 * read from the page, so a violation in the document's own scripts is counted too.
 */
async function watchPolicy(page: Page): Promise<() => Promise<string[]>> {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`uncaught: ${error.message}`));
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} blocked ${event.blockedURI || "inline"} (${event.sample})`);
    });
  });
  return async () => {
    const events = await page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    );
    return [...events, ...consoleErrors];
  };
}

test("sends a script-src with a nonce and strict-dynamic, and no unsafe-inline", async ({ request }) => {
  const response = await request.get("/", { headers: { accept: "text/html" } });
  const policy = response.headers()["content-security-policy"] ?? "";
  const scripts = scriptSrc(policy);
  expect(scripts).toMatch(/^script-src 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic' 'self'$/);
  expect(scripts).not.toContain("unsafe-inline");
  expect(scripts).not.toContain("unsafe-eval");
  // Styles keep it: React's style attributes cannot carry a nonce.
  expect(policy).toContain("style-src 'self' 'unsafe-inline'");
  expect(policy).toContain("frame-ancestors 'none'");
});

test("gives every response a nonce of its own, and every script of the page that nonce", async ({ request }) => {
  const nonces = new Set<string>();
  for (let visit = 0; visit < 3; visit++) {
    const response = await request.get("/", { headers: { accept: "text/html" } });
    const nonce = /'nonce-([^']+)'/.exec(response.headers()["content-security-policy"] ?? "")?.[1];
    if (!nonce) throw new Error("the response names no nonce");
    nonces.add(nonce);
    const html = await response.text();
    // Every script tag, inline or not, is stamped with the nonce the header names, and the router's <meta> repeats
    // it for the browser's own router to read.
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(3);
    for (const tag of tags) expect(tag, "a script without this response's nonce").toContain(`nonce="${nonce}"`);
    expect(html).toContain(`<meta property="csp-nonce" content="${nonce}"`);
  }
  expect(nonces.size, "a nonce was reused by two responses").toBe(3);
});

test("keeps the security headers on the other routes, and no script nonce in them is needed", async ({ request }) => {
  for (const path of ["/healthz", "/api/status.json", "/robots.txt"]) {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers["content-security-policy"], path).toContain("default-src 'self'");
    expect(scriptSrc(headers["content-security-policy"] ?? ""), path).not.toContain("unsafe-inline");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["x-frame-options"], path).toBe("DENY");
  }
});

test("content security policy: hydrates the board with no violation and no console error", async ({ page }) => {
  const violations = await watchPolicy(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  await page.waitForLoadState("networkidle");
  expect(await violations()).toEqual([]);
});

test("content security policy: runs each boot script once and adds no script after hydration", async ({ page }) => {
  // The router's Script effect re-appends a script it cannot match by its nonce attribute, which a browser hides under
  // a header policy (getAttribute returns ""); that would run the boot scripts a second time. They are rendered by
  // hand, so the head keeps exactly the one copy the server wrote.
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  await page.waitForLoadState("networkidle");
  const copies = await page.evaluate(
    ({ appearance, alerts }) => {
      const inline = [...document.head.querySelectorAll("script:not([src])")].map((el) => el.textContent ?? "");
      return {
        appearance: inline.filter((text) => text.includes(appearance)).length,
        alerts: inline.filter((text) => text.includes(alerts)).length,
      };
    },
    { appearance: BACKGROUND_STORAGE_KEY, alerts: ALERTS_UNSUPPORTED_ATTRIBUTE },
  );
  expect(copies).toEqual({ appearance: 1, alerts: 1 });
});

test("content security policy: search, settings, Details and Refresh all work under it", async ({ page }) => {
  const violations = await watchPolicy(page);
  await page.goto("/");
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");

  // Search: React's handlers are attached, so typing narrows the board.
  const search = page
    .getByRole("searchbox", { name: "Search services" })
    .or(page.locator('[data-search-input="hero"]'));
  await search.fill("aws");
  await expect(page.locator("#service-aws")).toBeVisible();
  await expect(cards(page)).not.toHaveCount(SERVICES);
  await search.fill("");
  await expect(cards(page)).toHaveCount(SERVICES);

  // Refresh: a server function call, which is a POST the page makes with the policy's connect-src.
  const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
  const answered = page.waitForResponse(
    (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
  );
  await refresh.click();
  expect((await answered).ok()).toBe(true);
  await expect(refresh).toHaveAttribute("aria-busy", "false");

  // Details: the dialog of a Releases card.
  const details = page.locator("#service-mikrotik [data-release-details-trigger]");
  await details.scrollIntoViewIfNeeded();
  await details.click();
  await expect(page.locator("dialog[data-release-details]")).toBeVisible();
  await page
    .locator("dialog[data-release-details]")
    .getByRole("button", { name: /^Close details/ })
    .click();
  await expect(page.locator("dialog[data-release-details]")).toHaveCount(0);

  // Settings: a stored choice is applied by the inline boot script before the first paint, so on a reload the
  // attribute is there only if that script ran under the policy.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const reduceGlass = page.getByRole("switch", { name: "Reduce glass" });
  await reduceGlass.click();
  await expect(reduceGlass).toHaveAttribute("aria-checked", "true");
  // The page's own list dies with the document, so read it before the reload.
  expect(await violations()).toEqual([]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-transparency", "true");
  await expect(cards(page)).toHaveCount(SERVICES);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");

  expect(await violations()).toEqual([]);
});

test("content security policy: blocks an inline handler, which is what injected markup would use", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  // Markup written into the page, as an injection would: its inline handler has no nonce to carry. (A <script> made
  // by this evaluation would run, as a script made by trusted code does under 'strict-dynamic'; a handler never does.)
  const outcome = await page.evaluate(async () => {
    const reported = new Promise<string>((resolve) => {
      document.addEventListener("securitypolicyviolation", (event) => resolve(event.violatedDirective), { once: true });
    });
    const injected = window as unknown as { injected?: boolean };
    injected.injected = false;
    document.body.insertAdjacentHTML("beforeend", '<button id="injected" onclick="window.injected = true">x</button>');
    document.querySelector<HTMLButtonElement>("#injected")?.click();
    const directive = await Promise.race([
      reported,
      new Promise<string>((resolve) => setTimeout(() => resolve("none"), 2000)),
    ]);
    return { directive, ran: injected.injected };
  });
  expect(outcome.ran).toBe(false);
  expect(outcome.directive).toMatch(/^script-src/);
});
