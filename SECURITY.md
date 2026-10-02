# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/greenblacked/status-page/security/advisories/new)**
(Security tab → Advisories → Report a vulnerability).

Do not open a public issue, pull request, or discussion for a suspected vulnerability.

Include what you can of:

- the affected file, route, or workflow
- steps to reproduce, or a proof of concept
- the impact you expect: what an attacker gains

Status Page has a single maintainer, so responses are best-effort. You should get an acknowledgement within a few days. Fixes land on `main`, and you will be credited in the advisory unless you ask not to be.

## Supported versions

Only the current `main` branch is supported. There are no release branches.

## Scope

In scope:

- The application: the server functions in `src/lib/status/`, the vendor collectors and their parsing of untrusted vendor payloads, and the rendered board
- The CI and automation in `.github/workflows/` and `scripts/ci/`, including anything that could let a pull request from a fork gain write access. `ci-triage.yml` runs with a write token by design and must never execute pull request code.
- The deployment: anything that could expose the Cloudflare API token that `deploy.yml` uses, or let code other than `stage` or `main` reach the deployed Worker
- The response headers the board sends (`src/lib/security-headers.ts`)
- Dependency vulnerabilities that are actually reachable from Status Page's code

Out of scope:

- The vendors' own status pages and APIs. Report problems with those to the vendor.
- Findings that need an already-compromised maintainer account or machine
- Missing hardening headers on someone else's deployment of Status Page

## How the repository defends itself

- Every third-party Action is pinned to a full commit SHA, and the actionlint image is pinned by digest.
- Dependabot waits out a cooldown before proposing a release (7 days for npm, 3 for Actions), and every install in CI and in the deploy workflow, including the deploy job's own, verifies each npm package's registry signature (`npm audit signatures`) before anything from it runs.
- One documented exception covers advisories in dependencies bundled inside the pinned npm CLI in `tools/npm`. That npm runs in CI only and never ships, and no published npm release avoids them yet. Dependency review allows three IDs (brace-expansion GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p, undici GHSA-rfgv-xxqx-mfg5), and trivy ignores those three for `tools/npm/package-lock.json` only; the trivy entries expire on 2026-12-31. OpenSSF Scorecard's Vulnerabilities check skips ten advisories OSV lists for the bundled packages (the three above plus the rest for brace-expansion, undici and ip-address) through `tools/npm/osv-scanner.toml`, which expires on 2026-12-01 ([CONTRIBUTING.md#dependencies](CONTRIBUTING.md#dependencies)).
- Workflows default to read-only tokens. Jobs that write request only the scopes they need.
- GitHub Actions is on the bypass list of the `main`, `stage` and `dev` rulesets, so any workflow with `contents: write` can push to those branches without a pull request or checks; today only `release.yml` has that permission, and a new workflow that writes contents needs the same scrutiny as a change to the rulesets.
- CodeQL and dependency review run on every pull request into `main`, `stage` or `dev`. CodeQL scans the workflows as well as the TypeScript, for untrusted input reaching a shell and over-broad permissions.
- The Cloudflare API token is an environment secret, limited to the `staging` and `production` environments, which admit only `stage` and `main`. Pull requests and pushes to `dev` never receive it. The job that holds it installs with `--ignore-scripts` and runs no build, no npm script and no project JavaScript; the only repository files it runs are two shell scripts, the npm signature check and the post-deploy smoke test (bash, curl and jq), each in a step without the token ([CONTRIBUTING.md#deploying](CONTRIBUTING.md#deploying)). On Cloudflare, the deployed Worker itself has one binding, its own version's metadata, whose id every response carries as `X-Worker-Version` and which names nothing but that version. It has no storage binding and no scheduled job; it keeps its board only in memory.
- Vendor responses are untrusted input: each one is read with a 9-second timeout and a 4 MiB cap, enforced while the body streams in (`src/lib/status/http.ts`), so a hostile or broken source cannot exhaust the server's memory. Links taken from a payload (incident pages, shortlinks, RSS items) reach the board, the API and the feed only as https URLs on that vendor's own status hosts (`src/lib/status/vendor-url.ts`); anything else becomes the vendor's catalog page. The MikroTik version that goes into the changelog URL must look like a version. A redirect is followed (at most three) only to https, without credentials, on exactly the host (and port) that was asked for or on the one other host listed for it in `http.ts` (MikroTik's upgrade and download hosts, and `docs.cloud.google.com` for Google Cloud's release-notes feed); anywhere else the check fails, naming the host it was sent to. Text from a payload is held to a length when each snapshot is built (`src/lib/status/bounds.ts`): names 120 characters, titles 300, summaries, details and other text 500, ids 200, and a link longer than 2000 characters is dropped. At most 50 incidents are listed per service (the count read is kept). Of at most the first 5000 items of an RSS feed, the 200 newest by date are read. Of the arrays in a Statuspage or Status.io payload (components, incidents, maintenance) only the first 5000 entries are read, and 500 of one nested in them (a component's containers, an incident's messages), cut before anything is mapped, so a 4 MiB body of empty objects costs no more than a small one there. The other JSON readers (such as Google's incidents, AWS and Apple) are bounded by the 4 MiB body cap alone, not by a row count. A failed check never quotes the response body: a message for a body that is not JSON says at most that it looks like HTML, empty or of a given content type. The parsers of vendor text scan it in linear time (their tests run crafted 200,000-character inputs against a time budget), so a crafted body cannot stall the Worker.
- <a id="release-feeds"></a>Release feeds (`src/lib/status/release-feeds.server.ts`) are vendor text like any other and are held to the same rules, and they are advisory: they add a `releaseFeed` to a status card and nothing else, so a hostile or broken feed can at worst lose that card its release line. The hosts read are `aws.amazon.com`, `cloud.google.com` (which redirects to `docs.cloud.google.com`, the one added entry in the redirect table in `http.ts`; the request sends a `Range` for the first 512 KiB and the body is cut at 512 KiB as it is read, whether or not the server honours the `Range`), `www.microsoft.com`, `github.blog`, `docs.gitlab.com` (its all-releases feed holds every release since 2023 with full text, 3.6 MB and growing, newest first, so this request is cut at 512 KiB too, whether or not the server honours `Range`: reading stops and the connection is cancelled there, and a body cut mid-entry still gives its complete leading entries) and `api.steampowered.com`. Each is fetched through `http.ts` with a 4-second timeout (the 4 MiB cap, which the two cut feeds never reach, and the three-redirect rule apply). Of an RSS or Atom feed at most the first 5000 entries are dated and the 12 newest read; at most 5 are kept, each reading at most the first 100,000 characters of its text, 60 text blocks and 5 note lines of 200 characters, with scripts, styles and markup removed. A title is cut to 140 characters. An entry link reaches the page only as https, without credentials, on that vendor's own hosts (`aws.amazon.com`, `cloud.google.com`, `microsoft.com`, `github.blog`, `github.com`, `docs.gitlab.com`, `about.gitlab.com`, `steampowered.com`, `steamcommunity.com`); anything else becomes the feed's page. Steam links are built from the numeric post id, never taken from the payload. Every regular expression there is anchored or bounded and is covered by `redos.test.ts`. A failure is logged as a `release_feed_failed` line (kind, status and host-level message, never the body). At most seven extra requests are made per isolate per 30 minutes (5 minutes after a failure): one for each of the six feeds and a second for Google's, because the redirect from `cloud.google.com` to `docs.cloud.google.com` is followed by hand and each hop is a request. They run in parallel with the health checks and are never waited for: the board ends with the health sweep, taking the feeds that have arrived by then, and a slower feed is finished in the background (`waitUntil` on Workers) and shown on the next board, so a slow vendor cannot lengthen a sweep or its measured duration. A cold sweep makes about 29 requests today, 36 with the release feeds, well inside the 50 a Workers request is allowed on the Free plan.
- Every page and API response carries a Content-Security-Policy that allows only this origin and forbids framing, plus `nosniff`, HSTS (with `includeSubDomains`), a referrer policy and a permissions policy.
- Workers Logs keep no query strings (`redact_query_string` in `wrangler.jsonc`), because the search box puts what a visitor typed in `?q=`.
- The live vendor checks in `source-health.yml` do not install npm dependencies, so no third-party package code runs in a job that can write issues.
