import { describe, expect, it } from "vitest";
import { methodGuard } from "./request-methods";

const ALLOW = "GET, HEAD, OPTIONS";

function request(method: string, path: string): Request {
  return new Request(`https://status.example.com${path}`, { method });
}

describe("methodGuard", () => {
  it("answers a POST to a page with 405, Allow and a plain-text body", async () => {
    const response = methodGuard(request("POST", "/"), "router");
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe(ALLOW);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("Content-Type")).toMatch(/^text\/plain/);
    await expect(response?.text()).resolves.toBe("Method Not Allowed\n");
  });

  it.each(["PUT", "DELETE", "PATCH", "PROPFIND"])("answers %s on an API path with 405", (method) => {
    const response = methodGuard(request(method, "/api/status.json"), "router");
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe(ALLOW);
  });

  it.each(["/api/status.json", "/api/badge/gcp", "/feed.xml", "/metrics", "/healthz", "/readyz"])(
    "answers a preflight to the public %s with 204 and CORS headers",
    async (path) => {
      const response = methodGuard(request("OPTIONS", path), "router");
      expect(response?.status).toBe(204);
      expect(response?.headers.get("Allow")).toBe(ALLOW);
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response?.headers.get("Access-Control-Allow-Methods")).toBe(ALLOW);
      expect(response?.headers.get("Access-Control-Allow-Headers")).toBe("*");
      expect(response?.headers.get("Access-Control-Max-Age")).toBe("86400");
      await expect(response?.text()).resolves.toBe("");
    },
  );

  it.each(["/", "/apiary", "/feed.xml.bak", "/metrics/x"])("answers OPTIONS %s with 204 and no CORS", (path) => {
    const response = methodGuard(request("OPTIONS", path), "router");
    expect(response?.status).toBe(204);
    expect(response?.headers.get("Allow")).toBe(ALLOW);
    expect(response?.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(response?.headers.has("Access-Control-Allow-Methods")).toBe(false);
  });

  it.each(["GET", "HEAD"])("lets %s through", (method) => {
    expect(methodGuard(request(method, "/"), "router")).toBeUndefined();
    expect(methodGuard(request(method, "/api/status.json"), "router")).toBeUndefined();
  });

  it("leaves server function calls to the framework and its CSRF check", () => {
    expect(methodGuard(request("POST", "/_serverFn/abc"), "serverFn")).toBeUndefined();
    expect(methodGuard(request("GET", "/_serverFn/abc"), "serverFn")).toBeUndefined();
    expect(methodGuard(request("OPTIONS", "/_serverFn/abc"), "serverFn")).toBeUndefined();
  });

  it("falls back to the server function path when the handler type is not known", () => {
    expect(methodGuard(request("POST", "/_serverFn/abc"))).toBeUndefined();
    expect(methodGuard(request("POST", "/"))?.status).toBe(405);
  });
});
