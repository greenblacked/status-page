import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/** The dark: variant as src/styles.css defines it, compiled with a bare `underline` utility to hang it on. */
async function darkUnderline(): Promise<string> {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const variant = /@custom-variant dark \{[\s\S]*?\n\}\n/.exec(css);
  expect(variant, "@custom-variant dark in styles.css").not.toBeNull();
  const compiler = await compile(`${variant?.[0]}\n@tailwind utilities;`);
  return compiler.build(["dark:underline"]);
}

describe("the dark: variant", () => {
  it("follows the effective theme, not the system's setting alone", async () => {
    const built = await darkUnderline();
    // Night on <html>, on <html> itself and on everything under it.
    expect(built).toContain(':where(:root[data-theme="night"], :root[data-theme="night"] *)');
    // The system's setting counts only while <html> has no data-theme.
    expect(built).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*:where\(:root:not\(\[data-theme\]\), :root:not\(\[data-theme\]\) \*\)/,
    );
  });

  it("has no bare prefers-color-scheme rule that a chosen day theme could not override", async () => {
    const built = await darkUnderline();
    // Every media query that is there is guarded by "no data-theme" inside it.
    const media = built.split("@media").slice(1);
    expect(media.length).toBeGreaterThan(0);
    for (const block of media) expect(block).toContain(":not([data-theme])");
  });
});

describe("the paper grain on Quiet", () => {
  const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const background = readFileSync(new URL("./background.css", import.meta.url), "utf8");
  /** The text from `start` to the first closing brace in column 0 (or 2 for a block nested one level). */
  const block = (source: string, start: string, close = "\n}\n"): string => {
    const at = source.indexOf(start);
    expect(at, `${start} in the stylesheet`).toBeGreaterThanOrEqual(0);
    return source.slice(at, source.indexOf(close, at));
  };

  it("is one token holding a day tile and a night tile of our own feTurbulence noise", () => {
    const token =
      /--paper-grain: light-dark\(url\("data:image\/svg\+xml,([^"]+)"\), url\("data:image\/svg\+xml,([^"]+)"\)\);/.exec(
        styles,
      );
    expect(token, "--paper-grain: light-dark(url(day), url(night))").not.toBeNull();
    for (const tile of [token?.[1] ?? "", token?.[2] ?? ""]) {
      const svg = decodeURIComponent(tile);
      expect(svg).toContain("<feTurbulence");
      expect(svg).toContain("stitchTiles='stitch'");
      // Our own markup only: nothing fetched, nothing scripted, nothing that moves.
      expect(svg).not.toMatch(/<(script|image|animate|set|foreignObject)|href=|url\((?!#)/i);
      expect(svg.replace("http://www.w3.org/2000/svg", "")).not.toContain("http");
    }
    // The night tile is the fainter one: a smaller alpha slope in its colour matrix.
    const slope = (tile: string) => Number(/ ([\d.]+) 0 0 0 -[\d.]+'/.exec(decodeURIComponent(tile))?.[1]);
    expect(slope(token?.[2] ?? "")).toBeLessThan(slope(token?.[1] ?? ""));
  });

  it("is painted as a tiled background on the root and the stage, never fixed or animated", () => {
    for (const selector of ["  html {", ".liquid-stage {"]) {
      const rule = block(styles, selector, "}\n");
      expect(rule).toContain("background-image: var(--paper-grain);");
      expect(rule).toContain("background-size: 160px 160px;");
      expect(rule).not.toMatch(/background-attachment|animation|transition|mix-blend-mode|will-change/);
    }
  });

  it("is switched off under Increase Contrast, Reduce glass, forced colours and print", () => {
    for (const start of [
      "@media (prefers-contrast: more) {\n  :root {\n    --color-hairline",
      "@variant reduce-glass {",
      "@media (forced-colors: active) {\n  /* The phone bar",
      "@media print {",
    ]) {
      expect(block(styles, start), start).toContain("--paper-grain: none;");
    }
  });

  it("is off on Glass and Full, which have the aurora's own grain", () => {
    expect(block(background, ':root:is([data-background="glass"], [data-background="full"]) {', "}\n")).toContain(
      "--paper-grain: none;",
    );
    // The aurora's grain is not the paper's: it keeps its own opacity token.
    expect(background).toContain("opacity: var(--grain-opacity);");
  });
});
