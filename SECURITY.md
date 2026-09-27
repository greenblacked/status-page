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

Status Bar has a single maintainer, so responses are best-effort. You should get an acknowledgement within a few days. Fixes land on `main`, and you will be credited in the advisory unless you ask not to be.

## Supported versions

Only the current `main` branch is supported. There are no release branches.

## Scope

In scope:

- The application: the server functions in `src/lib/status/`, the vendor collectors and their parsing of untrusted vendor payloads, and the rendered board
- The CI and automation in `.github/workflows/` and `scripts/ci/`, including anything that could let a pull request from a fork gain write access. `ci-triage.yml` runs with a write token by design and must never execute pull request code.
- The deployment: anything that could expose the Cloudflare API token that `deploy.yml` uses, or let code other than `dev` or `main` reach the deployed Workers
- The response headers the board sends (`src/lib/security-headers.ts`)
- Dependency vulnerabilities that are actually reachable from Status Bar's code

Out of scope:

- The vendors' own status pages and APIs. Report problems with those to the vendor.
- Findings that need an already-compromised maintainer account or machine
- Missing hardening headers on someone else's deployment of Status Bar

## How the repository defends itself

- Every third-party Action is pinned to a full commit SHA, and the actionlint image is pinned by digest.
- Workflows default to read-only tokens. Jobs that write request only the scopes they need.
- CodeQL and dependency review run on every pull request into `main` or `dev`.
- The Cloudflare API token is an environment secret, limited to the `staging` and `production` environments, which admit only `dev` and `main`. Pull requests never receive it. The job that holds it installs with `--ignore-scripts` and runs no build, no npm script and no project JavaScript; the only repository file it runs is the post-deploy smoke test (bash and curl), in a step without the token ([CONTRIBUTING.md#deploying](CONTRIBUTING.md#deploying)). On Cloudflare, the deployed Worker itself has one binding, a KV namespace it reads and writes its own board snapshot in; nothing reaches it but the Worker's own scheduled job and requests to the board.
- Vendor responses are untrusted input: each one is read with a 9-second timeout and a 4 MiB cap, enforced while the body streams in (`src/lib/status/http.ts`), so a hostile or broken source cannot exhaust the server's memory.
- Every page and API response carries a Content-Security-Policy that allows only this origin and forbids framing, plus `nosniff`, HSTS, a referrer policy and a permissions policy.
- The live vendor checks in `source-health.yml` do not install npm dependencies, so no third-party package code runs in a job that can write issues.
