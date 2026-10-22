import { describe, expect, it } from "vitest";
import { withValidator } from "./conditional";

const BODY = '{"generatedAt":"2026-09-27T00:00:00.000Z"}';
const ENDPOINT = "https://status.example.com/api/status.json";

function answer(body = BODY, init: ResponseInit = {}): Response {
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60", "X-Extra": "1" },
    ...init,
  });
}

function request(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(ENDPOINT, { method, headers });
}

describe("withValidator", () => {
  it("gives a 200 a weak ETag that stays the same for the same body", async () => {
    const first = await withValidator(request(), answer());
    const second = await withValidator(request(), answer());
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
    expect(second.headers.get("ETag")).toBe(etag);
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("application/json");
    expect(first.headers.get("X-Extra")).toBe("1");
    await expect(first.text()).resolves.toBe(BODY);
  });

  it("gives a different body a different ETag", async () => {
    const one = await withValidator(request(), answer());
    const other = await withValidator(request(), answer(`${BODY} `));
    expect(other.headers.get("ETag")).not.toBe(one.headers.get("ETag"));
  });

  it("answers 304 with no body to a matching If-None-Match, a strong form of it, *, or a list holding it", async () => {
    const etag = (await withValidator(request(), answer())).headers.get("ETag") ?? "";
    const strong = etag.slice(2);
    for (const value of [etag, strong, "*", `"other", ${etag}`, `W/"x",${strong}`]) {
      const response = await withValidator(request({ "If-None-Match": value }), answer());
      expect(response.status, value).toBe(304);
      expect(response.body, value).toBeNull();
      expect(response.headers.get("ETag")).toBe(etag);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
      expect(response.headers.get("X-Extra")).toBe("1");
      expect(response.headers.has("Content-Type")).toBe(false);
      expect(response.headers.has("Content-Length")).toBe(false);
    }
  });

  it("answers 200 with the body to an If-None-Match that does not match", async () => {
    const response = await withValidator(request({ "If-None-Match": 'W/"0000000000000000", "abc"' }), answer());
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toMatch(/^W\//);
    await expect(response.text()).resolves.toBe(BODY);
  });

  it("leaves a response other than 200 untouched", async () => {
    const original = answer("busy", { status: 503 });
    const response = await withValidator(request({ "If-None-Match": "*" }), original);
    expect(response).toBe(original);
    expect(response.headers.has("ETag")).toBe(false);
  });

  it("handles HEAD as GET", async () => {
    const etag = (await withValidator(request(), answer())).headers.get("ETag");
    const head = await withValidator(request({}, "HEAD"), answer());
    expect(head.status).toBe(200);
    expect(head.headers.get("ETag")).toBe(etag);
    const notModified = await withValidator(request({ "If-None-Match": etag ?? "" }, "HEAD"), answer());
    expect(notModified.status).toBe(304);
  });

  it("leaves other methods alone", async () => {
    const original = answer();
    expect(await withValidator(request({}, "POST"), original)).toBe(original);
  });
});
