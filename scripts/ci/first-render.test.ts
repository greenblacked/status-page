import { describe, expect, it } from "vitest";
import {
  FIRST_RENDER_AT_ENV,
  firstRenderCarriesReleaseLines,
  RELEASE_LINES_GUARANTEED_MS,
} from "../../e2e/support/first-render";
import { RELEASE_FEED_TTL_MS } from "../../src/lib/status/release-feeds.server";

// The e2e first-render test asks for the release lines only while the canned feeds are younger than the feed cache
// (e2e/support/first-render.ts): after that a board build leaves them out until they are read again.

describe("firstRenderCarriesReleaseLines", () => {
  it("is held to a time under the feed cache's, so a board cached and served stale still has the lines", () => {
    expect(RELEASE_LINES_GUARANTEED_MS).toBeLessThan(RELEASE_FEED_TTL_MS - (45 + 75) * 1000);
  });

  it("asks for the lines until the guarantee runs out, and not after", () => {
    const at = 1_000_000;
    const env = { [FIRST_RENDER_AT_ENV]: String(at) };
    expect(firstRenderCarriesReleaseLines(env, at)).toBe(true);
    expect(firstRenderCarriesReleaseLines(env, at + RELEASE_LINES_GUARANTEED_MS - 1)).toBe(true);
    expect(firstRenderCarriesReleaseLines(env, at + RELEASE_LINES_GUARANTEED_MS)).toBe(false);
  });

  it("asks for them when the setup left no time (a spec run on its own)", () => {
    expect(firstRenderCarriesReleaseLines({}, Date.now())).toBe(true);
    expect(firstRenderCarriesReleaseLines({ [FIRST_RENDER_AT_ENV]: "soon" }, Date.now())).toBe(true);
  });
});
