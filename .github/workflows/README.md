# Workflows

| Workflow | Trigger | What it guards |
| --- | --- | --- |
| [`ci.yml`](ci.yml) | push to `main` or `dev` (not the commits `release.yml` pushes, which start no workflow), PRs into either, a merge queue, manual | One job per concern: `lint` (Biome, hygiene, documentation links, changelog section, shellcheck), `typecheck`, `test` (with coverage thresholds) and `build` plus SSR smoke (`scripts/ci/smoke.sh`) on the Node version in `.nvmrc` and on Node 24, `browser tests` (Playwright and axe against that build), `commit messages`, `branch name`, and `workflow lint` (actionlint and zizmor). `CI OK` passes only when all of them did and is the one check to require. Job summaries show coverage and client bundle sizes |
| [`scorecard.yml`](scorecard.yml) | push to `main`, branch protection changes, weekly, manual | OpenSSF Scorecard: grades pinning, token permissions, branch protection, review and the rest of the supply chain, uploads findings to code scanning and publishes the score behind the README badge |
| [`codeql.yml`](codeql.yml) | push to `main` or `dev`, PRs into either, weekly, manual | Static security and quality analysis of the TypeScript sources and of the workflows themselves (CodeQL's `actions` language) |
| [`dependency-review.yml`](dependency-review.yml) | PRs into `main` or `dev` | Blocks high or critical vulnerabilities in dependency changes. Warns, and does not fail, when Dependency graph is off |
| [`ci-triage.yml`](ci-triage.yml) | completion of CI, CodeQL or Dependency review on a PR | One self-updating comment per PR naming the failed job, the failed step and its likely cause, plus a `ci-failed` label. Reads the API only and never runs PR code. Active once on `main` |
| [`source-health.yml`](source-health.yml) | hourly, manual | Calls the real vendor endpoints and keeps one `source-health` issue open per broken collector, closing it on recovery. With the `PRODUCTION_URL` repository variable set, also checks the production board's `/readyz` and keeps one `deploy-health` issue open while it is not 200 |
| [`screenshot.yml`](screenshot.yml) | manual, PRs that change it | Builds and runs the board where the vendors are reachable, captures it with live data, and uploads `board-screenshot` for the README's `docs/board.png` |
| [`release.yml`](release.yml) | every push to `main`; Run workflow; a `vX.Y.Z` tag | Releases what reaches `main`; merges into `dev` never release. The Conventional Commits since the last tag pick the version (breaking → major, `feat` → minor, `fix`/`perf`/`revert` → patch, anything else → no release). Checks the release is on `main`, has a `CHANGELOG.md` section and passes typecheck, tests and build, then commits the version bump to `main`, tags it and publishes the GitHub Release. Run workflow also takes a manual bump, or a `version` and `commit` to backfill an older release. Merges `main` back into `dev`, and when that merge moves `dev`, starts `deploy.yml` on it too (the merge push itself starts no workflow) |
| [`deploy.yml`](deploy.yml) | push to `main` or `dev`, PRs into either, `release.yml` after it syncs `dev`, manual | Builds the Worker for Cloudflare: each Worker isolate collects on request and caches in memory. Every build runs the Worker in workerd; a PR also runs a credential-free `wrangler deploy --dry-run`. A push deploys `dev` to the `staging` environment and `main` to `production`, then smoke-tests it (`scripts/ci/smoke.sh --expect-version --require-ready --ready-wait 60`: once the version wrangler reported answers in `X-Worker-Version`, a board still stale or all-Unknown after collection fails too) and rolls back to the previous version if it fails, waiting until the failed version stops answering. The API token is an environment secret, seen only by the deploy and rollback steps, in a job that installs with `--ignore-scripts`, verifies that install's npm signatures and runs no build or project JavaScript |
| [`pr-title.yml`](pr-title.yml) | PRs into `main` or `dev`, including title edits | The PR title is a Conventional Commit. A squash merge makes it the commit that `release.yml` reads once it reaches `main` |
| [`base-images.yml`](base-images.yml) | PRs that change `compose.yaml`, its script or the dependencies; weekly; manual | Runs `compose.yaml` against the real `ci-node22`, `ci-node24` and `ci-security` images, so a base-image change that breaks this repository shows up here first |

Jobs that need Node use the shared [`../actions/setup`](../actions/setup/action.yml) action: Node from `.nvmrc` (or a given version), npm pinned to `packageManager`, `npm ci` and `npm audit signatures`. `deploy.yml` and `release.yml` install explicitly instead, so the workflows that publish can be read on their own, and the release gate never restores a shared cache.

Every check in `ci.yml` has a local equivalent:

```bash
npm ci && npm run check   # lint, typecheck, tests, hygiene and links
npm run test:coverage     # unit tests against the coverage thresholds
npm run build && npm run test:e2e   # browser tests; `npx playwright install chromium` once
./scripts/ci/hygiene.sh  # line endings, trailing whitespace, final newline, no `any`, no raw hex
actionlint && uvx zizmor .github   # the workflow lint job: syntax, then a security audit
./scripts/ci/links.sh    # relative links in the Markdown docs
./scripts/ci/smoke.sh http://127.0.0.1:4173   # after `npm run preview`: the smoke test CI and the deploy run
./scripts/ci/commits.sh origin/dev..HEAD   # origin/main..HEAD for a fix branched from main
./scripts/ci/commits.sh --subject "feat: add a feed"   # a PR title, as pr-title.yml checks it
./scripts/ci/branch.sh "$(git branch --show-current)"   # the branch name, as CI checks it
./scripts/release/next.sh level "v$(node -p "require('./package.json').version")..origin/dev"   # the bump merging dev into main would release
./scripts/ci/release-notes.sh           # the CHANGELOG.md section release.yml would publish
node --experimental-strip-types scripts/ci/source-health.ts   # live vendor check, exits 1 on any failure
```
