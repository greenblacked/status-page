import { devices } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { reducedAndroidUserAgent } from "../../e2e/support/android-user-agent";
import config from "../../playwright.config";

// Chrome on Android sends a reduced user agent (e2e/support/android-user-agent.ts). The Android projects of
// playwright.config.ts rewrite Playwright's older, full profile user agents to it; this holds the result, so a
// descriptor change in @playwright/test cannot leave a real Android version or model in a project unnoticed.

const REDUCED =
  /^Mozilla\/5\.0 \(Linux; Android 10; K\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(\d+)\.0\.0\.0 (Mobile )?Safari\/537\.36$/;

// Every project that runs an Android profile, by name and the descriptor it takes: listed on purpose, so a new or
// renamed one fails here until it is decided on.
const ANDROID: Record<string, { device: string; mobile: boolean }> = {
  mobile: { device: "Pixel 7", mobile: true },
  "Galaxy S9+": { device: "Galaxy S9+", mobile: true },
  "Pixel 10": { device: "Pixel 10", mobile: true },
  "Galaxy Z Fold 7": { device: "Galaxy Z Fold 7", mobile: true },
  "Galaxy Z Fold 7 Cover": { device: "Galaxy Z Fold 7 Cover", mobile: true },
  "Galaxy Tab S9": { device: "Galaxy Tab S9", mobile: false },
  "Pixel 7 landscape": { device: "Pixel 7 landscape", mobile: true },
};

// Projects that are not Android and keep their descriptor's user agent: name to descriptor.
const OTHER: Record<string, string> = {
  desktop: "Desktop Chrome",
  tablet: "iPad Pro 11",
  "Desktop Safari": "Desktop Safari",
  "iPhone 17 Pro": "iPhone 17 Pro",
  "iPad Pro 11": "iPad Pro 11",
  "iPhone SE (3rd gen)": "iPhone SE (3rd gen)",
  "iPhone 17 Pro Max": "iPhone 17 Pro Max",
  "iPad Mini": "iPad Mini",
  "iPhone 17 Pro landscape": "iPhone 17 Pro landscape",
};

const profile = (name: string) => devices[name as keyof typeof devices];
const projects = config.projects ?? [];
const userAgentOf = (name: string) => {
  const project = projects.find((p) => p.name === name);
  if (!project) throw new Error(`no project named ${name}`);
  return project.use?.userAgent;
};

// The config sets E2E_RUN when it loads; leave the environment as it was found.
const hadRun = "E2E_RUN" in process.env;
afterAll(() => {
  if (!hadRun) delete process.env.E2E_RUN;
});

describe("the projects of playwright.config.ts", () => {
  it("are the Android and the other projects listed here, and no others", () => {
    expect(projects.map((p) => p.name).sort()).toEqual([...Object.keys(ANDROID), ...Object.keys(OTHER)].sort());
  });

  it.each(Object.entries(ANDROID))("%s sends the reduced Android user agent", (name, { device, mobile }) => {
    const full = profile(device).userAgent;
    const major = /Chrome\/(\d+)\./.exec(full)?.[1];
    expect(major).toBeDefined();
    const ua = userAgentOf(name);
    expect(ua).toMatch(REDUCED);
    expect(ua).toBe(
      `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 ${mobile ? "Mobile " : ""}Safari/537.36`,
    );
    expect(full).toContain("; Android ");
    expect(/Mobile Safari/.test(full)).toBe(mobile);
  });

  it("keep only the Android 10 and the K of the reduced form in any Android user agent", () => {
    for (const p of projects) {
      const ua = p.use?.userAgent ?? "";
      if (!ua.includes("Android")) continue;
      expect([...ua.matchAll(/Android ([\d.]+)/g)].map((m) => m[1])).toEqual(["10"]);
      expect(ua).not.toMatch(/Pixel|SM-|Build\//);
      expect(ua).toContain("; K)");
    }
  });

  it("give a phone Mobile and the tablet no Mobile", () => {
    expect(userAgentOf("Galaxy Tab S9")).not.toContain("Mobile");
    expect(userAgentOf("Galaxy Z Fold 7")).toContain(" Mobile Safari");
    for (const [name, { mobile }] of Object.entries(ANDROID)) {
      expect(userAgentOf(name)?.includes(" Mobile Safari")).toBe(mobile);
    }
  });

  it.each(Object.entries(OTHER))("%s keeps its descriptor's user agent", (name, device) => {
    expect(userAgentOf(name)).toBe(profile(device).userAgent);
  });
});

describe("reducedAndroidUserAgent", () => {
  it("returns a profile that is not Android as it is", () => {
    const ipad = devices["iPad Pro 11"];
    expect(reducedAndroidUserAgent(ipad)).toBe(ipad);
  });

  it("keeps the rest of the profile", () => {
    const pixel = devices["Pixel 7"];
    const reduced = reducedAndroidUserAgent(pixel);
    expect({ ...reduced, userAgent: "" }).toEqual({ ...pixel, userAgent: "" });
  });
});
