import { afterEach, describe, expect, it, vi } from "vitest";
import { type CloudflareRequestContext, findCloudflareContext } from "./status/cloudflare-context";
import { createWorkerFetch } from "./worker-entry";

const VERSION = "0f6b5b4e-2d0c-4d38-9a6b-3c4f1e2a7b90";

function ctx() {
  const waiting: Promise<unknown>[] = [];
  return { waiting, waitUntil: vi.fn((promise: Promise<unknown>) => void waiting.push(promise)) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWorkerFetch", () => {
  it("adds the security headers a 500 from the handler lacks, and keeps the ones it set", async () => {
    const fetch = createWorkerFetch(
      async () => new Response("boom", { status: 500, headers: { "X-Frame-Options": "SAMEORIGIN" } }),
    );
    const response = await fetch(new Request("https://status.example.com/"), {}, ctx());

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Security-Policy")).toMatch(/script-src 'nonce-[^']+'/);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Strict-Transport-Security")).toMatch(/^max-age=/);
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    await expect(response.text()).resolves.toBe("boom");
  });

  it("answers a handler that throws with a plain, uncached 500 that has the headers, and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = createWorkerFetch(async () => {
      throw new Error("render failed");
    });
    const response = await fetch(
      new Request("https://status.example.com/api/status?x=1"),
      { CF_VERSION_METADATA: { id: VERSION }, ROBOTS: "noindex" },
      ctx(),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).not.toBeNull();
    expect(response.headers.get("X-Worker-Version")).toBe(VERSION);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    await expect(response.text()).resolves.toBe("Internal Server Error\n");
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0][0]))).toEqual({
      event: "unhandled_error",
      path: "/api/status",
      message: "render failed",
    });
  });

  it("keeps X-Worker-Version and adds noindex only where the deployment asks for it", async () => {
    const fetch = createWorkerFetch(async () => new Response("ok"));
    const request = () => new Request("https://status.example.com/");

    const production = await fetch(request(), { CF_VERSION_METADATA: { id: VERSION } }, ctx());
    expect(production.headers.get("X-Worker-Version")).toBe(VERSION);
    expect(production.headers.get("X-Robots-Tag")).toBeNull();

    const stage = await fetch(request(), { CF_VERSION_METADATA: { id: VERSION }, ROBOTS: "noindex" }, ctx());
    expect(stage.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const local = await fetch(request(), {}, ctx());
    expect(local.headers.get("X-Worker-Version")).toBeNull();
  });

  it("runs the handler with the env, the request's origin and the Worker's waitUntil", async () => {
    let seen: CloudflareRequestContext | undefined;
    const fetch = createWorkerFetch(async () => {
      seen = findCloudflareContext();
      seen?.waitUntil(Promise.resolve("kept"));
      return new Response("ok");
    });
    const env = { ROBOTS: "index" };
    const worker = ctx();
    await fetch(new Request("https://status.example.com:8443/path?q=1"), env, worker);

    expect(seen?.env).toBe(env);
    expect(seen?.origin).toBe("https://status.example.com:8443");
    expect(worker.waitUntil).toHaveBeenCalledOnce();
    await expect(worker.waiting[0]).resolves.toBe("kept");
    // Outside the request there is no context.
    expect(findCloudflareContext()).toBeUndefined();
  });
});
