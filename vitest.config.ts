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
    // No unit test reaches the network: fetch refuses every host but this machine (src/test/no-network.ts).
    setupFiles: ["src/test/no-network.ts"],
    // A global or an environment variable a test stubs is undone after it, so none leaks into the next test, and a
    // stub belongs in the test or a beforeEach, never in a describe body or a beforeAll (undone after the first test).
    unstubGlobals: true,
    unstubEnvs: true,
    // `pnpm run test:coverage`. The thresholds sit just under the current
    // numbers, so coverage can only go up: raise them when it does. Measured
    // 2026-10-22: 74.41 statements, 78.20 branches, 74.63 functions, 74.85 lines.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,cjs}"],
      exclude: ["**/*.test.ts", "src/test/**", "**/__fixtures__/**", "src/routeTree.gen.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      thresholds: { statements: 73, branches: 77, functions: 73, lines: 73 },
    },
  },
});
