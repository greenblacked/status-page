import { describe, expect, it } from "vitest";
import { upstreamUrl } from "./upstream-url.ts";

const ORIGIN = "http://127.0.0.1:4173";

describe("upstreamUrl", () => {
  it("keeps the path and the query on the fixed origin", () => {
    expect(upstreamUrl(ORIGIN, "/assets/x.woff2?v=1")).toBe(`${ORIGIN}/assets/x.woff2?v=1`);
    expect(upstreamUrl(ORIGIN, "/")).toBe(`${ORIGIN}/`);
  });

  it("rejects an absolute URL", () => {
    expect(upstreamUrl(ORIGIN, "http://evil.example/")).toBeNull();
    expect(upstreamUrl(ORIGIN, "https://evil.example/x")).toBeNull();
  });

  it("rejects a protocol-relative URL", () => {
    expect(upstreamUrl(ORIGIN, "//evil.example/")).toBeNull();
  });

  it("rejects a backslash, which URL parsers read as a slash", () => {
    expect(upstreamUrl(ORIGIN, "/\\evil")).toBeNull();
    expect(upstreamUrl(ORIGIN, "/assets\\..\\x")).toBeNull();
  });

  it("rejects anything that is not a path, and whitespace or control characters", () => {
    expect(upstreamUrl(ORIGIN, "")).toBeNull();
    expect(upstreamUrl(ORIGIN, "assets/x")).toBeNull();
    expect(upstreamUrl(ORIGIN, "*")).toBeNull();
    expect(upstreamUrl(ORIGIN, "/a b")).toBeNull();
    expect(upstreamUrl(ORIGIN, "/a\r\nb")).toBeNull();
  });

  it("never lets an at-sign or other path text change the host", () => {
    const url = upstreamUrl(ORIGIN, "/@evil.example/x");
    expect(url).toBe(`${ORIGIN}/@evil.example/x`);
    expect(new URL(url as string).host).toBe("127.0.0.1:4173");
  });
});
