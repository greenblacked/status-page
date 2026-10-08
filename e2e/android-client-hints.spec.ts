import type { Page } from "@playwright/test";
import { ANDROID_PLATFORM_VERSION, type AndroidClientHints } from "./support/android-user-agent";
import { expect, test } from "./test";

// The Android projects report Android 17 and the profile's model through User-Agent Client Hints, as Chrome on
// Android does with its reduced user agent (e2e/support/android-user-agent.ts). Only the Chromium Android projects
// carry the hints; the others skip.

test("an Android project reports Android 17 and its model through client hints @layout", async ({ page }, testInfo) => {
  const hints = testInfo.project.metadata.androidClientHints as AndroidClientHints | undefined;
  test.skip(!hints, "not an Android project");
  if (!hints) return;

  await page.goto("/");
  expect(await reportedHints(page)).toMatchObject({
    platform: "Android",
    mobile: hints.mobile,
    platformVersion: ANDROID_PLATFORM_VERSION,
    model: hints.model,
  });
});

test("a page the test opens itself reports the same hints @layout", async ({ context }, testInfo) => {
  test.skip(!testInfo.project.metadata.androidClientHints, "not an Android project");
  const hints = testInfo.project.metadata.androidClientHints as AndroidClientHints;
  const other = await context.newPage();
  await other.goto("/");
  // The override is sent after the page exists, so the first request may precede it; the page's own values do not.
  await expect
    .poll(() => reportedHints(other))
    .toMatchObject({
      platformVersion: ANDROID_PLATFORM_VERSION,
      model: hints.model,
      mobile: hints.mobile,
    });
});

async function reportedHints(page: Page) {
  return page.evaluate(async () => {
    const data = (navigator as Navigator & { userAgentData: NavigatorUAData }).userAgentData;
    type NavigatorUAData = {
      platform: string;
      mobile: boolean;
      getHighEntropyValues(hints: string[]): Promise<{ platformVersion: string; model: string }>;
    };
    const high = await data.getHighEntropyValues(["platformVersion", "model"]);
    return { platform: data.platform, mobile: data.mobile, ...high };
  });
}
