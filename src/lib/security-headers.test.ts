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

  it("leaves the policy out in development, where Vite injects its client", () => {
    expect(securityHeaders({ dev: true })).not.toHaveProperty("Content-Security-Policy");
    expect(securityHeaders({ dev: true })["X-Content-Type-Options"]).toBe("nosniff");
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
