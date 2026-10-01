import { describe, expect, it } from "vitest";
import { ALERTS_BOOT_SCRIPT, pageAlertsUnsupported } from "./alerts-support";

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

describe("ALERTS_BOOT_SCRIPT", () => {
  // The script runs as text in <head>, so run it as text, against stand-ins.
  function marked(win: object, nav: object): string | null {
    let mark: string | null = null;
    const documentElement = {
      setAttribute: (name: string, value: string) => {
        if (name === "data-alerts") mark = value;
      },
    };
    new Function("window", "navigator", "document", ALERTS_BOOT_SCRIPT)(win, nav, { documentElement });
    return mark;
  }

  it("marks a browser without Notification", () => {
    expect(marked({}, { maxTouchPoints: 0 })).toBe("unsupported");
  });

  it("marks an iPhone or an iPad, which define Notification but never show one", () => {
    expect(marked({ Notification: {} }, { standalone: false, maxTouchPoints: 5 })).toBe("unsupported");
  });

  it("leaves a Mac, and any browser that can show alerts, alone", () => {
    expect(marked({ Notification: {} }, { standalone: false, maxTouchPoints: 0 })).toBeNull();
    expect(marked({ Notification: {} }, { maxTouchPoints: 10 })).toBeNull();
  });

  it("agrees with pageAlertsUnsupported", () => {
    for (const nav of [
      { standalone: true, maxTouchPoints: 5 },
      { standalone: true, maxTouchPoints: 0 },
      { maxTouchPoints: 5 },
    ]) {
      expect(marked({ Notification: {} }, nav) === "unsupported").toBe(pageAlertsUnsupported(nav));
    }
  });
});
