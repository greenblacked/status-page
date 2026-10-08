import { ANDROID_PLATFORM_VERSION, type AndroidClientHints } from "./support/android-user-agent";
import { expect, test } from "./test";

// The Android projects report Android 17 and the profile's model through User-Agent Client Hints, as Chrome on
// Android does with its reduced user agent (e2e/support/android-user-agent.ts). Only the Chromium Android projects
// carry the hints; the others skip.

test("an Android project reports Android 17 and its model through client hints @layout", async ({ page }, testInfo) => {
  const hints = testInfo.project.metadata.androidClientHints as AndroidClientHints | undefined;
  test.skip(!hints, "not an Android project");
  if (!hints) return;

  const platformHeader = page.waitForRequest((request) => new URL(request.url()).pathname === "/");
  await page.goto("/");
  expect((await (await platformHeader).allHeaders())["sec-ch-ua-platform"]).toBe('"Android"');

  const reported = await page.evaluate(async () => {
    const data = (navigator as Navigator & { userAgentData: NavigatorUAData }).userAgentData;
    type NavigatorUAData = {
      platform: string;
      mobile: boolean;
      getHighEntropyValues(hints: string[]): Promise<{ platformVersion: string; model: string }>;
    };
    const high = await data.getHighEntropyValues(["platformVersion", "model"]);
    return { platform: data.platform, mobile: data.mobile, ...high };
  });
  expect(reported).toMatchObject({
    platform: "Android",
    mobile: hints.mobile,
    platformVersion: ANDROID_PLATFORM_VERSION,
    model: hints.model,
  });
  expect(reported.platformVersion).toBe("17.0.0");
});
