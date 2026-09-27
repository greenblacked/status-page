import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only *.test.ts files are tests. Shared helpers live in src/test/ and
    // payload fixtures in src/lib/status/__fixtures__/, outside this glob.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Cards format dates in the local time zone, so pin one: a test that
    // expects "Sep 21" must not read "Sep 22" on a machine east of UTC+7.
    env: { TZ: "UTC" },
  },
});
