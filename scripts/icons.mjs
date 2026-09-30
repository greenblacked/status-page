// Draws the site's icons and its link-preview image, and writes them to public/:
//
//   favicon.svg               the mark on paper (black in a dark tab), vector
//   apple-touch-icon.png      180 x 180, square: iOS applies its own corner mask
//   icon-192.png, icon-512.png    the "any" icons
//   icon-512-maskable.png     the mark inside the central 60%, for adaptive masks
//   og.jpg                    1200 x 630, from docs/og-image.html
//
//   node scripts/icons.mjs
//
// The mark is the board's own operational glyph (an outline ring and a check, see
// src/components/status/status-glyph.tsx), in the operational green on paper. The
// PNGs and the JPEG are screenshots of SVG and HTML made with Chromium through
// Playwright, so the fonts come from public/fonts and nothing is fetched. Point
// PLAYWRIGHT_CHROMIUM_EXECUTABLE at a browser Playwright did not download, as
// playwright.config.ts does.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const pub = (name) => `${root}public/${name}`;

const PAPER = "#f4f1eb";
const BLACK = "#000000";
const OK_LIGHT = "#1b7048";
const OK_DARK = "#5bc98a";

/** The glyph's ring and check in its own 24 x 24 box, drawn a little sturdier than on the page so it reads at 16px. */
const glyph = (color) =>
  `<circle cx="12" cy="12" r="9.4" fill="none" stroke="${color}" stroke-width="2.3"/>` +
  `<path d="M7.7 12.5l3 2.9 5.7-6.4" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;

/** The favicon: a rounded paper tile, black in a dark tab, with the mark centred. */
function favicon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <title>Status</title>
  <style>
    .paper { fill: ${PAPER}; }
    .ring, .tick { stroke: ${OK_LIGHT}; }
    @media (prefers-color-scheme: dark) {
      .paper { fill: ${BLACK}; }
      .ring, .tick { stroke: ${OK_DARK}; }
    }
  </style>
  <rect class="paper" width="32" height="32" rx="8"/>
  <g transform="translate(2.4 2.4) scale(1.1)">
    <circle class="ring" cx="12" cy="12" r="9.4" fill="none" stroke-width="2.3"/>
    <path class="tick" d="M7.7 12.5l3 2.9 5.7-6.4" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`;
}

/** A full-bleed paper square with the mark's ring taking `fraction` of its width. */
function tile(size, fraction) {
  // The ring's outer diameter is 2 * 9.4 + 2.3 = 21.1 units of the 24-unit glyph box.
  const glyphSize = (size * fraction * 24) / 21.1;
  const offset = (size - glyphSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${PAPER}"/>
  <g transform="translate(${offset} ${offset}) scale(${glyphSize / 24})">${glyph(OK_LIGHT)}</g>
</svg>`;
}

/** The pen underline's path, read from the constants the page draws it from. */
function underlinePath() {
  const source = readFileSync(`${root}src/components/status/pen-marks.ts`, "utf8");
  const match = /UNDERLINE_PATH =\s*"([^"]+)"/.exec(source);
  if (!match) throw new Error("UNDERLINE_PATH not found in src/components/status/pen-marks.ts");
  return match[1];
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
try {
  writeFileSync(pub("favicon.svg"), favicon());

  const icons = [
    ["apple-touch-icon.png", 180, 0.68],
    ["icon-192.png", 192, 0.68],
    ["icon-512.png", 512, 0.68],
    // An adaptive mask keeps the middle 80% circle; the mark stays inside the central 60%.
    ["icon-512-maskable.png", 512, 0.6],
  ];
  for (const [name, size, fraction] of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body style="margin:0;background:${PAPER}">${tile(size, fraction)}</body>`);
    await page.screenshot({ path: pub(name), type: "png" });
    await page.close();
  }

  // The preview image is a page of its own, so its fonts load from public/fonts by relative URL.
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(`${root}docs/og-image.html`).href);
  // The pen underline is drawn from the same constants as the page's, not from a copy of them.
  await page.evaluate((d) => document.querySelector("#pen path")?.setAttribute("d", d), underlinePath());
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: pub("og.jpg"), type: "jpeg", quality: 88 });
  await page.close();
} finally {
  await browser.close();
}
console.log("wrote favicon.svg, apple-touch-icon.png, icon-192.png, icon-512.png, icon-512-maskable.png, og.jpg");
