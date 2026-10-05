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
