// Chromium may resolve this machine and nothing else, so a page that asks another host fails to connect (and e2e/test.ts
// fails the test). It is done with launch flags, not a route, because a routed page has no HTTP cache, which the tests
// of the self-hosted Inter need. No proxy either: one from the environment (https_proxy) would resolve a host the
// rules refuse, and the preview is on this machine and needs none. The playwright config and the specs that start a
// browser of their own use the same flags.
export const chromiumArgs = [
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
  "--no-proxy-server",
];
