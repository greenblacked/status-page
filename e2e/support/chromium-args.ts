import { fileURLToPath } from "node:url";

// Chromium may resolve this machine and nothing else, so a page that asks another host fails to connect (and e2e/test.ts
// fails the test). It is done with launch flags, not a route, because a routed page has no HTTP cache, which the tests
// of the self-hosted Inter need. No proxy either: one from the environment (https_proxy) would resolve a host the
// rules refuse, and the preview is on this machine and needs none. The playwright config and the specs that start a
// browser of their own use the same flags.
export const chromiumArgs = [
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
  "--no-proxy-server",
];

// The environment to start Chromium with on Linux: the machine's own, with FONTCONFIG_FILE pointing at fonts.conf,
// which hides any Inter installed on the machine (a system Inter answers system-ui, so the page's self-hosted Inter
// would never be requested). Elsewhere fontconfig is not what finds the fonts, so it is left unset. A FONTCONFIG_FILE
// that is already set is kept: whoever set it chose the fonts on purpose.
export const chromiumEnv: Record<string, string> | undefined =
  process.platform === "linux"
    ? {
        ...(process.env as Record<string, string>),
        FONTCONFIG_FILE: process.env.FONTCONFIG_FILE || fileURLToPath(new URL("./fonts.conf", import.meta.url)),
      }
    : undefined;
