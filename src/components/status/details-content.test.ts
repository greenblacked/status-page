import { afterEach, describe, expect, it, vi } from "vitest";
import { supportsDetailsContent } from "./details-content";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supportsDetailsContent", () => {
  it("asks the browser about the pseudo-element itself", () => {
    const supports = vi.fn(() => true);
    vi.stubGlobal("CSS", { supports });
    expect(supportsDetailsContent()).toBe(true);
    expect(supports).toHaveBeenCalledWith("selector(::details-content)");
  });

  it("is false where the browser does not know it, has no CSS.supports, or throws", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    expect(supportsDetailsContent()).toBe(false);
    vi.stubGlobal("CSS", {});
    expect(supportsDetailsContent()).toBe(false);
    vi.stubGlobal("CSS", {
      supports: () => {
        throw new Error("no selector()");
      },
    });
    expect(supportsDetailsContent()).toBe(false);
  });

  it("is false where there is no CSS global at all", () => {
    vi.stubGlobal("CSS", undefined);
    expect(supportsDetailsContent()).toBe(false);
  });
});
