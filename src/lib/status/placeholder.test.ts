import { describe, expect, it } from "vitest";
import { canvasFont, type InputTextStyle, placeholderFits, placeholderWidth } from "./placeholder";

const style: InputTextStyle = {
  fontStyle: "normal",
  fontWeight: "400",
  fontSize: "14px",
  fontFamily: "ui-sans-serif, system-ui",
  paddingLeft: "40px",
  paddingRight: "12px",
};

describe("canvasFont", () => {
  it("joins the style, weight, size and family the way the canvas shorthand reads them", () => {
    expect(canvasFont(style)).toBe("normal 400 14px ui-sans-serif, system-ui");
    expect(
      canvasFont({ ...style, fontStyle: "italic", fontWeight: "600", fontSize: "16px", fontFamily: "Inter" }),
    ).toBe("italic 600 16px Inter");
  });
});

describe("placeholderWidth", () => {
  it("adds both paddings to the drawn text", () => {
    expect(placeholderWidth(200, style)).toBe(252);
  });

  it("takes fractional paddings", () => {
    expect(placeholderWidth(100.5, { paddingLeft: "10.25px", paddingRight: "0.25px" })).toBe(111);
  });

  it("counts a padding it cannot read as nothing", () => {
    expect(placeholderWidth(200, { paddingLeft: "", paddingRight: "auto" })).toBe(200);
  });
});

describe("placeholderFits", () => {
  it("fits in a dock wider than the text and its paddings", () => {
    expect(placeholderFits(300, 200, style)).toBe(true);
  });

  it("fits a dock exactly as wide as it needs", () => {
    expect(placeholderFits(252, 200, style)).toBe(true);
  });

  it("does not fit a dock one pixel short", () => {
    expect(placeholderFits(251, 200, style)).toBe(false);
  });

  it("does not fit a collapsed dock", () => {
    expect(placeholderFits(0, 200, style)).toBe(false);
  });
});
