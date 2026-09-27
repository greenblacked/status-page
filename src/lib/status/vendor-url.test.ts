import { describe, expect, it } from "vitest";
import { hostOf, vendorUrl } from "./vendor-url";

const FALLBACK = "https://status.example.com/";

describe("vendorUrl", () => {
  it("keeps an http(s) link", () => {
    expect(vendorUrl("https://status.example.com/incidents/1", FALLBACK)).toBe("https://status.example.com/incidents/1");
    expect(vendorUrl("http://status.example.com/incidents/1", FALLBACK)).toBe("http://status.example.com/incidents/1");
  });

  it("resolves a relative link against the fallback, with or without a leading slash", () => {
    expect(vendorUrl("incidents/abc", FALLBACK)).toBe("https://status.example.com/incidents/abc");
    expect(vendorUrl("/incidents/def", FALLBACK)).toBe("https://status.example.com/incidents/def");
    expect(vendorUrl("incidents/x", "https://status.play.google.com/summary")).toBe(
      "https://status.play.google.com/incidents/x",
    );
  });

  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    [" javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vbscript:msgbox(1)"],
    ["file:///etc/passwd"],
    ["ftp://status.example.com/x"],
    ["https://user:secret@status.example.com/"],
    ["http://[::1"],
  ])("falls back for %s", (raw) => {
    expect(vendorUrl(raw, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for a missing or blank link", () => {
    expect(vendorUrl(undefined, FALLBACK)).toBe(FALLBACK);
    expect(vendorUrl(null, FALLBACK)).toBe(FALLBACK);
    expect(vendorUrl("   ", FALLBACK)).toBe(FALLBACK);
  });

  it("with allowed hosts, keeps those hosts and their subdomains only", () => {
    const allowed = ["example.com", "stspg.io"];
    expect(vendorUrl("https://stspg.io/abc", FALLBACK, allowed)).toBe("https://stspg.io/abc");
    expect(vendorUrl("https://status.example.com/x", FALLBACK, allowed)).toBe("https://status.example.com/x");
    expect(vendorUrl("https://evil.test/x", FALLBACK, allowed)).toBe(FALLBACK);
    // Suffix tricks are not subdomains.
    expect(vendorUrl("https://notexample.com/x", FALLBACK, allowed)).toBe(FALLBACK);
    expect(vendorUrl("https://example.com.evil.test/x", FALLBACK, allowed)).toBe(FALLBACK);
    expect(vendorUrl("https://evil.test/?u=https://example.com", FALLBACK, allowed)).toBe(FALLBACK);
  });
});

describe("hostOf", () => {
  it("returns the hostname without port or path", () => {
    expect(hostOf("https://status.claude.com/history")).toBe("status.claude.com");
  });
});
