import { describe, expect, it } from "vitest";
import { pageAlertsUnsupported } from "./alerts-support";

describe("pageAlertsUnsupported", () => {
  it("rules out iPhone and iPad Safari, which have the standalone property", () => {
    expect(pageAlertsUnsupported({ platform: "iPhone", maxTouchPoints: 5, standalone: false }, true)).toBe(true);
    expect(pageAlertsUnsupported({ platform: "iPad", standalone: true }, false)).toBe(true);
  });

  it("rules out an iPad in desktop mode: a Mac with touch and no push", () => {
    expect(pageAlertsUnsupported({ platform: "MacIntel", maxTouchPoints: 5 }, false)).toBe(true);
  });

  it("keeps a Mac without touch supported, with or without push", () => {
    expect(pageAlertsUnsupported({ platform: "MacIntel", maxTouchPoints: 0 }, true)).toBe(false);
    expect(pageAlertsUnsupported({ platform: "MacIntel", maxTouchPoints: 0 }, false)).toBe(false);
    expect(pageAlertsUnsupported({ platform: "MacIntel" }, false)).toBe(false);
  });

  it("keeps a touch Mac-like device that has push, and other platforms", () => {
    expect(pageAlertsUnsupported({ platform: "MacIntel", maxTouchPoints: 5 }, true)).toBe(false);
    expect(pageAlertsUnsupported({ platform: "Win32", maxTouchPoints: 10 }, false)).toBe(false);
    expect(pageAlertsUnsupported({ platform: "Linux armv81", maxTouchPoints: 5 }, false)).toBe(false);
  });
});
