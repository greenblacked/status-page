// Chrome on Android no longer sends the device's Android version or model: with the reduced user agent its user
// agent reads `Android 10; K` and `Chrome/<major>.0.0.0`, whatever the phone, and a tablet leaves
// out "Mobile". The real version and model are only in the client hints (`Sec-CH-UA-Platform-Version`,
// `Sec-CH-UA-Model`). Playwright's Android profiles carry an older, full user agent that Chrome no longer
// sends ("Android 14; Pixel 7", "Android 16; Pixel 10", "Android 8.0.0; SM-G965U"), so the Android projects use
// this to send what Chrome on Android sends today, on Android 17 (the newest release, API 37) as on any other
// version. Two parts, both here:
//  - reducedAndroidUserAgent: the user agent string, reduced as above. Only the user agent changes: the profile's own
//    viewport, scale factor and touch stay, and no test or page code reads the user agent. The Chrome major comes from
//    the profile itself, which Playwright keeps at the Chromium it ships, because the user agent should name the engine
//    that runs (a "Chrome/155" on Chromium 153 would be a claim the engine cannot back). The `Mobile` token stays on
//    every phone profile, including the unfolded Galaxy Z Fold 7 (984px wide), where real Chrome may differ; no test
//    reads it. A profile that is not Android (the iPad-sized Chromium tablet) is returned as it is.
//  - androidClientHints / clientHintsOverride: the client hints. Playwright 1.63 has no context option for them: it
//    derives them from the user agent string (the reduced "Android 10; K" would give platformVersion "10" and no
//    model), and sends them per page with Emulation.setUserAgentOverride. So e2e/test.ts sends its own override over
//    CDP once a page exists (Chromium only), with Android 17 and the profile's model: to the `page` fixture's page
//    before the test starts, and to every page the test's `context` opens later (`context.newPage()`, popups), which
//    may lose a race with its first request. Not covered: contexts a test makes itself with `browser.newContext()`,
//    and workers and service workers, which keep Playwright's derived hints; the board has none. The profile's real
//    model is kept even where that phone never got Android 17 (the Galaxy S9+ stopped long before it): the version is the
//    owner's choice for every Android project, the model only tells the profiles apart. The Galaxy Tab S9 is an 11"
//    tablet, which real Chrome serves the desktop site by default (a desktop Linux user agent, `Sec-CH-UA-Mobile ?0`);
//    its profile here is the Android tablet one, to cover that layout, not what Chrome sends by default.
// https://www.chromium.org/updates/ua-reduction/
// https://developer.android.com/about/versions/17
// https://developer.chrome.com/docs/privacy-security/user-agent-client-hints
export function reducedAndroidUserAgent<T extends { userAgent: string }>(profile: T): T {
  const { userAgent } = profile;
  if (!userAgent.includes("; Android ")) return profile;
  return {
    ...profile,
    userAgent: userAgent
      .replace(/\(Linux; Android [^;)]+; [^)]*\)/, "(Linux; Android 10; K)")
      .replace(/Chrome\/(\d+)\.\d+\.\d+\.\d+/, "Chrome/$1.0.0.0"),
  };
}

/** The Android release every Android project reports through client hints: 17 (API level 37), the newest stable one. */
export const ANDROID_VERSION = "17";
/** `Sec-CH-UA-Platform-Version` / `platformVersion`, as a dotted version. */
export const ANDROID_PLATFORM_VERSION = `${ANDROID_VERSION}.0.0`;

export type AndroidClientHints = { model: string; mobile: boolean; chromeVersion: string };

/**
 * What an Android profile's full user agent says about the device: its model, whether it is a phone (`Mobile`) and
 * the Chromium version it names. Undefined for a profile that is not Android. The tablet (no `Mobile`) is not mobile.
 */
export function androidClientHints(profile: { userAgent: string }): AndroidClientHints | undefined {
  const { userAgent } = profile;
  if (!userAgent.includes("; Android ")) return undefined;
  const model = /\(Linux; Android [^;)]+; ([^;)]*?)(?: Build\/[^;)]*)?\)/.exec(userAgent)?.[1] ?? "";
  const chromeVersion = /Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(userAgent)?.[1] ?? "";
  return { model, mobile: / Mobile Safari\//.test(userAgent), chromeVersion };
}

/** A project's `metadata` that carries the client hints to the `page` fixture; empty for a profile that is not Android. */
export const androidProjectMetadata = (profile: { userAgent: string }) => {
  const hints = androidClientHints(profile);
  return hints ? { androidClientHints: hints } : {};
};

/**
 * The parameters of Chromium's Emulation.setUserAgentOverride for an Android project: the reduced user agent, and
 * client hints that say Android 17 and the device's model. The brands are Chromium's and Chrome's at the engine's
 * major, with a GREASE brand (its exact string is illustrative; nothing reads it).
 */
export function clientHintsOverride(userAgent: string, acceptLanguage: string, hints: AndroidClientHints) {
  const major = hints.chromeVersion.split(".")[0] ?? "";
  const grease = { brand: "Not?A_Brand", version: "8" };
  return {
    userAgent,
    acceptLanguage,
    userAgentMetadata: {
      brands: [{ brand: "Chromium", version: major }, { brand: "Google Chrome", version: major }, grease],
      fullVersionList: [
        { brand: "Chromium", version: hints.chromeVersion },
        { brand: "Google Chrome", version: hints.chromeVersion },
        { ...grease, version: "8.0.0.0" },
      ],
      fullVersion: hints.chromeVersion,
      platform: "Android",
      platformVersion: ANDROID_PLATFORM_VERSION,
      architecture: "",
      bitness: "",
      wow64: false,
      model: hints.model,
      mobile: hints.mobile,
      formFactors: hints.mobile ? ["Mobile"] : ["Tablet"],
    },
  };
}
