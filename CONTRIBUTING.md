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

Three branches live on, and only the owner moves work between them:

| Branch | Holds | Merges in | Deploys | Releases |
| --- | --- | --- | --- | --- |
| `dev` | The next release, as it is built | Pull requests from your branches, squash-merged | Nothing | Never |
| `stage` | What is being tried before it is released | `dev`, in a merge commit, by the owner | A Worker Preview named `stage`, at [stage.status.szolotov.com](https://stage.status.szolotov.com) | Never |
| `main` | What is released | `stage`, in a merge commit, by the owner | Production, at [status.szolotov.com](https://status.szolotov.com) | Every merge with a `feat`, `fix` or breaking change |

Branch from `dev`, and open the pull request into `dev`: every pull request targets `dev`, and `dev` never deploys, so a merge there reaches no address and no Cloudflare credential. The owner promotes the work: a pull request from `dev` into `stage` puts it on the preview, and once the preview is right, a pull request from `stage` into `main` releases it (see [Releases](#releases)). An urgent fix takes the same road and is promoted at once; there is no separate lane into `main`.

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

The **branch name** job in [CI](.github/workflows/ci.yml) fails a pull request whose branch breaks these rules. It also checks where the pull request goes: `main` takes only `stage` (and the `release/vX.Y.Z` branch that [`scripts/release/bump.sh`](scripts/release/bump.sh) opens), `stage` takes only `dev` (and `chore/sync-main`, see [Releases](#releases)), and `dev` takes everything else. `dev` and `stage` are accepted as head branches for those two promotions only, and never from a fork; `main` is never a head branch. A Dependabot security update opens against `main`, the default branch: change its base to `dev`. Check a name before pushing, with the base branch as a second argument for the full check:

```bash
./scripts/ci/branch.sh "$(git branch --show-current)" dev
```

| Not | Instead | Why |
| --- | --- | --- |
| `feature/Board_Metrics` | `fb/board-metrics` | One prefix per kind of change, lowercase, hyphens only |
| `fix-aws` | `fix/aws-stale-events` | The slash lets Git clients group branches, and the description says what is fixed |
| `username/readme` | `docs/readme-integrations` | Say what changes, not who changes it; the commit author already records who |
| `wip-2026-09-25` | `chore/pin-node-22` | A date says nothing about the change |

Rules:

- Branch from an up-to-date `dev`, and open one pull request per branch.
- Bring `dev` in with a merge, not a rebase, once the branch is pushed. Others may have it checked out (see [docs/git-and-readme.md](docs/git-and-readme.md#authorship)).
- Keep the name when the work grows: a pull request cannot move to another branch, so renaming one means opening a new pull request.
- Delete the branch once it is merged.
- `dev`, `stage` and `main` take changes only through pull requests, apart from what CI pushes: the release commit on `main`, and `main` merged back into `stage` and `dev` after each release.

### Branch protection

Branch protection lives in GitHub's settings, not in the code, so the owner sets it once. The recommended rulesets (**Settings → Rules → Rulesets**, target: branch) are the same for the three branches except for how a pull request may be merged:

| Setting | `dev` | `stage` | `main` |
| --- | --- | --- | --- |
| Require a pull request before merging | yes | yes | yes |
| Allowed merge methods | squash (merge commit only for `chore/sync-main`) | merge commit | merge commit |
| Required approvals | 0 while there is one maintainer | 0 | 0 |
| Require status checks to pass | `CI OK`, `pull request title`, `analyze (javascript-typescript)`, `analyze (actions)`, `dependency-review` | the same | the same |
| Require the branch to be up to date | no | no | no |
| Block force pushes | yes | yes | yes |
| Restrict deletions | yes | yes | yes |
| Restrict updates: only the bypass list may push or merge | yes | yes | yes |
| Require linear history | no | no | no |
| Bypass list | Repository admin (the owner), GitHub Actions | the same | the same |

Squash on `dev` keeps one commit per pull request, except for a `chore/sync-main` pull request, which needs a merge commit (see [Releases](#releases)), so `dev` allows both methods. The merge commits on `stage` and `main` keep every one of them, so the release reads each type and changelog line (see [Releases](#releases)). Linear history would forbid those merge commits. The bypass list has the owner, who promotes and merges, and GitHub Actions, because [`release.yml`](.github/workflows/release.yml) pushes the release commit to `main` and merges `main` back into `stage` and `dev`; without it those pushes are rejected. The repository settings **Allow merge commits** and **Allow squash merging** (**Settings → General → Pull Requests**) must both stay enabled, or a ruleset's allowed method has nothing to use. The owner's bypass is `always`, so the owner can push to a protected branch directly, and rulesets and checks apply to everyone else; set `bypass_mode` to `"pull_request"` for the owner (in `ruleset()` below, on the `RepositoryRole` actor) to make the owner use a pull request too. GitHub Actions keeps `always`. `CI OK` sums up the other CI jobs, so a renamed or added job never needs a protection change. Optionally turn on required review from Code Owners ([`.github/CODEOWNERS`](.github/CODEOWNERS)) or the merge queue: `ci.yml` already runs on `merge_group`.

The same three rulesets through the API, run once by the repository admin with the GitHub CLI signed in (`gh auth login`). The actor ids are GitHub's: role 5 is Repository admin, and integration 15368 is GitHub Actions.

```bash
ruleset() { # ruleset <branch> <merge methods, comma-separated: merge|squash>
  jq -n --arg branch "$1" --arg method "$2" '{
    name: ("protect " + $branch),
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/" + $branch], exclude: [] } },
    bypass_actors: [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: 15368, actor_type: "Integration", bypass_mode: "always" }
    ],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "update" },
      { type: "pull_request", parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ($method | split(",")) } },
      { type: "required_status_checks", parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            { context: "CI OK" },
            { context: "pull request title" },
            { context: "analyze (javascript-typescript)" },
            { context: "analyze (actions)" },
            { context: "dependency-review" } ] } }
    ]
  }' | gh api --method POST repos/greenblacked/status-page/rulesets --input -
}
ruleset main merge
ruleset stage merge
ruleset dev squash,merge
```

`gh api repos/greenblacked/status-page/rulesets` lists them, and `gh api --method DELETE repos/greenblacked/status-page/rulesets/<id>` removes one. Replace any older ruleset or branch rule on `dev` and `main` rather than stacking the two. The required checks can only be picked once they have run on the repository, and `analyze (…)` and `dependency-review` start on pull requests, so if GitHub refuses a name, open a pull request into the branch first.

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

**`CI OK` is the one check to require.** It needs every job above and passes only when none of them failed or was cancelled (the commit and branch checks are skipped outside pull requests, which is fine). Requiring it alone means a renamed or added job never needs a branch protection change. The same jobs run on pull requests into `dev`, `stage` and `main` and on pushes to each of them. In **Settings → Rules → Rulesets** each of the three requires a pull request and these status checks: `CI OK`, `pull request title`, `analyze (javascript-typescript)`, `analyze (actions)` and `dependency-review`. [Branch protection](#branch-protection) has the exact settings and the API commands.

Coverage has thresholds in [`vitest.config.ts`](vitest.config.ts), set just under the current numbers, so `npm run test:coverage` fails if coverage drops. When coverage goes up, raise them in the same pull request. The pinned-Node test job writes coverage to its summary and uploads the HTML report, and a failed browser test uploads the Playwright report with traces.

Workflows are linted by actionlint and audited by [zizmor](https://docs.zizmor.sh/). A deliberate exception carries a `# zizmor: ignore[<audit>]` comment with its reason on the same line.

## Releases

Status Page uses [Semantic Versioning](https://semver.org/). A version, its `vX.Y.Z` tag and its GitHub Release are made only when work reaches `main`. Before 1.0, a minor version adds services, features or health rules, and a patch fixes behavior without changing them.

Pull requests merge into `dev`, which never releases, so several of them can go out as one version. The owner promotes `dev` to `stage`, where the preview shows what would ship, and `stage` to `main`, which releases. Every pull request with a user-visible change adds its lines under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Its title is a [Conventional Commit](#commits), because a squash merge makes the title the commit on `dev`, and that commit's type counts toward the next version.

To release, the owner promotes in two steps, each a pull request merged with **Create a merge commit**, never squash:

1. `dev` into `stage`. The push to `stage` builds the Worker and updates the preview at [stage.status.szolotov.com](https://stage.status.szolotov.com) (see [Deploying](#deploying)); nothing is released.
2. `stage` into `main`, once the preview looks right.

A merge commit keeps every commit from `dev`, so the release sees each type and changelog line. A squash would leave only the promotion pull request's title, and a `chore:` title would release nothing. [`scripts/release/next.sh`](scripts/release/next.sh) shows what merging `stage` into `main` would release (use `origin/dev` to look ahead at what promoting all of `dev` would):

```bash
git fetch origin && ./scripts/release/next.sh level "v$(git show origin/main:package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")..origin/stage"
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
6. Merges `main` back into `stage` and then `dev`, released or not, so both carry the release commit and anything that reached `main` without going through `stage`, such as a `release/vX.Y.Z` bump. When that merge actually moves `stage`, it also starts [`deploy.yml`](.github/workflows/deploy.yml) on `stage` by hand: the merge is pushed with a token that starts no workflow of its own, so without this, the preview would keep running the pre-release code until an unrelated push to `stage` updated it. `dev` deploys nothing, so its merge needs no follow-up. A release on `main` while `stage` or `dev` has lines under Unreleased conflicts on `CHANGELOG.md`. The job resolves that case itself: it keeps `main`'s released section and puts the branch's lines back under Unreleased ([`scripts/release/merge-changelog.sh`](scripts/release/merge-changelog.sh)). Any other conflict fails the job, after it has tried the other branch, and you resolve it on a branch from the one that conflicted:

   ```bash
   git fetch origin
   git switch -c chore/sync-main origin/dev     # origin/stage for a conflict on stage
   git merge origin/main        # resolve, then git commit
   git push -u origin chore/sync-main
   ```

   Open the pull request into `dev` (or `stage`) and merge it with **Create a merge commit**, so the branch keeps `main`'s history and the next sync is clean. The branch name check accepts `chore/sync-main` into `stage` for this. Never resolve it on a pull request from `main` into `dev` or `stage`: GitHub commits the resolution to `main`, which releases the unreleased work. The branch name check rejects `main` as a head branch for that reason.

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

A ruleset on `main`, `stage` or `dev` that requires pull requests or status checks rejects the workflow's direct pushes to it (the release commit, and the merges of `main` back) unless GitHub Actions is a bypass actor; [Branch protection](#branch-protection) adds it. Without that, release with `bump.sh` and a pull request into `main`, and bring `main` into `stage` and `dev` through a `chore/sync-main` branch and pull request (see above).

Never move or reuse a tag that has a published release; release a new patch version instead.

## Deploying

[`deploy.yml`](.github/workflows/deploy.yml) builds the board for [Cloudflare Workers](https://developers.cloudflare.com/workers/) and deploys it with wrangler:

| Branch | Environment | Worker | Address |
| --- | --- | --- | --- |
| `dev` | none | Nothing deploys | none |
| `stage` | `staging` | `status-page` Worker Preview `stage` | [stage.status.szolotov.com](https://stage.status.szolotov.com) |
| `main` | `production` | `status-page` deploy | [status.szolotov.com](https://status.szolotov.com) |

There is one Worker, `status-page`. Every push to `stage` or `main` deploys; `dev`, where pull requests land, deploys nothing and never sees a Cloudflare credential. Pull requests into `dev`, `stage` and `main` build and dry-run the Worker without credentials. **Run workflow** deploys only `main` and `stage`: on any other branch, or on a tag, the first step fails at once and says so. The built Worker is also smoke-tested locally. A push to `main` runs `wrangler deploy`, which makes the new version the production Worker on its Custom Domain. A push to `stage` runs `wrangler preview --name stage`, which creates or updates a [Worker Preview](https://developers.cloudflare.com/workers/previews/) named `stage` of the same Worker: it never receives production traffic. A Preview takes its settings from the `previews` block of `wrangler.jsonc` (here `ROBOTS=noindex` and the version metadata binding), not from the top level. Its address is `https://stage.status.szolotov.com`: the production Custom Domain `status.szolotov.com` has `"previews_enabled": true` in `wrangler.jsonc`, so Cloudflare serves each Preview one level below it through the wildcard `*.status.szolotov.com`, which it creates itself. Each deployment also gets its own address, which `wrangler preview` prints. Preview addresses go live once a `wrangler deploy` on `main` has published that setting. A production deploy is checked against its `X-Worker-Version` header by the post-deploy smoke test, if `DEPLOY_URL` is configured, and is rolled back automatically when that test fails. A preview reports no version id to wait for, so its smoke test only checks that the address answers; a failed preview is not rolled back, since it never affects production. The preview answers `noindex`; production remains indexable.

### How the board stays fresh on Workers

Each Worker isolate collects the public vendor feeds on demand, shares a 45-second in-memory cache among its requests, serves a recently expired result while a new collection runs, and throttles forced refreshes to one per 15 seconds. A cold isolate can take several seconds to answer. Isolates do not share their cache, so traffic can cause more vendor requests than a shared store would. The 30-day uptime history is the exception: a Cron Trigger runs every five minutes, collects the board and adds one sample per service to a Cloudflare D1 database (`HISTORY_DB`), and `/api/history.json` reads it back, cached for five minutes per isolate. Node keeps no history and returns an empty document.

The Cloudflare entry in `src/server.cloudflare.ts` threads the preview's robots setting and version metadata into TanStack's request handler. It also handles the scheduled event and passes the D1 binding along. The Node and Worker builds both use `src/lib/status/board.ts`.

### How the token is kept safe

The repository is public, so anyone can read the workflow and open a pull request. The Cloudflare API token is still reachable only by the deploy job for `stage` and `main`, never for `dev`:

- **It is an environment secret, not a repository secret.** GitHub hands it only to a job that names the `staging` or `production` environment, and each environment admits one branch.
- **Pull requests never get it,** from forks or not. The workflow has no `pull_request_target`, so pull request code never runs with secrets or a write token.
- **Nothing but wrangler runs beside it.** The job that holds the token installs with `npm ci --ignore-scripts`, so no dependency install script runs there, and checks that install with `npm audit signatures`, so the wrangler that runs beside the token is the one the registry signed. It also runs no build, no npm script and no project JavaScript: it only uploads what the build job made (`no_bundle`), and only its deploy, preview and rollback steps see the token. The repository files it runs are two shell scripts from the same protected branch as the deploy, each in a step without the token: [`scripts/ci/audit-signatures.sh`](scripts/ci/audit-signatures.sh), which retries the signature check only when npm cannot load a verification key, and the post-deploy smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh) (bash, curl and jq).
- **It can do one thing.** The token is scoped to Workers on one account, plus (for the production deploy) the Workers routes of the `szolotov.com` zone and read access to it, and expires.
- **Nothing in the repository names the account.** `wrangler.jsonc` has no `account_id`; the workflow passes `CLOUDFLARE_ACCOUNT_ID` from the environment. Local secrets (`.dev.vars*`) and wrangler's state (`.wrangler`) are git-ignored.

### One-time setup

1. **Create a Cloudflare API token** scoped to this account and Workers Scripts Edit (plus Account Settings Read if required by wrangler). That is all `wrangler preview`, which the `stage` job runs, needs (open beta, wrangler 4.135 or later). The production deploy needs more: the Worker answers on the custom domain `status.szolotov.com` (`routes` in `wrangler.jsonc`), so it also needs Zone Workers Routes Edit and Zone Read for the `szolotov.com` zone only, since `wrangler deploy` looks the zone up by name. One token with all of these can serve both environments, or give `staging` a narrower token with Workers Scripts Edit alone. The zone must be in this account. The first production deploy creates the DNS record and certificate. Check that `status.szolotov.com` has no DNS record other than this Worker's own Custom Domain first: a deploy from CI replaces an existing A, AAAA or TXT record without asking, and fails if the name has a CNAME record. The same Custom Domain has `"previews_enabled": true`, so once the first deploy on `main` has published it, previews are served on `https://<preview-name>.status.szolotov.com` (the `stage` preview on `stage.status.szolotov.com`). If the dashboard still has a preview-only Custom Domain `stage.status.szolotov.com` (and its wildcard), remove it before the first release or let the first deploy replace it. Keep Custom Domains in `wrangler.jsonc`: `wrangler deploy` replaces the Worker's whole set, so one added only in the dashboard is detached by the next deploy. Cloudflare creates the wildcard DNS record and certificate for `*.status.szolotov.com` itself; issuing the certificate can take a few minutes after the first deploy. `wrangler.jsonc` sets `preview_urls` to false, which only turns off the `workers.dev` preview addresses. Set an expiry and rotate it before then. Check [Cloudflare's token documentation](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) for current permission names.
2. **Create GitHub environments** `staging` (deployment branches: selected branches, only `stage`) and `production` (only `main`) in Settings → Environments. `dev` is in neither, so a push to it can never reach the token. An existing `staging` environment from the earlier flow still lists `dev`: remove that rule and add `stage`, in the settings or with the CLI:

   ```bash
   gh api repos/greenblacked/status-page/environments/staging/deployment-branch-policies --jq '.branch_policies[] | "\(.id) \(.name)"'
   gh api --method DELETE repos/greenblacked/status-page/environments/staging/deployment-branch-policies/<id of dev>
   gh api --method POST repos/greenblacked/status-page/environments/staging/deployment-branch-policies -f name=stage -f type=branch
   gh api repos/greenblacked/status-page/environments/production/deployment-branch-policies --jq '.branch_policies[] | "\(.id) \(.name)"'   # only main
   ```
3. **Enter two settings in each environment:** `CLOUDFLARE_ACCOUNT_ID` as a variable (or secret; the account ID is not sensitive) and `CLOUDFLARE_API_TOKEN` as a secret. The deploy workflow requires these two values, and both environments can hold the same token. `DEPLOY_URL` is optional but recommended: set it to the address to check (`https://status.szolotov.com` for production, `https://stage.status.szolotov.com` for staging, the address `wrangler preview` prints) after the first deploy to enable post-deploy smoke tests, and for production automatic rollback. Production `DEPLOY_URL` is safe to set before the release. Set staging `DEPLOY_URL` only after the first production deploy: before it, the `stage` preview answers on `https://stage.stage.status.szolotov.com` while the dashboard's preview-only domain is attached, and the first `main` deploy replaces that domain, moving the preview to `https://stage.status.szolotov.com`. The Worker itself has no API token or account ID binding.
4. **Create the history database once,** from your machine (not from CI). Run `npx wrangler login`, then `npx wrangler d1 create status-page-history`, and paste the `database_id` it prints into `wrangler.jsonc`, in both `d1_databases` and `previews.d1_databases`. Commit that change; a database ID is not a secret. The deploy builds with `VITE_STATUS_HISTORY=1` and fails, on pull requests too, if the built config lacks a cron trigger or a `HISTORY_DB` binding in either place, or if a `database_id` is still the zero-UUID placeholder or is missing or malformed. Cron Triggers belong to the Worker, not to a version: if the first history deploy is rolled back, the cron keeps firing into the older version, which has no `scheduled()` handler, until the next deploy. The stage preview binds the same database read-write, because D1 has no read-only binding; only the code keeps previews from writing.
5. **Monitor production:** optionally set repository variable `PRODUCTION_URL` to its HTTPS address for hourly `/readyz` checks in `source-health.yml`.

The deploy token needs no D1 permission: the table is created by the Worker itself. Deploying does not delete an old KV namespace; remove it in Cloudflare when you no longer need it.

### Locally

| Command | Runs | What it does |
| --- | --- | --- |
| `npm run build:cf` | `DEPLOY_TARGET=cloudflare vite build` | The Worker in `dist/`, the same for every branch |
| `npm run preview:cf` | `DEPLOY_TARGET=cloudflare vite preview --host 127.0.0.1` | Runs that build in workerd, Cloudflare's runtime; local D1 is simulated, so it starts empty |
| `npm run deploy:dry-run` | `WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --config dist/server/wrangler.json` | Shows what would upload, as a pull request's CI does |

Without `DEPLOY_TARGET`, `npm run build` stays a plain Fetch handler, and `npm run preview` runs it on Node, as CI's smoke test does.

These scripts set their variables inline (`VAR=value command`), and `npm run check` calls the `scripts/ci/*.sh` checks, so they assume a POSIX shell. On Windows, npm runs scripts with `cmd.exe` even from a Git Bash window, and that syntax fails there: work in WSL, or point npm at Git Bash once with `npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`.

CI and the deploy share one smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh): `/healthz`, the page and its security headers, `/api/status.json` with every service, `/feed.xml`, `/metrics` and `/readyz`. Run it against any running board:

```bash
./scripts/ci/smoke.sh http://127.0.0.1:4173                    # /readyz may be 503 when the vendors are unreachable
./scripts/ci/smoke.sh https://<your-host> --require-ready      # /readyz must be 200 right now
./scripts/ci/smoke.sh https://<your-host> --expect-version <id> --wait 120 --attempts 3 --require-ready --ready-wait 300   # what the deploy checks
```

`--expect-version` takes a Worker version id (`npx wrangler deployments list`, or the `Current Version ID:` line `wrangler deploy` prints) and fails if `/healthz` still comes from another version when `--wait` runs out, then requires the same `X-Worker-Version` on every response it checks. `--attempts` retries the page, API and feed checks 10 seconds apart; `--ready-wait` separately gives `/readyz` that many seconds, checked every 10, to turn `200` under `--require-ready`. On `main`, the deploy job reads the id from the `deploy` line wrangler writes to `WRANGLER_OUTPUT_FILE_PATH`, and stops with an error, before the smoke test, if there is none. On `stage`, the job reads the preview's addresses from the `preview` line instead and does not pass `--expect-version`: `wrangler preview` reports a preview and a deployment id, and nothing shows that either is the id in the Preview's `X-Worker-Version`. Nothing in the workflows calls [`scripts/ci/verify-deploy.sh`](scripts/ci/verify-deploy.sh): run it by hand after a deploy to check the live hosts (status and stage): headers, robots and TLS; until the first `main` deploy the stage Preview answers on `https://stage.stage.status.szolotov.com`, so pass `--stage-url https://stage.stage.status.szolotov.com` until then.

A cold local Worker collects vendors on its first request. Run `./scripts/ci/smoke.sh http://127.0.0.1:4173` against the preview.

### Rolling back

`deploy.yml` already does this by itself when a production deploy fails its smoke test (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` reach only that one rollback step, same as the deploy and preview steps). A failed preview is not rolled back: it never receives production traffic. If `wrangler deploy` fails after it has uploaded the script (for example when the token lacks Zone Workers Routes Edit or Zone Read, so publishing the Custom Domain fails), the new version is already live, and it was neither smoke-tested nor rolled back. The job says so; check it, and roll back by hand if needed. To go back to the previous production version by hand:

```bash
npx wrangler rollback --name status-page
```

You can also use **Workers & Pages → status-page → Deployments** in the dashboard, or revert the commit so the next push deploys the fix. A rollback lasts until the next deploy from `main`. Rollback applies to production only; a push to `stage` uploads a preview and leaves it alone. Rolling back changes which Worker version answers requests; each isolate collects vendor status again when its cache expires. To see which version is answering, `curl -sI https://<your-host>/healthz | grep -i x-worker-version`; a version from before `X-Worker-Version` sends none.

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
  - Status colour is for badge text, dots and the bad days of the uptime strip (built only with `VITE_STATUS_HISTORY=1`, and drawn only when `/api/history.json` has days), never a fill across a badge, panel or card. Badges share one neutral fill and draw their own tone dot; a quiet day on that strip is a neutral tick
  - `--color-event`, the warm amber, marks the one thing that just moved (the headline's ping, a card that just changed, the period dial's hand). It never carries a status by itself and never replaces `--color-down` on an Outage badge
  - Status, event and aurora colours are written once in OKLCH, with no separate Display P3 block. Keep status and text colours inside sRGB, so the contrast the tests measure is the contrast shown. Only the aurora may use colours beyond sRGB, and today one dark stop does
  - Type: the system faces only, no web font. Mono uppercase with wide tracking for labels, and `font-serif` italic for one short phrase (the empty board), nowhere else
  - The coordinate grid (`.aurora-grid`) is static: never animate it. It goes with the aurora under Reduce glass and under forced colours
  - The card index (01 to 14) follows the catalog order and is `aria-hidden`: decoration, never part of a name
- Three materials, and nothing else is translucent:
  - `.glass-chrome` for controls that float above the content (the compact header, the settings dialog), one on screen at a time
  - `.glass` for content panels: the summary, every service card (healthy or not, the most urgent one included) and the board log. That is a dozen or more on a full board, so keep it to panels of content, never to chips, rows or anything inside a card
  - `.glass-whisper`, with no blur, for anything dense or repeated inside a panel: chips, the search box
- Never glass on glass: inside a `.glass` or `.glass-chrome`, nest only `.glass-whisper` or `.glass-inset`
- Performance: no `will-change: backdrop-filter`, never animate a blur or a `filter`, and animate `transform` and `opacity` only. The one exception is a registered custom property on a small element, stepped so it repaints rarely, as the period dial does once a second. Blur stays at 24px for `.glass` and 28px for `.glass-chrome`
- Radii are concentric: a nested shape takes its parent's radius minus the inset between them, rounded down to the nearest `--radius-*` step (`rounded-2xs` to `rounded-xl`). Pills stay `rounded-full`, and Tailwind's default radius scale is switched off
- New motion goes in the `prefers-reduced-motion` block, and new translucency in the Reduce glass block, in `src/styles.css`
- Newer CSS is welcome where it degrades to something correct: `@starting-style` and `linear()` easing are used unconditionally, since a browser without them just skips the flourish. Container queries lay out the card grids, which stay a single column without them; every engine the board supports has had them since Safari 16 and Chrome 105. Anything whose absence would break layout or meaning, such as scroll-driven animations, goes behind `@supports` and stays decorative
- Card internals respond to the card's own width with container-query variants (`@xs:`), not the viewport's (`sm:`), since a card's width depends on the board log beside it
- Keep fetch timeouts short and failures isolated (`Promise.all` of per-service collectors)
