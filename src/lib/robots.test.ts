import { describe, expect, it } from "vitest";
import { isNoindex, robotsTxt, withNoindex } from "./robots";

describe("robots", () => {
  it("only the exact noindex value turns indexing off", () => {
    expect(isNoindex("noindex")).toBe(true);
    expect(isNoindex(undefined)).toBe(false);
    expect(isNoindex("")).toBe(false);
    expect(isNoindex("NOINDEX")).toBe(false);
  });

  it("robots.txt disallows everything for a noindex deployment and allows everything otherwise", () => {
    expect(robotsTxt(true)).toBe("User-agent: *\nDisallow: /\n");
    expect(robotsTxt(false)).toBe("User-agent: *\nAllow: /\n");
  });

  it("adds X-Robots-Tag without dropping the response's status, headers or body", async () => {
    const original = new Response("board", { status: 503, headers: { "Content-Type": "text/plain", "Retry-After": "60" } });
    const tagged = withNoindex(original);
    expect(tagged.status).toBe(503);
    expect(tagged.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(tagged.headers.get("Retry-After")).toBe("60");
    await expect(tagged.text()).resolves.toBe("board");
  });
});
