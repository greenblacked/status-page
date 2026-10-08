---
applyTo: "e2e/**,playwright.config.ts"
---
# Browser test rules (e2e/, playwright.config.ts)

Full rules: [AGENTS.md](../../AGENTS.md#setup-and-commands) (Browser tests) and [CONTRIBUTING.md#ci](../../CONTRIBUTING.md#ci). If they differ from this file, they win.

- E2E tests never read a live vendor. `playwright.config.ts` preloads `e2e/support/no-vendors.mjs`, which answers vendor URLs from canned fixtures and refuses every other host. Never assert on a vendor's real state.
- For a specific state, serve a fixture board: `serveBoard(page, () => fixtureBoard(Date.now()))` from `e2e/fixture-board.ts`. Take dates from `now`, never from a fixed day.
- Every spec imports `test` and `expect` from `e2e/test.ts`, not from `@playwright/test`.
- Theme is pinned by `e2e/test.ts` to the emulated colour scheme. A test about the stored choice or the clock sets `test.use({ pinTheme: false })`. A test that installs `page.clock` or crosses a two-minute slot sets `test.use({ pinSlot: false })`.
- No `test.only` and no retries: a test that needs a retry is hiding a bug. Never skip, loosen or delete a test to get green.
- The suite has sixteen projects: five run everything (`desktop`, `mobile`, `Desktop Safari`, `iPhone 17 Pro`, `iPad Pro 11`), `tablet` runs a subset, and ten screens run only tests tagged `@layout`. A layout check goes in `e2e/mobile-layout.spec.ts` under that tag.
- Build first: `pnpm run build`, then `pnpm run test:e2e` (pick projects with `--project=<name>`). If browsers are not available, run the other checks and say which projects were skipped.
- A bug fix adds a regression test that fails before the fix.
- Cross-device rule: a UI bug seen on one phone is a mobile bug. Fix and test it across mobile browsers and versions (Android Chrome and others, iOS Safari old and new, phones and tablets, all three backgrounds), with feature detection and a fallback.
- Accessibility is tested with axe (WCAG 2.2 AA) and contrast tests; keep them passing.
