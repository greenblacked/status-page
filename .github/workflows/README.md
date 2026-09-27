# Workflows

| Workflow | Trigger | What it guards |
| --- | --- | --- |
| [`ci.yml`](ci.yml) | push to `main` or `dev` (not the commits `release.yml` pushes, which start no workflow), PRs into either, manual | Typecheck, tests, build and SSR smoke (`scripts/ci/smoke.sh`) on the Node version pinned in `.nvmrc` and on Node 24; repository hygiene, documentation links, shell scripts, commit messages, branch name, workflow syntax |
| [`codeql.yml`](codeql.yml) | push to `main` or `dev`, PRs into either, weekly, manual | Static security and quality analysis of the TypeScript sources |
| [`dependency-review.yml`](dependency-review.yml) | PRs into `main` or `dev` | Blocks high or critical vulnerabilities in dependency changes. Warns, and does not fail, when Dependency graph is off |
| [`ci-triage.yml`](ci-triage.yml) | completion of CI, CodeQL or Dependency review on a PR | One self-updating comment per PR naming the failed job, the failed step and its likely cause, plus a `ci-failed` label. Reads the API only and never runs PR code. Active once on `main` |
| [`source-health.yml`](source-health.yml) | hourly, manual | Calls the real vendor endpoints and keeps one `source-health` issue open per broken collector, closing it on recovery. With the `PRODUCTION_URL` repository variable set, also checks the production board's `/readyz` and keeps one `deploy-health` issue open while it is not 200 |
| [`screenshot.yml`](screenshot.yml) | manual, PRs that change it | Builds and runs the board where the vendors are reachable, captures it with live data, and uploads `board-screenshot` for the README's `docs/board.png` |
| [`release.yml`](release.yml) | every push to `main`; Run workflow; a `vX.Y.Z` tag | Releases what reaches `main`; merges into `dev` never release. The Conventional Commits since the last tag pick the version (breaking → major, `feat` → minor, `fix`/`perf`/`revert` → patch, anything else → no release). Checks the release is on `main`, has a `CHANGELOG.md` section and passes typecheck, tests and build, then commits the version bump to `main`, tags it and publishes the GitHub Release. Run workflow also takes a manual bump, or a `version` and `commit` to backfill an older release. Merges `main` back into `dev`, and when that merge moves `dev`, starts `deploy.yml` on it too (the merge push itself starts no workflow) |
| [`deploy.yml`](deploy.yml) | push to `main` or `dev`, PRs into either, `release.yml` after it syncs `dev`, manual | Builds the Worker for Cloudflare: a Cron Trigger collects the board every two minutes into a KV namespace, and requests only read it. Every build runs the Worker in workerd and fires its Cron Trigger once (`scripts/ci/smoke.sh --cron`); a PR also runs a credential-free `wrangler deploy --dry-run`. A push deploys `dev` to the `staging` environment and `main` to `production`, then smoke-tests it (`scripts/ci/smoke.sh --require-ready`, so a stale or all-Unknown board fails too) and rolls back to the previous version if it fails. The API token is an environment secret, seen only by the deploy and rollback steps, in a job that installs with `--ignore-scripts` and runs no build or project JavaScript |
| [`pr-title.yml`](pr-title.yml) | PRs into `main` or `dev`, including title edits | The PR title is a Conventional Commit. A squash merge makes it the commit that `release.yml` reads once it reaches `main` |
| [`base-images.yml`](base-images.yml) | PRs that change `compose.yaml`, its script or the dependencies; weekly; manual | Runs `compose.yaml` against the real `ci-node22`, `ci-node24` and `ci-security` images, so a base-image change that breaks this repository shows up here first |

Every check in `ci.yml` has a local equivalent:

```bash
npm ci && npm run typecheck && npm test && npm run build
./scripts/ci/hygiene.sh  # line endings, trailing whitespace, final newline, no `any`, no raw hex
./scripts/ci/links.sh    # relative links in the Markdown docs
./scripts/ci/smoke.sh http://127.0.0.1:4173   # after `npm run preview`: the smoke test CI and the deploy run
./scripts/ci/commits.sh origin/dev..HEAD   # origin/main..HEAD for a fix branched from main
./scripts/ci/commits.sh --subject "feat: add a feed"   # a PR title, as pr-title.yml checks it
./scripts/ci/branch.sh "$(git branch --show-current)"   # the branch name, as CI checks it
./scripts/release/next.sh level "v$(node -p "require('./package.json').version")..origin/dev"   # the bump merging dev into main would release
./scripts/ci/release-notes.sh           # the CHANGELOG.md section release.yml would publish
node --experimental-strip-types scripts/ci/source-health.ts   # live vendor check, exits 1 on any failure
```
