import { defineConfig } from "vitest/config";

// Cards format dates in the local time zone, so pin one: a test that
// expects "Sep 21" must not read "Sep 22" on a machine east of UTC+7. Set
// here, in the main process, before any worker starts: a worker thread
// copies the environment once and never re-reads TZ, so `test.env` alone
// only holds under the default forks pool.
process.env.TZ = "UTC";

export default defineConfig({
  test: {
    environment: "node",
    // Only *.test.ts files are tests. Shared helpers live in src/test/ and
    // payload fixtures in src/lib/status/__fixtures__/, outside this glob.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    env: { TZ: "UTC" },
  },
});
