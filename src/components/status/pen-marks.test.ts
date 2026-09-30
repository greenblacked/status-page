import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LOOP_BOX, LOOP_SEEDS, marks, pen, render, rng, UNDERLINE_BOX } from "../../../scripts/pen-paths.mjs";
import { HandNote } from "./hand-note";
import { LOOP_HANDS, PenLoop, PenUnderline } from "./pen";
import { LOOP_PATHS, LOOP_VIEW_BOX, UNDERLINE_PATH, UNDERLINE_VIEW_BOX } from "./pen-marks";

/** Every x, y pair in a path made of M, L and z. */
function points(path: string): [number, number][] {
  return [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("pen marks are constants", () => {
  it("are exactly what scripts/pen-paths.mjs draws, so nothing is summed at render time", () => {
    const committed = readFileSync(new URL("./pen-marks.ts", import.meta.url), "utf8");
    // The committed file is run through the formatter; the words and numbers must match.
    expect(committed.replace(/\s+/g, "")).toBe(render().replace(/\s+/g, ""));
    const drawn = marks();
    expect(UNDERLINE_PATH).toBe(drawn.underline);
    expect([...LOOP_PATHS]).toEqual(drawn.loops);
  });

  it("draw the same thing every time", () => {
    expect(marks()).toEqual(marks());
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(rng(7)()).not.toBe(rng(8)());
  });

  it("are closed outlines inside their boxes", () => {
    for (const path of [UNDERLINE_PATH, ...LOOP_PATHS]) {
      expect(path).toMatch(/^M[-\d. L]+z$/);
      expect(points(path).length).toBeGreaterThan(40);
    }
    for (const [x, y] of points(UNDERLINE_PATH)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(UNDERLINE_BOX.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(UNDERLINE_BOX.height);
    }
    for (const path of LOOP_PATHS) {
      for (const [x, y] of points(path)) {
        expect(x).toBeGreaterThanOrEqual(LOOP_BOX.min);
        expect(x).toBeLessThanOrEqual(LOOP_BOX.min + LOOP_BOX.size);
        expect(y).toBeGreaterThanOrEqual(LOOP_BOX.min);
        expect(y).toBeLessThanOrEqual(LOOP_BOX.min + LOOP_BOX.size);
      }
    }
  });

  it("come in three hands that are not the same stroke", () => {
    expect(LOOP_SEEDS).toHaveLength(3);
    expect(LOOP_HANDS).toBe(3);
    expect(new Set(LOOP_PATHS).size).toBe(3);
  });

  it("taper to a point at both ends and swell in the middle", () => {
    const line: [number, number][] = Array.from({ length: 41 }, (_, i) => [i, 0]);
    const outline = points(pen(line, 2, 0.2, 0.2));
    const top = outline.slice(0, 41);
    const halfWidth = (i: number) => Math.abs(top[i][1]);
    expect(halfWidth(0)).toBeCloseTo(0.4, 1);
    expect(halfWidth(20)).toBeCloseTo(2, 1);
    expect(halfWidth(40)).toBeCloseTo(0.4, 1);
  });
});

describe("PenUnderline", () => {
  const html = renderToStaticMarkup(createElement(PenUnderline, null, "Two"));

  it("wraps the word and draws under it, hidden from a screen reader", () => {
    expect(html).toContain("Two");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(`viewBox="${UNDERLINE_VIEW_BOX}"`);
    expect(html).toContain(`d="${UNDERLINE_PATH}"`);
    expect(html).toContain("pen-underline");
    expect(html).toContain('preserveAspectRatio="none"');
  });

  it("prints the same markup twice: nothing in it depends on the machine", () => {
    expect(renderToStaticMarkup(createElement(PenUnderline, null, "Two"))).toBe(html);
  });
});

describe("PenLoop", () => {
  it("is a 38px box round a 22px glyph, hidden from a screen reader", () => {
    const html = renderToStaticMarkup(createElement(PenLoop));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(`viewBox="${LOOP_VIEW_BOX}"`);
    expect(html).toContain("size-[38px]");
    expect(html).toContain("pen-loop");
    expect(html).toContain(`d="${LOOP_PATHS[0]}"`);
  });

  it("takes a hand by seed", () => {
    for (const seed of [0, 1, 2] as const) {
      expect(renderToStaticMarkup(createElement(PenLoop, { seed }))).toContain(`d="${LOOP_PATHS[seed]}"`);
    }
  });
});

describe("HandNote", () => {
  it("is aria-hidden, tilted, in the hand face", () => {
    const html = renderToStaticMarkup(
      createElement(HandNote, { className: "mt-2" } as { className: string; children: string }, "all quiet"),
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("all quiet");
    expect(html).toContain("font-hand");
    expect(html).toContain("-rotate-2");
    expect(html).toContain("mt-2");
  });
});
