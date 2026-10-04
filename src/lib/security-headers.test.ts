import { describe, expect, it } from "vitest";
import { createNonce, nonceForRequest, securityHeaders, withSecurityHeaders } from "./security-headers";

const NONCE = "bm9uY2UtZm9yLXRlc3Rz";

describe("securityHeaders", () => {
  it("sets a policy that allows only this origin and forbids framing", () => {
    const csp = securityHeaders({ dev: false, nonce: NONCE })["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it("pins HTTPS for a year on the host and its subdomains, without asking to be preloaded", () => {
    const hsts = securityHeaders({ dev: false, nonce: NONCE })["Strict-Transport-Security"];
    expect(hsts).toBe("max-age=31536000; includeSubDomains");
    expect(hsts).not.toContain("preload");
    expect(securityHeaders({ dev: true, nonce: NONCE })["Strict-Transport-Security"]).toBe(hsts);
  });

  it("takes another Strict-Transport-Security value, or none, for a server that decides it for itself", () => {
    expect(securityHeaders({ dev: false, nonce: NONCE, hsts: "max-age=60" })["Strict-Transport-Security"]).toBe(
      "max-age=60",
    );
    expect(securityHeaders({ dev: false, nonce: NONCE, hsts: false })).not.toHaveProperty("Strict-Transport-Security");
  });

  it("runs scripts only by nonce, with 'self' as the old-browser fallback and no 'unsafe-inline'", () => {
    const csp = securityHeaders({ dev: false, nonce: NONCE })["Content-Security-Policy"] ?? "";
    const scriptSrc = csp.split("; ").find((directive) => directive.startsWith("script-src "));
    expect(scriptSrc).toBe(`script-src 'nonce-${NONCE}' 'strict-dynamic' 'self'`);
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("keeps inline styles, which React's style attributes need, and nothing broader", () => {
    const csp = securityHeaders({ dev: false, nonce: NONCE })["Content-Security-Policy"];
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
  });

  it("does not deny the motion sensors Tilt lighting reads", () => {
    const policy = securityHeaders({ dev: false, nonce: NONCE })["Permissions-Policy"] ?? "";
    for (const feature of ["accelerometer", "gyroscope", "magnetometer"]) expect(policy).not.toContain(feature);
  });

  it("leaves the policy out in development, where Vite injects its client", () => {
    expect(securityHeaders({ dev: true, nonce: NONCE })).not.toHaveProperty("Content-Security-Policy");
    expect(securityHeaders({ dev: true, nonce: NONCE })["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("names only Permissions-Policy features every engine knows", () => {
    const policy = securityHeaders({ dev: false, nonce: NONCE })["Permissions-Policy"];
    // usb is Chromium-only, and Safari logs a warning for an unknown feature.
    expect(policy).not.toContain("usb");
    expect(policy).toBe("camera=(), microphone=(), geolocation=(), payment=()");
  });
});

describe("nonces", () => {
  it("are 128 random bits in base64, different every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("belong to one request: asked twice they agree, and two requests never share one", () => {
    const first = new Request("https://example.com/");
    const second = new Request("https://example.com/");
    expect(nonceForRequest(first)).toBe(nonceForRequest(first));
    expect(nonceForRequest(first)).not.toBe(nonceForRequest(second));
  });

  it("show up in a fresh Content-Security-Policy on each response", () => {
    const policies = [new Request("https://example.com/"), new Request("https://example.com/")].map((request) => {
      const response = withSecurityHeaders(new Response("ok"), { dev: false, nonce: nonceForRequest(request) });
      return { nonce: nonceForRequest(request), csp: response.headers.get("Content-Security-Policy") ?? "" };
    });
    for (const { nonce, csp } of policies) expect(csp).toContain(`script-src 'nonce-${nonce}' 'strict-dynamic'`);
    expect(policies[0]?.csp).not.toBe(policies[1]?.csp);
  });
});

describe("withSecurityHeaders", () => {
  it("adds the headers and keeps the body, status and existing headers", async () => {
    const original = new Response("ok\n", {
      status: 201,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
    const response = withSecurityHeaders(original, { dev: false, nonce: NONCE });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok\n");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("does not replace a header the route set itself", () => {
    const original = new Response(null, { headers: { "Referrer-Policy": "no-referrer" } });
    expect(withSecurityHeaders(original, { dev: false, nonce: NONCE }).headers.get("Referrer-Policy")).toBe(
      "no-referrer",
    );
  });

  it("works on a response whose headers are immutable, as fetch returns them", () => {
    const original = Response.redirect("https://example.com/", 302);
    const response = withSecurityHeaders(original, { dev: false, nonce: NONCE });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Location")).toBe("https://example.com/");
  });
});
