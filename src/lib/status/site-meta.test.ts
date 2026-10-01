import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_NAME, CATALOG } from "./catalog";
import { CANONICAL_URL, OG_IMAGE, SITE_DESCRIPTION } from "./site-meta";

const manifest = JSON.parse(readFileSync(new URL("../../../public/manifest.webmanifest", import.meta.url), "utf8")) as {
  name: string;
  short_name: string;
  description: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; purpose?: string }[];
};

describe("site meta", () => {
  it("describes the site in the owner's voice, counting the rest from the catalog", () => {
    expect(CATALOG).toHaveLength(16);
    expect(SITE_DESCRIPTION).toBe(
      "Is it them or is it me? Google Cloud, AWS, Steam, ChatGPT, Claude and eleven more, read from their own status pages.",
    );
  });

  it("points the preview image and the canonical link at the deployed origin, absolutely", () => {
    expect(OG_IMAGE.url).toBe("https://status.szolotov.com/og.jpg");
    expect(OG_IMAGE).toMatchObject({ width: 1200, height: 630 });
    expect(OG_IMAGE.alt).toContain(APP_NAME);
    expect(CANONICAL_URL).toBe("https://status.szolotov.com/");
  });
});

describe("the web app manifest", () => {
  it("carries the same name and a short description", () => {
    expect(manifest.name).toBe(APP_NAME);
    expect(manifest.short_name).toBe(APP_NAME);
    expect(manifest.description).toBe("Sixteen status pages on one page.");
  });

  it("uses the dark pair, which is what a launch screen shows before the page paints", () => {
    expect(manifest.background_color).toBe("#000000");
    expect(manifest.theme_color).toBe("#000000");
  });

  it("has a maskable icon of its own, drawn for the safe zone, beside the ordinary 512", () => {
    const any512 = manifest.icons.find((icon) => icon.sizes === "512x512" && icon.purpose === "any");
    const maskable = manifest.icons.find((icon) => icon.purpose === "maskable");
    expect(any512?.src).toBe("/icon-512.png");
    expect(maskable?.src).toBe("/icon-512-maskable.png");
    expect(maskable?.src).not.toBe(any512?.src);
  });
});
