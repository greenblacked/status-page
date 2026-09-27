# Contributing to Status Bar

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
- Never commit secrets, `.env` files, or vendor credentials (Status Bar does not need any)

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

## Releases

Status Bar uses [Semantic Versioning](https://semver.org/). A version, its `vX.Y.Z` tag and its GitHub Release are made only when work reaches `main`. Before 1.0, a minor version adds services, features or health rules, and a patch fixes behavior without changing them.

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
| A tag pushed by hand | `git tag -a v0.4.0 -m "Status Bar 0.4.0" && git push origin v0.4.0` publishes that tag, if it matches `package.json` and is on `main`. |

The bump commit and the tag are pushed with the workflow's `GITHUB_TOKEN`, so they start no other workflow and CI does not run on the bump commit itself. The verify job has already checked the same code.

If `main` or `dev` later gets a ruleset that requires pull requests or status checks, the workflow's direct pushes to it are rejected unless GitHub Actions is a bypass actor. Until that is set up, release with `bump.sh` and a pull request, and merge `main` into `dev` with a pull request.

Never move or reuse a tag that has a published release; release a new patch version instead.

## Deploying

[`deploy.yml`](.github/workflows/deploy.yml) builds the board for [Cloudflare Workers](https://developers.cloudflare.com/workers/) and deploys it with wrangler:

| Branch | Environment | Worker |
| --- | --- | --- |
| `dev` | `staging` | `status-bar-staging` |
| `main` | `production` | `status-bar` |

Every push to `dev` or `main` deploys, and `release.yml` also starts a staging deploy after it merges `main` back into `dev` (that merge is pushed with a token that starts no workflow of its own). A pull request builds the Worker and runs `wrangler deploy --dry-run`, with no credentials. Every build, pull request or push, also runs the built Worker in workerd with an empty local KV namespace, fires its Cron Trigger once and checks that the snapshot moves forward (`scripts/ci/smoke.sh --cron`), so a Worker whose scheduled handler throws never reaches a deploy. A deploy whose smoke test fails is rolled back to the previous version automatically, and the job still fails so it shows up. The Worker has no secrets of its own: it only reads the public vendor feeds, on a schedule, into its own KV namespace. The staging Worker is public but kept out of search engines: `wrangler.jsonc`'s `env.staging.vars` sets `ROBOTS=noindex`, so every response it makes carries `X-Robots-Tag: noindex, nofollow` and its `/robots.txt` disallows everything; production and the Node build serve `Allow: /`.

### How the board stays fresh on Workers

Cloudflare runs many isolates across many locations, so a Worker cannot keep the Node build's in-memory cache: each isolate would sweep every vendor itself, and a "Refresh" click would only throttle that one isolate. Instead, a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) (`wrangler.jsonc`'s `triggers.crons`, every 2 minutes) is the only thing that reads the vendors: it collects the board and writes it to a KV namespace (binding `STATUS_SNAPSHOT`), and every request - the page, `/api/status.json`, `/feed.xml`, the badges, `/metrics` - only ever reads that snapshot (`src/lib/status/board.cloudflare.ts`, `src/lib/status/cron-sweep.ts`). The **Refresh** button reads the same snapshot rather than forcing a sweep: a synchronous sweep of every vendor on the request path risks the CPU-time limit a single request gets, and the cron already runs every two minutes from everywhere the board is opened. A request collects anything itself only in two cases. One is a cold KV namespace right after a fresh deploy, before the first cron tick; that one collection is stored through `ctx.waitUntil` so it is not lost if the Worker is torn down right after the response. The other is KV itself failing (an error, not an empty or unreadable value): the isolate logs `{"event":"kv_read_failed"}`, collects the board once, serves it for a minute before asking KV again, and never writes it to KV, which the cron owns. If that collect fails too, an isolate that has shown a board keeps showing it, and one that has not answers `503` with `Retry-After` on `/api/status.json`, `/feed.xml`, the badges and `/metrics` (`src/lib/status/board-response.ts`, the same on the Node build).

Every cron run ends in one JSON log line in Workers Logs: `{"event":"sweep_completed","durationMs":…,"services":14,"unknown":…,"bytes":…,"skipped":false}`, or `{"event":"sweep_failed","message":…}` (the run then also shows as failed under the Worker's cron events). `skipped: true` is a run that landed within 15 seconds of the last snapshot and reused it. A stream of `sweep_failed`, or `unknown` equal to `services`, is a board that has stopped updating while every request still answers.

This needs its own server entry (`src/server.cloudflare.ts`, named directly in `wrangler.jsonc`'s `main`): Workers module syntax wants a `scheduled` export next to `fetch`, and both need the KV binding and `ExecutionContext.waitUntil` that only workerd's own call to them provides. The Node build (`npm run build` without `DEPLOY_TARGET`) is unaffected: it keeps TanStack Start's default entry and `src/lib/status/board.ts`'s in-memory cache, and never resolves the Workers-only files - `vite.config.ts`'s `resolve.alias` for `@/lib/status/board` is what picks between them, keyed on `DEPLOY_TARGET`.

### How the token is kept safe

The repository is public, so anyone can read the workflow and open a pull request. The Cloudflare API token is still reachable only by the deploy job for `dev` and `main`:

- **It is an environment secret, not a repository secret.** GitHub hands it only to a job that names the `staging` or `production` environment, and each environment admits one branch.
- **Pull requests never get it,** from forks or not. The workflow has no `pull_request_target`, so pull request code never runs with secrets or a write token.
- **Nothing but wrangler runs beside it.** The job that holds the token installs with `npm ci --ignore-scripts`, so no dependency install script runs there. It also runs no build, no npm script and no project JavaScript: it only uploads what the build job made (`no_bundle`), and only its deploy and rollback steps see the token. The one repository file it runs is the post-deploy smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh) (bash, curl and jq, from the same protected branch as the deploy), in a step without the token.
- **It can do one thing.** The token is scoped to Workers on one account and expires.
- **Nothing in the repository names the account.** `wrangler.jsonc` has no `account_id`; the workflow passes `CLOUDFLARE_ACCOUNT_ID` from the environment. Local secrets (`.dev.vars*`) and wrangler's state (`.wrangler`) are git-ignored.

### One-time setup

1. **Create the token.** In the Cloudflare dashboard, go to **My Profile → API Tokens → Create Token** and start from **Edit Cloudflare Workers**. Trim it to what `wrangler deploy` and `wrangler rollback` need:
   - **Account resources:** only this account.
   - **Permissions:** Account · Workers Scripts · Edit, and Account · Account Settings · Read. The Worker's KV binding needs no token permission: `wrangler deploy` only records which namespace to bind. If a deploy is ever refused with a KV authorization error, add Account · Workers KV Storage · Edit.
   - **Custom domain:** add Zone · Workers Routes · Edit for that zone only, and nothing else.
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
4. **Give each environment its settings.** Add the secret `CLOUDFLARE_API_TOKEN`, the variables `CLOUDFLARE_ACCOUNT_ID` and `KV_NAMESPACE_ID` (that environment's namespace from step 2), and, after the first deploy, `DEPLOY_URL` (the Worker's URL; the job then smoke-tests it with `scripts/ci/smoke.sh --require-ready` and rolls back automatically if it fails, including when `/readyz` says the board is stale or every source is unreadable). Without `KV_NAMESPACE_ID` the deploy stops before touching Cloudflare; without `DEPLOY_URL` it logs a warning and skips the smoke test and rollback.
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

```bash
DEPLOY_TARGET=cloudflare npm run build            # the production Worker in dist/
DEPLOY_TARGET=cloudflare npx vite preview         # runs it in workerd, Cloudflare's runtime, with a local, simulated KV namespace
npx wrangler deploy --dry-run --config dist/server/wrangler.json   # what would upload
DEPLOY_TARGET=cloudflare CLOUDFLARE_ENV=staging npm run build      # the staging Worker
```

Without `DEPLOY_TARGET`, `npm run build` stays a plain Fetch handler, and `npm run preview` runs it on Node, as CI's smoke test does.

CI and the deploy share one smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh): `/healthz`, the page and its security headers, `/api/status.json` with every service, `/feed.xml`, `/metrics` and `/readyz`. Run it against any running board:

```bash
./scripts/ci/smoke.sh http://127.0.0.1:4173                    # /readyz may be 503 when the vendors are unreachable
./scripts/ci/smoke.sh https://<your-host> --require-ready      # what the deploy checks
```

`vite preview`'s local Worker starts with an empty KV namespace, so the first request collects the board itself (How the board stays fresh on Workers, above) and every request after that reads what it stored. To run the Cron Trigger itself locally rather than waiting up to 2 minutes, use the Local Explorer API `vite preview` prints on start:

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

You can also use **Workers & Pages → status-bar → Deployments** in the dashboard, or revert the commit so the next push deploys the fix. A rollback lasts until the next deploy from `main`. Rolling back only changes which Worker version answers requests: it does not touch the KV namespace, so the board keeps whatever the Cron Trigger last wrote regardless of which version is live.

## Dependencies

Dependabot proposes npm and GitHub Actions updates weekly, grouped into production dependencies, development dependencies and Actions.

- Actions stay pinned to a full commit SHA with the version in a trailing comment
- A new release is proposed only after a cooldown, 7 days for npm and 3 for Actions, so a hijacked release that is pulled within days never reaches the lockfile. Security updates are not held back
- CI and the deploy build run `npm audit signatures` right after `npm ci`, so a tarball that does not match the registry's signature fails the run
- `@types/node` must match the oldest supported Node (`engines` and `.nvmrc`), so Dependabot skips its major versions. Raise it by hand in the same PR that raises `engines`

## Adding a service

1. Add a catalog entry in `src/lib/status/catalog.ts`
2. Add a collector in `src/lib/status/sources.server.ts`
3. Use an **official** machine-readable source (Statuspage JSON, vendor incident JSON, RSS, or a documented public API)
4. Document the source in the README table
5. Map vendor states onto `operational | degraded | outage | maintenance | unknown`

Do not scrape unofficial aggregators.

## Code style

- TypeScript strict, no `any`
- Tokens live in `src/styles.css`; do not sprinkle raw hex in JSX
- Status color is for badges only, not entire panels
- Keep fetch timeouts short and failures isolated (`Promise.all` of per-service collectors)
