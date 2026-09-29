# Contributing to Status Page

Two documents govern how work lands in this repository:

1. This file — what to change, how to send it, and how authorship works
2. [docs/git-and-readme.md](docs/git-and-readme.md) — commit messages and README structure

Please read both before opening a pull request.

## Authorship

Commits must be attributed to a **real GitHub account**, never to a generic bot identity.

- Configure `user.name` and `user.email` to match the GitHub account that owns the commit
- Do not rewrite history to hide a human author or to invent one
- Add `Co-authored-by: Name <email>` only for people who actually wrote the change
- Do not add `Co-authored-by` for an AI tool unless the project later adopts that convention in writing

The GitHub account that pushes is the author of record.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(cs2): surface Europe datagram pops with relay counts
fix(aws): ignore Health events older than 14 days
docs: add official source table to README
```

Rules:

- Imperative mood (“add”, not “added”)
- Subject ≤ 72 characters, no trailing period
- One logical change per commit
- Body explains *why* when the diff is not obvious
- Never commit secrets, `.env` files, or vendor credentials (Status Page does not need any)

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`.

## Branches

Two branches live on:

| Branch | Holds | Merges in | Releases |
| --- | --- | --- | --- |
| `dev` | The next release, as it is built | Pull requests from your branches, squash-merged | Never |
| `main` | What is released | `dev`, in a merge commit; urgent `fix/` branches | Every merge with a `feat`, `fix` or breaking change |

Branch from `dev`, and open the pull request into `dev`. Only a fix that cannot wait for the next release branches from `main` and goes straight into `main`.

Name the branch `<prefix>/<short-kebab-description>`:

| Prefix | Use for | Example |
| --- | --- | --- |
| `fb/` | Feature: new capability | `fb/board-metrics-stars-shortcuts` |
| `fix/` | Bug | `fix/42-aws-stale-events` |
| `chore/` | Pins, tooling, housekeeping | `chore/bump-tanstack-start` |
| `docs/` | Documentation only | `docs/readme-integrations` |
| `ci/` | Workflow changes | `ci/cache-actionlint-image` |

- **The description** is two to five lowercase words joined by single hyphens, saying what changes. Use only `a-z`, `0-9` and `-`, and keep the whole name to 50 characters.
- **An issue number** goes first in the description when there is one: `fix/42-aws-stale-events`.
- **Refactors, tests, builds and performance work** use `chore/`, unless they fix a bug (`fix/`).
- **The prefix is not the commit type.** The pull request title is still a [Conventional Commit](#commits), and it picks the [release](#releases): an `fb/` branch has a `feat:` title.
- **Tooling names its own branches.** Dependabot opens `dependabot/…`, and [`scripts/release/bump.sh`](scripts/release/bump.sh) opens `release/vX.Y.Z`. Don't create either by hand.

The **branch name** job in [CI](.github/workflows/ci.yml) fails a pull request whose branch breaks these rules. Check a name before pushing:

```bash
./scripts/ci/branch.sh "$(git branch --show-current)"
```

| Not | Instead | Why |
| --- | --- | --- |
| `feature/Board_Metrics` | `fb/board-metrics` | One prefix per kind of change, lowercase, hyphens only |
| `fix-aws` | `fix/aws-stale-events` | The slash lets Git clients group branches, and the description says what is fixed |
| `username/readme` | `docs/readme-integrations` | Say what changes, not who changes it; the commit author already records who |
| `wip-2026-09-25` | `chore/pin-node-22` | A date says nothing about the change |

Rules:

- Branch from an up-to-date `dev` (or `main`, for an urgent fix), and open one pull request per branch.
- Bring the base branch (`dev`, or `main` for an urgent fix) in with a merge, not a rebase, once the branch is pushed. Others may have it checked out (see [docs/git-and-readme.md](docs/git-and-readme.md#authorship)).
- Keep the name when the work grows: a pull request cannot move to another branch, so renaming one means opening a new pull request.
- Delete the branch once it is merged.
- `main` and `dev` take changes only through pull requests, apart from what CI pushes: the release commit on `main`, and `main` merged back into `dev` after each release.

## Pull requests

- Keep the default branch green
- Describe the user-visible change in the PR body
- Link any issue
- Prefer small PRs that a reviewer can hold in their head
- Pick the issue form that fits when you open an issue: a card showing the wrong status, a bug, or a service request

## CI

Run `npm run check` before you push: lint, typecheck, unit tests, and the hygiene and link checks, the same commands CI runs. For the browser tests, build first and install Chromium and WebKit once:

```bash
npm run build
npx playwright install chromium webkit
npm run test:e2e
```

The tests run in five projects: `desktop` and `mobile` on Chromium, and `Desktop Safari`, `iPhone 17 Pro` and `iPad Pro 11` on WebKit, Safari's engine. Pick some with `--project`, for example `npm run test:e2e -- --project=desktop --project="iPhone 17 Pro"`. On Linux, WebKit needs system libraries: `npx playwright install --with-deps webkit` installs them. `PLAYWRIGHT_PORT` moves the preview the tests start off port 4173.

[`ci.yml`](.github/workflows/ci.yml) splits the work into one job per concern, so a red check names its cause: `lint`, `typecheck`, `test` and `build` (each on the pinned Node and on Node 24), `browser tests`, `commit messages`, `branch name` and `workflow lint`. Every job gets its toolchain from [`.github/actions/setup`](.github/actions/setup/action.yml): Node, the npm version in `packageManager`, `npm ci` and a registry signature check.

**`CI OK` is the one check to require.** It needs every job above and passes only when none of them failed or was cancelled (the commit and branch checks are skipped outside pull requests, which is fine). Requiring it alone means a renamed or added job never needs a branch protection change. In **Settings → Rules → Rulesets** (or **Branches**), for `main` and `dev`:

1. Require a pull request before merging.
2. Require status checks to pass: `CI OK`, `pull request title`, `analyze (javascript-typescript)`, `analyze (actions)` and `dependency-review`.
3. Optionally, require review from Code Owners ([`.github/CODEOWNERS`](.github/CODEOWNERS)) and turn on the merge queue: `ci.yml` already runs on `merge_group`.

Coverage has thresholds in [`vitest.config.ts`](vitest.config.ts), set just under the current numbers, so `npm run test:coverage` fails if coverage drops. When coverage goes up, raise them in the same pull request. The pinned-Node test job writes coverage to its summary and uploads the HTML report, and a failed browser test uploads the Playwright report with traces.

Workflows are linted by actionlint and audited by [zizmor](https://docs.zizmor.sh/). A deliberate exception carries a `# zizmor: ignore[<audit>]` comment with its reason on the same line.

## Releases

Status Page uses [Semantic Versioning](https://semver.org/). A version, its `vX.Y.Z` tag and its GitHub Release are made only when work reaches `main`. Before 1.0, a minor version adds services, features or health rules, and a patch fixes behavior without changing them.

Pull requests merge into `dev`, which never releases, so several of them can go out as one version. Every pull request with a user-visible change adds its lines under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Its title is a [Conventional Commit](#commits), because a squash merge makes the title the commit on `dev`, and that commit's type counts toward the next version.

To release, open a pull request from `dev` into `main` and merge it with **Create a merge commit**, never squash. A merge commit keeps every commit from `dev`, so the release sees each type and changelog line. A squash would leave only the release pull request's title, and a `chore:` title would release nothing. [`scripts/release/next.sh`](scripts/release/next.sh) shows what the merge would release:

```bash
git fetch origin && ./scripts/release/next.sh level "v$(git show origin/main:package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")..origin/dev"
```

The largest type among the commits since the last tag picks the version:

| Commit type on `main` | Release |
| --- | --- |
| `!` after the type, or a `BREAKING CHANGE:` footer | major |
| `feat` | minor |
| `fix`, `perf`, `revert` | patch |
| `docs`, `ci`, `build`, `chore`, `refactor`, `test`, `style` | none |

When a merge lands on `main`, [`release.yml`](.github/workflows/release.yml):

1. Reads every commit since the last tag and takes the largest bump ([`scripts/release/next.sh`](scripts/release/next.sh)). No feature, fix or breaking change means no release.
2. Checks the release:
   - the new tag doesn't exist yet;
   - typecheck, tests and build pass.
3. Commits `chore(release): X.Y.Z` to `main`, authored by the account that merged. The commit updates `package.json`, `package-lock.json` and the changelog, and turns `## [Unreleased]` into the dated `## [X.Y.Z]` section. If the pull request added nothing under Unreleased, the section is written from the merged commits' subjects instead.
4. Tags that commit `vX.Y.Z`.
5. Publishes the GitHub Release with that section as its notes.
6. Merges `main` back into `dev`, released or not, so `dev` carries the release commit and any fix merged into `main` directly. When that merge actually moves `dev`, it also starts [`deploy.yml`](.github/workflows/deploy.yml) on `dev` by hand: the merge is pushed with a token that starts no workflow of its own, so without this, staging would keep running the pre-release code until an unrelated push to `dev` redeployed it. A release on `main` while `dev` has lines under Unreleased (an urgent fix, usually) conflicts on `CHANGELOG.md`. The job resolves that case itself: it keeps `main`'s released section and puts `dev`'s lines back under Unreleased ([`scripts/release/merge-changelog.sh`](scripts/release/merge-changelog.sh)). Any other conflict fails the job, and you resolve it on a branch from `dev`:

   ```bash
   git fetch origin
   git switch -c chore/sync-main origin/dev
   git merge origin/main        # resolve, then git commit
   git push -u origin chore/sync-main
   ```

   Open the pull request into `dev` and merge it with **Create a merge commit**, so `dev` keeps `main`'s history and the next sync is clean. Never resolve it on a pull request from `main` into `dev`: GitHub commits the resolution to `main`, which releases the unreleased work on `dev`. The branch name check rejects `main` as a head branch for that reason.

If a check fails, nothing is committed, tagged or published. When merges land close together, one run releases them together: GitHub keeps only the newest waiting run, and each run releases everything since the last tag. [`pr-title.yml`](.github/workflows/pr-title.yml) fails a pull request whose title is not a Conventional Commit, since such a merge would release nothing.

Other ways in, with the same checks:

| Way | When |
| --- | --- |
| **Run workflow** with bump `patch`, `minor` or `major` | A release by hand, for merged changes whose types release nothing, such as a `refactor` worth shipping. It needs lines under Unreleased. `gh workflow run release.yml --ref main -f bump=patch` |
| **Run workflow** with bump `current` | Publishes the `package.json` version as it is, if it has no tag yet. Use it to retry a run that committed the bump but did not publish. |
| [`scripts/release/bump.sh`](scripts/release/bump.sh) `minor` | Makes the same bump commit locally on `release/vX.Y.Z` for review in a pull request. Merging it releases that version as it is. |
| **Run workflow** with `version` and `commit` | Backfills an older release: tags that commit on `main` with a version whose section is already in `main`'s changelog, and publishes it without marking it Latest. `gh workflow run release.yml --ref main -f version=0.1.1 -f commit=4cf30fd` |
| A tag pushed by hand | `git tag -a v0.4.0 -m "Status Page 0.4.0" && git push origin v0.4.0` publishes that tag, if it matches `package.json` and is on `main`. |

The bump commit and the tag are pushed with the workflow's `GITHUB_TOKEN`, so they start no other workflow and CI does not run on the bump commit itself. The verify job has already checked the same code.

If `main` or `dev` later gets a ruleset that requires pull requests or status checks, the workflow's direct pushes to it are rejected unless GitHub Actions is a bypass actor. Until that is set up, release with `bump.sh` and a pull request, and merge `main` into `dev` with a pull request.

Never move or reuse a tag that has a published release; release a new patch version instead.

## Deploying

[`deploy.yml`](.github/workflows/deploy.yml) builds the board for [Cloudflare Workers](https://developers.cloudflare.com/workers/) and deploys it with wrangler:

| Branch | Environment | Worker | Address |
| --- | --- | --- | --- |
| `dev` | `staging` | `status-bar-staging` | its `workers.dev` address |
| `main` | `production` | `status-bar` | [status.szolotov.com](https://status.szolotov.com) |

Every push to `dev` or `main` deploys, and `release.yml` also starts a staging deploy after it merges `main` back into `dev` (that merge is pushed with a token that starts no workflow of its own). A pull request builds the Worker and runs `wrangler deploy --dry-run`, with no credentials. Every build, pull request or push, also runs the built Worker in workerd with an empty local KV namespace, fires its Cron Trigger once and checks that the snapshot moves forward (`scripts/ci/smoke.sh --cron`), so a Worker whose scheduled handler throws never reaches a deploy. A deploy whose smoke test fails is rolled back to the previous version automatically, and the job still fails so it shows up. The smoke test first waits until `/healthz` carries the `X-Worker-Version` that `wrangler deploy` reported, so it tests the new version rather than the old one still answering somewhere, and after a rollback the job waits until `/healthz` no longer names the failed version. The page, API and feed checks fail within about half a minute, but `/readyz` gets five minutes to turn `200`: a deploy can be the fix for a board that is already stale (the previous version's cron was broken, say), and it only turns ready once the new version's first cron tick (up to 2 minutes away), its sweep, KV's propagation to other locations (up to about a minute) and the isolate's 5-second memo are behind it, about 3.5 minutes in all. Rolling that deploy back as stale would put the broken version back for good. `deploy.yml`'s smoke-test step has the numbers. The Worker has no secrets of its own: it only reads the public vendor feeds, on a schedule, into its own KV namespace. The staging Worker is public but kept out of search engines: `wrangler.jsonc`'s `env.staging.vars` sets `ROBOTS=noindex`, so every response it makes carries `X-Robots-Tag: noindex, nofollow` and its `/robots.txt` disallows everything; production and the Node build serve `Allow: /`. Every response the Worker makes, on either environment, carries `X-Worker-Version: <version id>` from the `version_metadata` binding (`CF_VERSION_METADATA`, repeated under `env.staging` because bindings are not inherited), so you can see which deployed version answered: `curl -sI https://<your-host>/healthz | grep -i x-worker-version`, against `npx wrangler deployments list`. The Node build sends no such header.

### How the board stays fresh on Workers

Cloudflare runs many isolates across many locations, so a Worker cannot keep the Node build's in-memory cache: each isolate would sweep every vendor itself, and a "Refresh" click would only throttle that one isolate. Instead, a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) (`wrangler.jsonc`'s `triggers.crons`, every 2 minutes) is the only thing that reads the vendors: it collects the board and writes it to a KV namespace (binding `STATUS_SNAPSHOT`), and every request - the page, `/api/status.json`, `/feed.xml`, the badges, `/metrics` - only ever reads that snapshot (`src/lib/status/board.cloudflare.ts`, `src/lib/status/cron-sweep.ts`). The **Refresh** button reads the same snapshot rather than forcing a sweep: a synchronous sweep of every vendor on the request path risks the CPU-time limit a single request gets, and the cron already runs every two minutes from everywhere the board is opened. A request collects anything itself only in two cases. One is a cold KV namespace right after a fresh deploy, before the first cron tick; that one collection is stored through `ctx.waitUntil` so it is not lost if the Worker is torn down right after the response. The other is KV itself failing (an error, not an empty or unreadable value): the isolate logs `{"event":"kv_read_failed"}` and keeps serving the board it already has for a minute before asking KV again, as long as that board stays under `/readyz`'s ten-minute limit meanwhile. Only an isolate with no board, or one about to go stale, collects the board itself, once for all the requests waiting on it, and never writes it to KV, which the cron owns. If that collect fails too, an isolate that has shown a board keeps showing it, and one that has not answers `503` with `Retry-After` on `/api/status.json`, `/feed.xml`, the badges and `/metrics` (`src/lib/status/board-response.ts`, the same on the Node build).

Every cron run ends in one JSON log line in Workers Logs: `{"event":"sweep_completed","durationMs":…,"services":14,"unknown":…,"bytes":…,"skipped":false}`, or `{"event":"sweep_failed","message":…}` (the run then also shows as failed under the Worker's cron events). `skipped: true` is a run that landed within 15 seconds of the last snapshot and reused it. A stream of `sweep_failed`, or `unknown` equal to `services`, is a board that has stopped updating while every request still answers.

This needs its own server entry (`src/server.cloudflare.ts`, named directly in `wrangler.jsonc`'s `main`): Workers module syntax wants a `scheduled` export next to `fetch`, and both need the KV binding and `ExecutionContext.waitUntil` that only workerd's own call to them provides. The Node build (`npm run build` without `DEPLOY_TARGET`) is unaffected: it keeps TanStack Start's default entry and `src/lib/status/board.ts`'s in-memory cache, and never resolves the Workers-only files - `vite.config.ts`'s `resolve.alias` for `@/lib/status/board` is what picks between them, keyed on `DEPLOY_TARGET`.

### How the token is kept safe

The repository is public, so anyone can read the workflow and open a pull request. The Cloudflare API token is still reachable only by the deploy job for `dev` and `main`:

- **It is an environment secret, not a repository secret.** GitHub hands it only to a job that names the `staging` or `production` environment, and each environment admits one branch.
- **Pull requests never get it,** from forks or not. The workflow has no `pull_request_target`, so pull request code never runs with secrets or a write token.
- **Nothing but wrangler runs beside it.** The job that holds the token installs with `npm ci --ignore-scripts`, so no dependency install script runs there, and checks that install with `npm audit signatures`, so the wrangler that runs beside the token is the one the registry signed. It also runs no build, no npm script and no project JavaScript: it only uploads what the build job made (`no_bundle`), and only its deploy and rollback steps see the token. The repository files it runs are two shell scripts from the same protected branch as the deploy, each in a step without the token: [`scripts/ci/audit-signatures.sh`](scripts/ci/audit-signatures.sh), which retries the signature check only when npm cannot load a verification key, and the post-deploy smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh) (bash, curl and jq).
- **It can do one thing.** The token is scoped to Workers on one account, plus the Workers routes of one zone, and expires.
- **Nothing in the repository names the account.** `wrangler.jsonc` has no `account_id`; the workflow passes `CLOUDFLARE_ACCOUNT_ID` from the environment. Local secrets (`.dev.vars*`) and wrangler's state (`.wrangler`) are git-ignored.

### One-time setup

1. **Create the token.** In the Cloudflare dashboard, go to **My Profile → API Tokens → Create Token** and start from **Edit Cloudflare Workers**. Trim it to what `wrangler deploy` and `wrangler rollback` need:
   - **Account resources:** only this account.
   - **Permissions:** Account · Workers Scripts · Edit, and Account · Account Settings · Read. The Worker's KV binding needs no token permission: `wrangler deploy` only records which namespace to bind. If a deploy is ever refused with a KV authorization error, add Account · Workers KV Storage · Edit.
   - **Custom domain:** production answers on `status.szolotov.com` (`routes` in `wrangler.jsonc`), so add Zone · Workers Routes · Edit and Zone · Zone · Read for the `szolotov.com` zone only, and nothing else. `wrangler deploy` needs the read permission to look the zone up by name. The first production deploy creates the DNS record and certificate. Check that `status.szolotov.com` has no DNS record first: a deploy from CI replaces an existing A, AAAA or TXT record without asking.
   - **TTL:** set an end date, and rotate the token before it.

   Cloudflare renames these permissions from time to time, so check the list against [Cloudflare's token docs](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) when you create it.
2. **Create a KV namespace for each Worker**, signed in as yourself rather than with the CI token, and keep the two ids for step 4:

   ```bash
   npx wrangler login
   npx wrangler kv namespace create status-bar-snapshot           # production
   npx wrangler kv namespace create status-bar-snapshot-staging   # staging
   ```

   The ids are not secrets, but they are per environment, so they live in GitHub next to the account id rather than in `wrangler.jsonc`, whose placeholder only local previews use. Automatic provisioning (a binding with no `id`, created on first deploy) is experimental in this wrangler version, so this is a one-time step.
3. **Create the two environments.** In **Settings → Environments**, add `staging` and `production`. For each, set **Deployment branches and tags** to **Selected branches**, and add only `dev` or only `main`. Optionally, add yourself as a **Required reviewer** on `production`, so every production deploy waits for your approval.
4. **Give each environment its settings.** Add the secret `CLOUDFLARE_API_TOKEN`, the variables `CLOUDFLARE_ACCOUNT_ID` and `KV_NAMESPACE_ID` (that environment's namespace from step 2), and, after the first deploy, `DEPLOY_URL` (the address the Worker answers on: `https://status.szolotov.com` for production, the `workers.dev` URL for staging; the job then smoke-tests it with `scripts/ci/smoke.sh --require-ready` and rolls back automatically if it fails, including when `/readyz` still says the board is stale or every source is unreadable five minutes after the new version answers). Without `KV_NAMESPACE_ID` the deploy stops before touching Cloudflare; without `DEPLOY_URL` it logs a warning and skips the smoke test and rollback.
5. **Watch production between deploys.** Set the *repository* variable `PRODUCTION_URL` (**Settings → Secrets and variables → Actions → Variables**, not an environment's) to the production board's `https://` address. `source-health.yml` then checks its `/readyz` every hour and keeps one issue labelled `deploy-health` open while it is not `200`, closing it on recovery: that catches a Cron Trigger that stopped, or a Worker that cannot reach the vendors, which no deploy-time check sees. Without it the job only logs a notice. `gh variable set PRODUCTION_URL --repo greenblacked/status-page --body "https://<your-host>"` does the same.

The same with the GitHub CLI:

```bash
repo=greenblacked/status-page
for pair in staging:dev production:main; do
  env="${pair%%:*}" branch="${pair##*:}"
  gh api -X PUT "repos/$repo/environments/$env" \
    -F 'deployment_branch_policy[protected_branches]=false' \
    -F 'deployment_branch_policy[custom_branch_policies]=true'
  gh api -X POST "repos/$repo/environments/$env/deployment-branch-policies" -f name="$branch" -f type=branch
  gh secret set CLOUDFLARE_API_TOKEN --repo "$repo" --env "$env"   # paste the token when asked
  gh variable set CLOUDFLARE_ACCOUNT_ID --repo "$repo" --env "$env" --body "<your account id>"
  gh variable set KV_NAMESPACE_ID --repo "$repo" --env "$env" --body "<this environment's namespace id>"
done
```

### Locally

| Command | Runs | What it does |
| --- | --- | --- |
| `npm run build:cf` | `DEPLOY_TARGET=cloudflare vite build` | The production Worker in `dist/` |
| `npm run preview:cf` | `DEPLOY_TARGET=cloudflare vite preview --host 127.0.0.1` | Runs that build in workerd, Cloudflare's runtime, with a local, simulated KV namespace |
| `npm run deploy:dry-run` | `WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --config dist/server/wrangler.json` | Shows what would upload, as a pull request's CI does |
| `npm run build:cf:staging` | `DEPLOY_TARGET=cloudflare CLOUDFLARE_ENV=staging vite build` | The staging Worker |

Without `DEPLOY_TARGET`, `npm run build` stays a plain Fetch handler, and `npm run preview` runs it on Node, as CI's smoke test does.

These scripts set their variables inline (`VAR=value command`), and `npm run check` calls the `scripts/ci/*.sh` checks, so they assume a POSIX shell. On Windows, npm runs scripts with `cmd.exe` even from a Git Bash window, and that syntax fails there: work in WSL, or point npm at Git Bash once with `npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`.

CI and the deploy share one smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh): `/healthz`, the page and its security headers, `/api/status.json` with every service, `/feed.xml`, `/metrics` and `/readyz`. Run it against any running board:

```bash
./scripts/ci/smoke.sh http://127.0.0.1:4173                    # /readyz may be 503 when the vendors are unreachable
./scripts/ci/smoke.sh https://<your-host> --require-ready      # /readyz must be 200 right now
./scripts/ci/smoke.sh https://<your-host> --expect-version <id> --wait 120 --attempts 3 --require-ready --ready-wait 300   # what the deploy checks
```

`--expect-version` takes a Worker version id (`npx wrangler deployments list`, or the `Current Version ID:` line `wrangler deploy` prints) and fails if `/healthz` still comes from another version when `--wait` runs out, then requires the same `X-Worker-Version` on every response it checks. `--attempts` retries the page, API and feed checks 10 seconds apart; `--ready-wait` separately gives `/readyz` that many seconds, checked every 10, to turn `200` under `--require-ready`. The deploy job reads the id from the `deploy` line wrangler writes to `WRANGLER_OUTPUT_FILE_PATH`, and stops with an error, before the smoke test, if there is none.

`npm run preview:cf`'s local Worker starts with an empty KV namespace, so the first request collects the board itself (How the board stays fresh on Workers, above) and every request after that reads what it stored. To run the Cron Trigger itself locally rather than waiting up to 2 minutes, use the Local Explorer API it prints on start:

```bash
curl -X POST "http://127.0.0.1:4173/cdn-cgi/local/explorer/api/local/scheduled?worker=status-bar" \
  -H 'Content-Type: application/json' -d '{"cron":"*/2 * * * *"}'
```

For a `CLOUDFLARE_ENV=staging` build, the Worker is `status-bar-staging`. Run `vite preview` without `CLOUDFLARE_ENV` either way: the built `dist/server/wrangler.json` already is that environment's config, and naming it again registers the Worker as `status-bar-staging-staging`. `./scripts/ci/smoke.sh http://127.0.0.1:4173 --cron status-bar` does all of this and checks the result, as the deploy workflow's build job does. The build also leaves `.wrangler/deploy/config.json`, which `vite preview` needs; delete only `.wrangler/state` to start again from an empty KV namespace.

### Rolling back

`deploy.yml` already does this by itself when a deploy fails its smoke test (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` reach only that one rollback step, same as the deploy step). To go back to the previous version by hand:

```bash
npx wrangler rollback --name status-bar          # or status-bar-staging
```

You can also use **Workers & Pages → status-bar → Deployments** in the dashboard, or revert the commit so the next push deploys the fix. A rollback lasts until the next deploy from `main`. Rolling back only changes which Worker version answers requests: it does not touch the KV namespace, so the board keeps whatever the Cron Trigger last wrote regardless of which version is live. To see which version is answering, `curl -sI https://<your-host>/healthz | grep -i x-worker-version`; a version from before `X-Worker-Version` sends none.

## Dependencies

Dependabot proposes npm and GitHub Actions updates weekly, grouped into production dependencies, development dependencies and Actions.

- Actions stay pinned to a full commit SHA with the version in a trailing comment
- A new release is proposed only after a cooldown, 7 days for npm and 3 for Actions, so a hijacked release that is pulled within days never reaches the lockfile. Security updates are not held back
- Every install in CI and in the deploy workflow (its build, its dry run and the deploy job that holds the token) runs `npm audit signatures` right after `npm ci`, so a tarball that does not match the registry's signature fails the run
- `@types/node` must match the oldest supported Node (`engines` and `.nvmrc`), so Dependabot skips its major versions. Raise it by hand in the same PR that raises `engines`

## Adding a service

1. Add a catalog entry in `src/lib/status/catalog.ts`
2. Add a collector in `src/lib/status/sources.server.ts`, and call it from `collectAllServices` at the same position as its catalog entry. A test in `src/lib/status/collectors.test.ts` fails until the two lists match
3. Use an **official** machine-readable source (Statuspage JSON, vendor incident JSON, RSS, or a documented public API)
4. Document the source in the README table
5. Map vendor states onto `operational | degraded | outage | maintenance | unknown`
6. Test the collector against a trimmed payload in `src/lib/status/__fixtures__` ([how](src/lib/status/__fixtures__/README.md)), with one malformed payload that must read as `unknown`

Do not scrape unofficial aggregators.

## Code style

- [Biome](https://biomejs.dev/) formats, lints and sorts imports ([`biome.json`](biome.json)); `npm run lint:fix` applies it. A `biome-ignore` comment must say why
- TypeScript strict, no `any`
- No unused locals, imports or parameters: `tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so `npm run typecheck` fails on them. Prefix a parameter that a signature requires but the body ignores with `_`
- Tokens live in `src/styles.css`; do not sprinkle raw hex in JSX. Every colour token has a light and a dark value, written with `light-dark()`. The build compiles that into toggles keyed on the system's `prefers-color-scheme`, so the whole page follows the system and `color-scheme` on one element does not switch its tokens
- Text must clear 4.5:1 on every material's flat fill. A browser test proves it: on a fixture board with every state, incident times and the Stale badge ([`e2e/fixture-board.ts`](e2e/fixture-board.ts)), in light and dark, with and without Increase Contrast, it strips blur, gradients and pseudo-elements and runs axe's colour-contrast rule. It does not measure text over the aurora itself; the light aurora's colours are chosen to stay close to the page's brightness for that reason
- Design, Lucid Vigil: deep ink in dark (the hero appearance), warm paper in light, and colour rationed to small exact points
  - Status colour is for badge text, dots and the uptime strip's bad days only, never a fill across a badge, panel or card. Badges share one neutral fill and draw their own tone dot; a quiet day on the uptime strip is a neutral tick
  - `--color-event`, the warm amber, marks the one thing that just moved (the headline's ping, a card that just changed, the period dial's hand). It never carries a status by itself and never replaces `--color-down` on an Outage badge
  - Status, event and aurora colours are written once in OKLCH, with no separate Display P3 block. Keep status and text colours inside sRGB, so the contrast the tests measure is the contrast shown. Only the aurora may use colours beyond sRGB, and today one dark stop does
  - Type: the system faces only, no web font. Mono uppercase with wide tracking for labels, and `font-serif` italic for one short phrase (the empty board), nowhere else
  - The coordinate grid (`.aurora-grid`) is static: never animate it. It goes with the aurora under Reduce glass and under forced colours
  - The card index (01 to 14) follows the catalog order and is `aria-hidden`: decoration, never part of a name
- Three materials, and nothing else is translucent:
  - `.glass-chrome` for controls that float above the content (the compact header, the settings dialog), one on screen at a time
  - `.glass` for content panels (the summary, attention cards, the board log), a handful per screen
  - `.glass-whisper`, with no blur, for anything dense or repeated: tiles, chips, the search box
- Never glass on glass: inside a `.glass` or `.glass-chrome`, nest only `.glass-whisper` or `.glass-inset`
- Performance: no `will-change: backdrop-filter`, never animate a blur or a `filter`, and animate `transform` and `opacity` only. The one exception is a registered custom property on a small element, stepped so it repaints rarely, as the period dial does once a second. Blur stays at 24px for `.glass` and 28px for `.glass-chrome`
- Radii are concentric: a nested shape takes its parent's radius minus the inset between them, rounded down to the nearest `--radius-*` step (`rounded-2xs` to `rounded-xl`). Pills stay `rounded-full`, and Tailwind's default radius scale is switched off
- New motion goes in the `prefers-reduced-motion` block, and new translucency in the Reduce glass block, in `src/styles.css`
- Newer CSS is welcome where it degrades to something correct: `@starting-style` and `linear()` easing are used unconditionally, since a browser without them just skips the flourish. Container queries lay out the card grids, which stay a single column without them; every engine the board supports has had them since Safari 16 and Chrome 105. Anything whose absence would break layout or meaning, such as scroll-driven animations, goes behind `@supports` and stays decorative
- Card internals respond to the card's own width with container-query variants (`@xs:`), not the viewport's (`sm:`), since a card's width depends on the board log beside it
- Keep fetch timeouts short and failures isolated (`Promise.all` of per-service collectors)
