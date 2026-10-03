import { defineConfig } from "vitest/config";

// Cards format dates in the local time zone, so pin one: a test that
// expects "Sep 21" must not read "Sep 22" on a machine east of UTC+7. Set
// here, in the main process, before any worker starts: a worker thread
// copies the environment once and never re-reads TZ, so `test.env` alone
// only holds under the default forks pool.
process.env.TZ = "UTC";

export default defineConfig({
  // The `@/` imports the components use, as in vite.config.ts.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    // Only *.test.ts files are tests. Shared helpers live in src/test/ and
    // payload fixtures in src/lib/status/__fixtures__/, outside this glob.
    // Browser tests live in e2e/ and run under Playwright, not here.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    env: { TZ: "UTC" },
    // `pnpm run test:coverage`. The thresholds sit just under the current
    // numbers, so coverage can only go up: raise them when it does.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,cjs}"],
      exclude: ["**/*.test.ts", "src/test/**", "**/__fixtures__/**", "src/routeTree.gen.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      thresholds: { statements: 63, branches: 58, functions: 60, lines: 64 },
    },
  },
});
