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
- Workflows default to read-only tokens. Jobs that write request only the scopes they need.
- GitHub Actions is on the bypass list of the `main`, `stage` and `dev` rulesets, so any workflow with `contents: write` can push to those branches without a pull request or checks; today only `release.yml` has that permission, and a new workflow that writes contents needs the same scrutiny as a change to the rulesets.
- CodeQL and dependency review run on every pull request into `main`, `stage` or `dev`. CodeQL scans the workflows as well as the TypeScript, for untrusted input reaching a shell and over-broad permissions.
- The Cloudflare API token is an environment secret, limited to the `staging` and `production` environments, which admit only `stage` and `main`. Pull requests and pushes to `dev` never receive it. The job that holds it installs with `--ignore-scripts` and runs no build, no npm script and no project JavaScript; the only repository files it runs are two shell scripts, the npm signature check and the post-deploy smoke test (bash, curl and jq), each in a step without the token ([CONTRIBUTING.md#deploying](CONTRIBUTING.md#deploying)). On Cloudflare, the deployed Worker has two bindings: its own version's metadata, whose id every response carries as `X-Worker-Version`, and a D1 database for the 30-day uptime history, filled by a five-minute Cron Trigger. That database stores only the service id, the UTC date, sample counts and the worst health seen: no IPs, cookies, request payloads or error text. The board itself is kept only in memory.
- Vendor responses are untrusted input: each one is read with a 9-second timeout and a 4 MiB cap, enforced while the body streams in (`src/lib/status/http.ts`), so a hostile or broken source cannot exhaust the server's memory. Links taken from a payload (incident pages, shortlinks, RSS items) reach the board, the API and the feed only as https URLs on that vendor's own status hosts (`src/lib/status/vendor-url.ts`); anything else becomes the vendor's catalog page. The MikroTik version that goes into the changelog URL must look like a version.
- Every page and API response carries a Content-Security-Policy that allows only this origin and forbids framing, plus `nosniff`, HSTS, a referrer policy and a permissions policy.
- The live vendor checks in `source-health.yml` do not install npm dependencies, so no third-party package code runs in a job that can write issues.
