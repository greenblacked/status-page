// Chrome on Android no longer sends the device's Android version or model: with the reduced user agent its user
// agent reads `Android 10; K` and `Chrome/<major>.0.0.0`, whatever the phone, and a tablet leaves
// out "Mobile". The real version and model are only in the client hints (`Sec-CH-UA-Platform-Version`,
// `Sec-CH-UA-Model`). Playwright's Android profiles carry an older, full user agent that Chrome no longer
// sends ("Android 14; Pixel 7", "Android 16; Pixel 10", "Android 8.0.0; SM-G965U"), so the Android projects use
// this to send what Chrome on Android sends today, on Android 17 (the newest release, API 37) as on any other
// version; Pixel 10 is the newest Pixel profile Playwright ships. Only the user agent changes: the profile's own viewport,
// scale factor and touch stay, and no test or page code reads the user agent. The Chrome major comes from the
// profile itself, which Playwright keeps at the Chromium it ships, because the user agent should name the engine
// that runs (a "Chrome/155" on Chromium 153 would be a claim the engine cannot back). The 153 is Playwright's
// Chromium, which may be newer than the stable Chrome phones run today. The `Mobile` token stays on every phone
// profile, including the unfolded Galaxy Z Fold 7 (984px wide), where real Chrome may differ; no test reads it.
// A profile that is not Android (the iPad-sized Chromium tablet) is returned as it is.
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
