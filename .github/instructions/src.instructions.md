---
applyTo: "src/**"
---
# Source rules (src/)

Full rules: [AGENTS.md](../../AGENTS.md#coding-rules-for-this-repo) and [CONTRIBUTING.md#code-style](../../CONTRIBUTING.md#code-style). If they differ from this file, they win.

## Data and collectors
- Official, machine-readable vendor sources only. No aggregators, no crowd reports. The only HTML sources are the Windows 11 and Android release pages; any other needs a written reason in CONTRIBUTING.
- Fetch only through `src/lib/status/http.ts` (9 s timeout, 4 MiB body cap, at most three redirects, https on the same host or the one listed for it). Cap text with `bounds.ts`; take vendor links only through `vendor-url.ts`.
- Parsers of vendor text run in linear time; add a `redos.test.ts` case for a new parser. Failure messages never quote a response body.
- One broken collector costs one card: it yields `health: "unknown"` with a `failure` and never throws past its own isolation.
- A new service needs a catalog entry, a collector called from `collectAllServices` at the same position (`collectors.test.ts` checks it), a README table row, the counts in `catalog.test.ts`, `scripts/ci/smoke.sh` and the README's "twenty", a mapping onto the five states, a fixture test and a malformed-payload test that reads as `unknown`.
- Keep the board cache in `board-cache.server.ts`, away from any `createServerFn`.

## Health and derivations
- One severity order, worst first, from `SEVERITY_ORDER` in `health.ts`. Do not add a second order.
- An unreadable source is `unknown` ("No data"), never operational. Informational notices and upcoming maintenance never change health.
- `health`, `verdict`, `diff`, `integrations` and `metrics` stay pure functions of a snapshot, so the page, API, feed and badges agree.

## UI and theme
- Day or night is decided only in `src/lib/theme.ts`; never read `prefers-color-scheme` in script.
- Colours and radii come from tokens in `src/styles.css`: no raw hex in JSX, no retired utilities, no arbitrary `text-[Npx]` (`./scripts/ci/tokens.sh`).
- Times go through `local-time.ts` / `LocalTime`; never format a time on the server in a zone.
- Sentence-case English copy. Animate `transform` and `opacity` only; new motion respects `prefers-reduced-motion`.
- Every inline `<script>` carries the CSP nonce. Do not loosen `src/lib/security-headers.ts` without a reason in the PR.

## Node server (src/node/)
- Uses `node:http` alone and runs under Node type stripping: imports carry `.ts` extensions, and `.ts` imports from `src/lib/` are relative, never `@/`. The Dockerfile copies only `src/node/` and `src/lib/security-headers.ts` into the image, so `src/node/` must not import anything else from `src/`.

## Unit tests
- Offline: route `fetch` through `src/test/stub-fetch.ts` and read payloads from `__fixtures__`; unrouted URLs answer 404, never the network.
- Pin the clock (`vi.useFakeTimers` / `vi.setSystemTime`) for anything with a window such as the 14-day rules; `TZ` is UTC.
- A collector test also needs a malformed-payload case that reads as `unknown`.

## Generated and other
- `src/routeTree.gen.ts` is generated; do not edit it.
- No `any`, no unused locals or parameters. Dependencies are pinned to exact versions.
- A behaviour change updates the README in the same commit; a user-visible one adds a line under `## [Unreleased]` in `CHANGELOG.md`.
