import { describe, expect, it } from "vitest";
import { securityHeaders, withSecurityHeaders } from "./security-headers";

describe("securityHeaders", () => {
  it("sets a policy that allows only this origin and forbids framing", () => {
    const csp = securityHeaders({ dev: false })["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it("pins HTTPS for a year on the host and its subdomains, without asking to be preloaded", () => {
    const hsts = securityHeaders({ dev: false })["Strict-Transport-Security"];
    expect(hsts).toBe("max-age=31536000; includeSubDomains");
    expect(hsts).not.toContain("preload");
    expect(securityHeaders({ dev: true })["Strict-Transport-Security"]).toBe(hsts);
  });

  it("takes another Strict-Transport-Security value, or none, for a server that decides it itself", () => {
    expect(securityHeaders({ dev: false, hsts: "max-age=60" })["Strict-Transport-Security"]).toBe("max-age=60");
    expect(securityHeaders({ dev: false, hsts: false })).not.toHaveProperty("Strict-Transport-Security");
  });

  it("keeps inline scripts and styles, which hydration needs, and nothing broader", () => {
    const csp = securityHeaders({ dev: false })["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self' 'unsafe-inline';");
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
  });

  it("does not deny the motion sensors Tilt lighting reads", () => {
    const policy = securityHeaders({ dev: false })["Permissions-Policy"] ?? "";
    for (const feature of ["accelerometer", "gyroscope", "magnetometer"]) expect(policy).not.toContain(feature);
  });

  it("leaves the policy out in development, where Vite injects its client", () => {
    expect(securityHeaders({ dev: true })).not.toHaveProperty("Content-Security-Policy");
    expect(securityHeaders({ dev: true })["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("names only Permissions-Policy features every engine knows", () => {
    const policy = securityHeaders({ dev: false })["Permissions-Policy"];
    // usb is Chromium-only, and Safari logs a warning for an unknown feature.
    expect(policy).not.toContain("usb");
    expect(policy).toBe("camera=(), microphone=(), geolocation=(), payment=()");
  });
});

describe("withSecurityHeaders", () => {
  it("adds the headers and keeps the body, status and existing headers", async () => {
    const original = new Response("ok\n", {
      status: 201,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
    const response = withSecurityHeaders(original, { dev: false });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok\n");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("does not replace a header the route set itself", () => {
    const original = new Response(null, { headers: { "Referrer-Policy": "no-referrer" } });
    expect(withSecurityHeaders(original, { dev: false }).headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("works on a response whose headers are immutable, as fetch returns them", () => {
    const original = Response.redirect("https://example.com/", 302);
    const response = withSecurityHeaders(original, { dev: false });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Location")).toBe("https://example.com/");
  });
});
