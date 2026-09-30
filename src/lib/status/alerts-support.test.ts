import { describe, expect, it } from "vitest";
import { pageAlertsUnsupported } from "./alerts-support";

describe("pageAlertsUnsupported", () => {
  it("keeps a Mac Safari tab and a Mac Dock web app supported", () => {
    expect(pageAlertsUnsupported({ platform: "MacIntel", maxTouchPoints: 0, standalone: false })).toBe(false);
    expect(pageAlertsUnsupported({ platform: "MacIntel", maxTouchPoints: 0, standalone: true })).toBe(false);
  });

  it("rules out an iPad Home Screen app in desktop mode, which calls itself a Mac", () => {
    expect(pageAlertsUnsupported({ platform: "MacIntel", maxTouchPoints: 5, standalone: true })).toBe(true);
  });

  it("rules out an iPhone", () => {
    expect(pageAlertsUnsupported({ platform: "iPhone", maxTouchPoints: 5, standalone: false })).toBe(true);
  });

  it("keeps browsers without the standalone property supported, touch or not", () => {
    expect(pageAlertsUnsupported({ platform: "Win32", maxTouchPoints: 10 })).toBe(false);
    expect(pageAlertsUnsupported({ platform: "Linux armv81", maxTouchPoints: 5 })).toBe(false);
    expect(pageAlertsUnsupported({ platform: "Linux x86_64" })).toBe(false);
  });
});
