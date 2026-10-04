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
release: 0.6.0
```

Rules:

- Imperative mood (“add”, not “added”)
- Subject ≤ 72 characters, no trailing period
- One logical change per commit
- Body explains *why* when the diff is not obvious
- Never commit secrets, `.env` files, or vendor credentials (Status Page does not need any)

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `style`, `revert`, `release`. `release` is only for a release commit (`release: 0.6.0`) and its pull request (`release: v0.6.0`); it takes no scope and no `!`, and never counts toward a version. Because it never counts, the **PR title** check accepts it only on the `release/vX.Y.Z` pull request into `main` that [`bump.sh`](scripts/release/bump.sh) prepares, and only when the title's version is the branch's (`release: v0.6.0` or `release: 0.6.0` on `release/v0.6.0`); on any other pull request a squash merge would turn a real change into a commit that releases nothing. The commit check on a range still accepts the `release: X.Y.Z` commits `bump.sh` makes, since a `chore/sync-main` pull request carries them into `stage`.

## Branches

Three branches live on, and only the owner moves work between them:

| Branch | Holds | Merges in | Deploys | Releases |
| --- | --- | --- | --- | --- |
| `dev` | The next release, as it is built | Pull requests from your branches, squash-merged | Nothing | Never |
| `stage` | What is being tried before it is released | `dev`, in a merge commit, by the owner | A Worker Preview named `stage`, at [stage.status.szolotov.com](https://stage.status.szolotov.com) | Never |
| `main` | What is released | `stage`, in a merge commit, by the owner | Production, at [status.szolotov.com](https://status.szolotov.com) | Every merge with a `feat`, `fix` or breaking change |

> **`dev` is paused.** For now, branch from `stage` and open the pull request into `stage`, squash-merged; `stage` still goes to `main` with a merge commit. Nothing else changes. The `stage` ruleset must allow squash merges meanwhile (see [Branch protection](#branch-protection)). To bring `dev` back, recreate it from `stage`, set [`scripts/ci/dev-paused`](scripts/ci/dev-paused) to `false` (the one switch: the branch name check and [`release.yml`](.github/workflows/release.yml) both read it through [`scripts/ci/dev-paused.sh`](scripts/ci/dev-paused.sh)), and set `stage`'s allowed merge method back to a merge commit only. The rest of this page describes the flow with `dev` active.

Branch from `dev`, and open the pull request into `dev`: every pull request targets `dev`, and `dev` never deploys, so a merge there reaches no address and no Cloudflare credential. The owner promotes the work: a pull request from `dev` into `stage` puts it on the preview, and once the preview is right, a pull request from `stage` into `main` releases it (see [Releases](#releases)). An urgent fix takes the same road and is promoted at once; there is no separate lane into `main`.

Name the branch `<prefix>/<short-kebab-description>`:

| Prefix | Use for | Example |
| --- | --- | --- |
| `feature/` | New capability | `feature/board-metrics-stars-shortcuts` |
| `fix/` | Bug fix | `fix/42-aws-stale-events` |
| `docs/` | Documentation only | `docs/readme-integrations` |
| `ci/` | Workflow and CI script changes | `ci/cache-actionlint-image` |
| `chore/` | Pins, tooling, housekeeping | `chore/bump-tanstack-start` |
| `refactor/` | Restructuring with no change in behavior | `refactor/split-collectors` |
| `test/` | Adding or fixing tests only | `test/parser-edge-cases` |
| `perf/` | Performance work | `perf/cache-catalog-lookup` |
| `build/` | Build system and its dependencies | `build/vite-chunk-split` |

- **The description** is two to five lowercase words joined by single hyphens, saying what changes. Use only `a-z`, `0-9` and `-`, and keep the whole name to 50 characters.
- **An issue number** goes first in the description when there is one: `fix/42-aws-stale-events`.
- **Pick the prefix that fits most of the change.** Work that fixes a bug is `fix/`, whatever it touches. The prefixes follow the Conventional Commit types, except that `feature/` is the branch for `feat:`; `feat/`, `style/`, `revert/` and the former `fb/` are not accepted.
- **The prefix is not the commit type.** The pull request title is still a [Conventional Commit](#commits), and it picks the [release](#releases): a `feature/` branch has a `feat:` title.
- **Tooling names its own branches.** Dependabot opens `dependabot/…`, and [`scripts/release/bump.sh`](scripts/release/bump.sh) creates `release/vX.Y.Z`. Don't create either by hand.

The **branch name** job in [CI](.github/workflows/ci.yml) fails a pull request whose branch breaks these rules. It also checks where the pull request goes: `main` takes only `stage` (and the `release/vX.Y.Z` branch that [`scripts/release/bump.sh`](scripts/release/bump.sh) creates), `stage` takes only `dev` (and `chore/sync-main`, see [Releases](#releases)), and `dev` takes everything else. While `dev` is paused, `stage` also takes everything else, a fork's feature branch included, and `main` still takes only `stage` and `release/vX.Y.Z`. `dev` and `stage` are accepted as head branches for those two promotions only, and never from a fork; `main` is never a head branch. A Dependabot security update opens against `main`, the default branch: change its base to `dev` (to `stage` while `dev` is paused). Check a name before pushing, with the base branch as a second argument for the full check:

```bash
./scripts/ci/branch.sh "$(git branch --show-current)" dev   # stage while dev is paused
```

| Not | Instead | Why |
| --- | --- | --- |
| `feature/Board_Metrics` | `feature/board-metrics` | Lowercase, hyphens only |
| `fb/board-metrics` | `feature/board-metrics` | The prefix is spelled out; `fb/` is no longer accepted |
| `feat/board-metrics` | `feature/board-metrics` | `feat` is the commit type; the branch prefix is `feature/` |
| `fix-aws` | `fix/aws-stale-events` | The slash lets Git clients group branches, and the description says what is fixed |
| `username/readme` | `docs/readme-integrations` | Say what changes, not who changes it; the commit author already records who |
| `wip-2026-09-25` | `chore/pin-node-22` | A date says nothing about the change |

Rules:

- Branch from an up-to-date `dev`, and open one pull request per branch.
- Bring `dev` in with a merge, not a rebase, once the branch is pushed. Others may have it checked out (see [docs/git-and-readme.md](docs/git-and-readme.md#authorship)).
- Keep the name when the work grows: a pull request cannot move to another branch, so renaming one means opening a new pull request.
- Delete the branch once it is merged.
- `dev`, `stage` and `main` take changes only through pull requests, apart from what CI pushes: `main` merged back into `stage` and `dev` after each release, and the release commit on `main` where a ruleset lets GitHub Actions push it (on this repository `bump.sh` makes that commit in a pull request instead).

### Branch protection

Branch protection lives in GitHub's settings, not in the code, so the owner sets it once. The recommended rulesets (**Settings → Rules → Rulesets**, target: branch) are the same for the three branches except for how a pull request may be merged and who may bypass them. This table is the recommended setup, not what this repository has today (see below):

| Setting | `dev` | `stage` | `main` |
| --- | --- | --- | --- |
| Require a pull request before merging | yes | yes | yes |
| Allowed merge methods | squash (merge commit only for `chore/sync-main`) | merge commit | merge commit |
| Required approvals | 0 while there is one maintainer | 0 | 0 |
| Require status checks to pass | `CI OK`, `pull request title`, `analyze (javascript-typescript)`, `analyze (actions)`, `dependency-review` | the same | the same |
| Require the branch to be up to date | no | no | no |
| Block force pushes | yes | yes | yes |
| Restrict deletions | yes | yes | yes |
| Restrict updates: only the bypass list may push or merge | yes | yes | no (with no bypass actor it would block every merge, pull requests included) |
| Require linear history | no | no | no |
| Bypass list | Repository admin (the owner), GitHub Actions where offered | the same | none |

Without GitHub Actions on the bypass list, `stage` and `dev` must not get the update and pull request rules (leave them out of `ruleset()` below, as the live `stage` ruleset does), or the sync merge of `main` is refused and goes through a `chore/sync-main` pull request after every release. This repository's live rulesets are lighter than the table. `protect main` blocks deletion and force pushes and requires a pull request and the `CI OK` and `CodeQL` checks, with no bypass actor and no `update` rule. `protect stage` only blocks deletion and force pushes (no pull request rule, no update restriction, no bypass actor), and `dev` has no ruleset while it is paused. So a direct push to `main` is rejected, and a direct push to `stage` is not. `main`'s ruleset has no bypass actors. GitHub's web UI offers GitHub Actions in a ruleset's bypass list only for organisation repositories; a repository owned by a personal account shows no such actor (only "GitHub Code Quality agent"), so the workflow cannot push to `main`, and a release goes through a pull request instead ([Releases](#releases)). The merge of `main` back into `stage` (and into `dev`, when it is back) is a different matter: it succeeds on this repository, because `stage`'s ruleset does not stop the workflow's push. If a release run fails with `GH013` (or "Repository rule violations"), recover by where it failed, which the error names:

- **The push to `main` was rejected** (the annotation says `push to main`): the ruleset refused GitHub Actions' push, so nothing was released: no bump commit, no tag, no release. Release with `./scripts/release/bump.sh <level|X.Y.Z>` from an up-to-date `main` (after a merge from `stage` it already holds stage's commits; it creates the `release/vX.Y.Z` branch) and a pull request into `main` merged with a merge commit ([Releases](#releases)); the run that merge starts publishes that version without pushing to `main`. Where the settings do offer GitHub Actions as a bypass actor (an organisation repository, or the API, see below), adding it lets the usual merge-triggered release push the bump itself.
- **Creating the tag was rejected** (`creating tag vX.Y.Z`): a ruleset that covers tags refused the API call. When the release came from a bump commit already on `main`, `package.json` there holds an untagged version. Do not re-run the jobs: the re-run sees `main` ahead of its planned commit and ends green without releasing. Fix the tag ruleset, then run `gh workflow run release.yml --ref main -f bump=current`.
- **The merge of `main` back into `stage` or `dev` was rejected** (`push to stage`; not the case on this repository today, where `stage` takes the workflow's push): the release itself is done. Bring `main` in through a `chore/sync-main` branch and a pull request merged with a merge commit ([Releases](#releases)).

Squash on `dev` keeps one commit per pull request, except for a `chore/sync-main` pull request, which needs a merge commit (see [Releases](#releases)), so `dev` allows both methods. The merge commits on `stage` and `main` keep every one of them, so the release reads each type and changelog line (see [Releases](#releases)). Linear history would forbid those merge commits. The bypass list has the owner, who promotes and merges, on `dev` and `stage`, with GitHub Actions where offered; `main`'s has no one, so even the owner reaches `main` only through a pull request. [`release.yml`](.github/workflows/release.yml) would need GitHub Actions on the list to push the release commit to `main` or to merge `main` back into `stage` and `dev`, but the web UI does not offer it for a repository owned by a personal account, so on this repository the push to `main` is rejected and a release goes through `bump.sh` and a pull request ([Releases](#releases)). The merge of `main` back into `stage` is not rejected here, since `stage`'s ruleset has no pull request rule; where a ruleset does refuse it, `main` is brought into `stage` and `dev` through a `chore/sync-main` pull request. The repository settings **Allow merge commits** and **Allow squash merging** (**Settings → General → Pull Requests**) must both stay enabled, or a ruleset's allowed method has nothing to use. The owner's bypass is `always`, so the owner can push to `dev` and `stage` directly, and rulesets and checks apply to everyone else; set `bypass_mode` to `"pull_request"` for the owner (in `ruleset()` below, on the `RepositoryRole` actor) to make the owner use a pull request too. `CI OK` sums up the other CI jobs, so a renamed or added job never needs a protection change. Optionally turn on required review from Code Owners ([`.github/CODEOWNERS`](.github/CODEOWNERS)) or the merge queue: `ci.yml` already runs on `merge_group`.

The same three rulesets through the API, run once by the repository admin with the GitHub CLI signed in (`gh auth login`). The actor ids are GitHub's: role 5 is Repository admin, and integration 15368 is GitHub Actions. GitHub may refuse the GitHub Actions actor for a repository owned by a personal account, as the web UI does not offer it there either; drop that line from `bypass_actors` then, which leaves the owner's role as the only bypass actor, and release through the pull request route. For `stage` and `dev` also drop the `update` and `pull_request` rules in that case, since nothing could then push the sync merge. The function takes `none` as its third argument for a branch with no bypass actor, as `main` has on this repository; it then leaves out the `update` rule, which with an empty bypass list would block every merge.

```bash
ruleset() { # ruleset <branch> <merge methods, comma-separated: merge|squash> [none: no bypass actor, no update rule]
  jq -n --arg branch "$1" --arg method "$2" --arg bypass "${3:-owner}" '{
    name: ("protect " + $branch),
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/" + $branch], exclude: [] } },
    bypass_actors: (if $bypass == "none" then [] else [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: 15368, actor_type: "Integration", bypass_mode: "always" }
    ] end),
    rules: ([
      { type: "deletion" },
      { type: "non_fast_forward" } ]
      + (if $bypass == "none" then [] else [ { type: "update" } ] end)
      + [
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
    ])
  }' | gh api --method POST repos/greenblacked/status-page/rulesets --input -
}
ruleset main merge none
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

Run `pnpm run check` before you push: lint, typecheck, unit tests, and the hygiene and link checks, the same commands CI runs. For the browser tests, build first and install Chromium and WebKit once:

```bash
pnpm run build
pnpm exec playwright install chromium webkit
pnpm run test:e2e
```

The tests run in six projects: `desktop` and `mobile` on Chromium, `tablet` on Chromium at iPad size (only the search reveal and floating-bar tests), and `Desktop Safari`, `iPhone 17 Pro` and `iPad Pro 11` on WebKit, Safari's engine. Pick some with `--project`, for example `pnpm run test:e2e --project=desktop --project="iPhone 17 Pro"`. On Linux, WebKit needs system libraries: `pnpm exec playwright install --with-deps webkit` installs them. `PLAYWRIGHT_PORT` moves the preview the tests start off port 4173. `E2E_SERVER=node` makes `playwright.config.ts` start the production Node server (`src/node/serve.ts`, what the Docker image runs) instead of `vite preview`, and runs the `@node-server` tests of [`e2e/node-server.spec.ts`](e2e/node-server.spec.ts), which check what only that server does: the board renders and hydrates, `/assets/*` is cached for a year, text is compressed, a repeat request gets a 304 and every response carries the security headers (`E2E_SERVER=node pnpm exec playwright test --project=desktop --project=mobile --grep @node-server`; they are skipped without the variable). The Tilt lighting tests (`e2e/tilt.spec.ts`) need no sensor: they dispatch synthetic `deviceorientation` events and stub iOS's motion permission request, and on an engine without `DeviceOrientationEvent` (Playwright's WebKit on Linux) they supply an empty one.

The browser tests never read a live vendor, so they give the same result on a laptop, in a sandbox without network access and in CI. The preview they start answers a vendor's URL from the canned payload the collector unit tests read (`src/lib/status/__fixtures__`, dates moved to the present) and refuses every other host ([`e2e/support/no-vendors.mjs`](e2e/support/no-vendors.mjs), preloaded by `playwright.config.ts` and read by nothing in `src/`), so the first render is the same board everywhere, with outage and degraded cards, incident times and release lines on it; a test that needs a state serves a fixture board (`serveBoard` in [`e2e/fixture-board.ts`](e2e/fixture-board.ts), which answers the board's server functions; add a board there as a function of `now`). The suite's setup checks the cut-off before the first test and waits until the page it will serve carries the release lines and MikroTik notes (read after the sweep, so a page built too early would lack them; [`e2e/support/first-render.ts`](e2e/support/first-render.ts) pins them, for the first 25 minutes of a run: the feeds are cached for 30, so a longer run no longer asks the first render for them), and the specs import `test` from [`e2e/test.ts`](e2e/test.ts), which fails a test whose page asks another host. The preview is always started fresh, so stop whatever holds the port or move it with `PLAYWRIGHT_PORT`.

[`ci.yml`](.github/workflows/ci.yml) splits the work into one job per concern, so a red check names its cause: `lint`, `typecheck`, `test` and `build` (each on the pinned Node and on Node 24), `browser tests` (four shards: `chromium`, `desktop-safari`, `iphone` and `ipad`; the three WebKit shards run in Playwright's own image, pinned by digest, so they fetch no system libraries from apt: when `@playwright/test` moves, move the image tag and digest in `ci.yml` with it, and the shards' `Check the browser` step says so if they differ; Dependabot opens Playwright bumps on their own for that), `browser tests (history build)`, `browser tests (node server)`, `docker image` (builds the [Dockerfile](Dockerfile) for amd64 and runs it the way the README tells self-hosters to, with [`scripts/ci/image-smoke.sh`](scripts/ci/image-smoke.sh): healthy, smoke-tested, stopped cleanly by `SIGTERM`; nothing is pushed), `commit messages`, `branch name` and `workflow lint`. Every job gets its toolchain from [`.github/actions/setup`](.github/actions/setup/action.yml): Node, the pnpm version and hash in `packageManager` (installed by Corepack, see [Dependencies](#dependencies)), `pnpm install --frozen-lockfile` and a registry signature check.

**`CI OK` is the one check to require.** It needs every job above and passes only when none of them failed or was cancelled (the commit and branch checks are skipped outside pull requests, which is fine). Requiring it alone means a renamed or added job never needs a branch protection change. The same jobs run on pull requests into `dev`, `stage` and `main` and on pushes to each of them. In **Settings → Rules → Rulesets** each of the three requires a pull request and these status checks: `CI OK`, `pull request title`, `analyze (javascript-typescript)`, `analyze (actions)` and `dependency-review`. [Branch protection](#branch-protection) has the exact settings and the API commands.

Coverage has thresholds in [`vitest.config.ts`](vitest.config.ts), set just under the current numbers, so `pnpm run test:coverage` fails if coverage drops. When coverage goes up, raise them in the same pull request. The pinned-Node test job writes coverage to its summary and uploads the HTML report, and a failed browser test shard uploads its Playwright report with traces, as `playwright-report-<shard>`.

The parsers that read vendor input are also fuzzed. [`src/lib/status/fuzz.test.ts`](src/lib/status/fuzz.test.ts) uses [fast-check](https://fast-check.dev/) to feed the bounds, the changelog and Windows release parsers and the feed and payload helpers of `sources.server.ts` generated garbage (broken markup, lone surrogates, dates no `Date` holds, any JSON) and states what must hold for all of it: no throw, output inside its documented ceilings, and linear time on crafted repetition. It runs with `pnpm test` on a fixed seed (a few seconds), so a run is the same everywhere and a failure prints its counterexample and seed. To search wider, for example before a release: `FUZZ_SEED=<n> FUZZ_RUNS=2000 pnpm exec vitest run src/lib/status/fuzz.test.ts`. When it finds a bug, fix it and add the shrunk input to the parser's own `*.test.ts` as a plain case. This is also what OpenSSF Scorecard's Fuzzing check looks for (an import of `fast-check` in a `.ts` file), so keep the import in a test file.

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
| `docs`, `ci`, `build`, `chore`, `refactor`, `test`, `style`, `release` | none |

**On this repository, release through a pull request made by `bump.sh`.** `main`'s ruleset has no bypass actors and the web UI does not offer GitHub Actions for a repository owned by a personal account (see [Branch protection](#branch-protection)), so the workflow cannot push the bump commit to `main`. Instead, once `stage`'s preview looks right and `stage` contains `main` (the merge of `main` back into `stage` after the last release does that):

```bash
git fetch origin && git switch --detach origin/stage
./scripts/release/bump.sh <level|X.Y.Z>     # creates release/vX.Y.Z, commits release: X.Y.Z
git push -u origin release/vX.Y.Z
```

Cut `release/vX.Y.Z` from the current `stage` tip right before opening the pull request, and merge nothing into `stage` until the release pull request is merged and `release.yml` has merged `main` back into `stage`. A merge into `stage` in between moves it past the release branch. When `main` is merged back, git then combines the two `CHANGELOG.md` edits without a conflict, and the `## [Unreleased]` lines that other merge added can land inside the released `## [X.Y.Z]` section, in the release notes of a version that does not contain them. Nothing can repair that automatically, so the rule is what prevents it; the sync job only warns when it sees the situation (step 6).

`bump.sh` creates the `release/vX.Y.Z` branch itself, so do not create it first. It starts from an up-to-date `main`, or from the tip of `origin/stage` when that contains `main`, and refuses any other checkout. From `stage`, the branch carries `stage`'s commits plus the bump commit, so one pull request both promotes `stage` and releases it. If `main` has a commit `stage` lacks (a fix that reached `main` directly), merge `main` into `stage` first (a `chore/sync-main` pull request, see step 6), or run `bump.sh` on `main` for a release of `main` alone.

Open the pull request into `main`, titled `release: vX.Y.Z`, the version of its `release/vX.Y.Z` branch (the [PR title](.github/workflows/pr-title.yml) check rejects a `release:` title on any other pull request, or with another version) (not a plain `stage` pull request: if its commits release anything, its merge starts a run that tries the bump push and fails with `GH013`) and merge it with **Create a merge commit**. `main` currently allows every merge method, so nothing stops a squash or a rebase merge here. A squash leaves one commit titled like the pull request, so the release no longer sees the types of the commits in it, and a rebase merge rewrites the commits, so `stage` would no longer be contained in `main`. Use **Create a merge commit** every time. The merged `package.json` holds an untagged version, so `release.yml` runs in `current` mode: it checks the release, creates the `vX.Y.Z` tag through the API (no push to `main`), drafts, signs and publishes the release, and merges `main` back into `stage`. Where a ruleset does let GitHub Actions push to `main` (an organisation repository), the plain merge of `stage` into `main` also releases, with the workflow committing the bump itself; the steps below describe that flow, and the push in step 3 is the one this repository's ruleset refuses.

When a merge lands on `main`, [`release.yml`](.github/workflows/release.yml):

1. Reads every commit since the last tag and takes the largest bump ([`scripts/release/next.sh`](scripts/release/next.sh)). No feature, fix or breaking change means no release.
2. Checks the release:
   - the new tag doesn't exist yet;
   - typecheck, tests and build pass.
3. Commits `release: X.Y.Z` to `main` (skipped for a `bump.sh` pull request, whose merge already holds the bump commit), authored by the account that merged. The commit updates `package.json` (the version is the only line that changes; `pnpm-lock.yaml` records none for the project, so the lockfile is untouched) and the changelog, and turns `## [Unreleased]` into the dated `## [X.Y.Z]` section. If the pull request added nothing under Unreleased, the section is written from the merged commits' subjects instead.
4. Tags the commit `vX.Y.Z` and creates the GitHub Release as a draft on that tag, with that section as its notes. A draft is visible only to people who can write to the repository.
5. Signs and publishes the release. A separate `sign release` job archives the tag (`git archive`) as `status-page-vX.Y.Z.tar.gz`, signs it keylessly with [Sigstore cosign](https://docs.sigstore.dev/cosign/signing/overview/) under the workflow's GitHub identity, checks the signature with `cosign verify-blob` (a bad one fails the run before anything is attached), uploads the archive and its bundle, `status-page-vX.Y.Z.tar.gz.sigstore.json`, to the draft, and only then publishes it. It fails instead of signing if the tag no longer names the commit the run tagged. The Latest badge is worked out from the published releases at that moment, so a backfill never takes it from a newer release. A release that is already public (made before signing was added, by hand, or by an earlier run) only gets whichever of the two assets it lacks, and existing ones are never replaced, but they are checked first: a present pair must pass `cosign verify-blob`, a lone archive must match the freshly built one byte for byte (same sha256), and a lone bundle must verify the fresh archive. Any mismatch fails the run instead of attaching a signature for different bytes. The job runs no project code, and with the image signing job below it is one of the two in `release.yml` with `id-token: write`. The Docker image is published after it, in two more jobs that wait for the release to be signed and public (see [Publishing the Docker image](#publishing-the-docker-image)); a failed image does not unpublish the release, and fails the run so it is seen.
6. Merges `main` back into `stage` and then `dev`, released or not (while `dev` is paused it skips `dev` with a notice, since nothing lands there and the merge would only conflict), so both carry the release commit and anything that reached `main` without going through `stage`, such as a `release/vX.Y.Z` bump. When that merge actually moves `stage`, it also starts [`deploy.yml`](.github/workflows/deploy.yml) on `stage` by hand: the merge is pushed with a token that starts no workflow of its own, so without this, the preview would keep running the pre-release code until an unrelated push to `stage` updated it. `dev` deploys nothing, so its merge needs no follow-up. A release on `main` while `stage` or `dev` has lines under Unreleased can conflict on `CHANGELOG.md`. The job resolves that conflict itself when `main`'s Unreleased section is empty (as after a release) and the branch changed nothing in the file outside Unreleased: it keeps `main`'s released section and puts the branch's lines back under Unreleased ([`scripts/release/merge-changelog.sh`](scripts/release/merge-changelog.sh)). It does nothing about a merge git calls clean. If the branch moved while the release was open and both it and `main` changed `CHANGELOG.md` since their merge base, the job merges as usual and prints a `::warning::` to check that the branch's Unreleased lines did not land in the released section (see the rule above). Any other conflict fails the job, after it has tried the other branch, and you resolve it on a branch from the one that conflicted:

   ```bash
   git fetch origin
   git switch -c chore/sync-main origin/dev     # origin/stage for a conflict on stage
   git merge origin/main        # resolve, then git commit
   git push -u origin chore/sync-main
   ```

   Open the pull request into `dev` (or `stage`) and merge it with **Create a merge commit**, so the branch keeps `main`'s history and the next sync is clean. The branch name check accepts `chore/sync-main` into `stage` for this. Never resolve it on a pull request from `main` into `dev` or `stage`: GitHub commits the resolution to `main`, which releases the unreleased work. The branch name check rejects `main` as a head branch for that reason.

If a check fails, nothing is committed, tagged or published. If signing fails, the tag exists but its release stays a draft that only maintainers can see. To finish it, use **Re-run failed jobs** on that run, whatever started it; this is the usual fix. Otherwise, for a merge or bump run, run the workflow from the tag: `gh workflow run release.yml --ref vX.Y.Z -f bump=current`. For a backfill, run the same backfill again, from the same ref, with the same version and commit; it does not take Latest from a newer published release. For a tag pushed by hand, re-run all jobs of that run. Do not use **Re-run all jobs** on a merge or bump run, and do not start a patch, minor or major bump to recover: neither publishes the draft. Later merges release as usual from the tag. When merges land close together, one run releases them together: GitHub keeps only the newest waiting run, and each run releases everything since the last tag. [`pr-title.yml`](.github/workflows/pr-title.yml) fails a pull request whose title is not a Conventional Commit, since such a merge would release nothing.

Other ways in, with the same checks:

| Way | When |
| --- | --- |
| **Run workflow** with bump `patch`, `minor` or `major` | A release by hand, for merged changes whose types release nothing, such as a `refactor` worth shipping. It needs lines under Unreleased. `gh workflow run release.yml --ref main -f bump=patch` |
| **Run workflow** with bump `current` | Publishes the `package.json` version as it is, if it has no tag yet, or, run from that tag, finishes its draft. Use it to retry a run that committed the bump but did not publish. |
| [`scripts/release/bump.sh`](scripts/release/bump.sh) `minor` | The way to release on this repository. Run from an up-to-date `main` or from `origin/stage` (once it contains `main`). Makes the same bump commit locally on a new `release/vX.Y.Z` branch for review in a pull request into `main`. Merging it (merge commit) releases that version as it is. |
| **Run workflow** with `version` and `commit` | Backfills an older release: tags that commit on `main` with a version whose section is already in `main`'s changelog, and publishes it without taking Latest from a newer published release. `gh workflow run release.yml --ref main -f version=0.1.1 -f commit=4cf30fd` |
| A tag pushed by hand | `git tag -a v0.4.0 -m "Status Page 0.4.0" && git push origin v0.4.0` publishes that tag, if it matches `package.json` and is on `main`. |

The bump commit and the tag are pushed with the workflow's `GITHUB_TOKEN`, so they start no other workflow and CI does not run on the bump commit itself. The verify job has already checked the same code.

A ruleset on `main`, `stage` or `dev` that requires pull requests or status checks rejects the workflow's direct pushes to it (the release commit, and the merges of `main` back) unless GitHub Actions is a bypass actor. On this repository `main`'s ruleset has none and the web UI does not offer one for a personal-account repository, so the release goes through `bump.sh` and a pull request (above), which makes the workflow push nothing to `main`. The same ruleset currently allows every merge method (merge commit, squash and rebase), so the release pull request must be merged with **Create a merge commit** by choice, not by enforcement. **A rejected push fails the run.** After any failed push [`scripts/release/push.sh`](scripts/release/push.sh) asks the remote for the branch again: only if its tip is no longer the commit the run planned from did the branch really move, and then a merge run hands over to the run for the newer push (a notice), a run started by hand fails so it can be run again, and the `main` into `stage` or `dev` merge is tried again. Anything else, such as GitHub's `GH013: Repository rule violations found`, fails the job with an annotation that names the branch and the fix, because nothing was released and a green run would hide that: for `main`, `bump.sh` and a pull request into `main` (merge commit); for `stage` or `dev`, a `chore/sync-main` branch and pull request (see above). Adding GitHub Actions to the bypass list is an alternative only where GitHub's settings offer it ([Branch protection](#branch-protection)). Creating the tag is checked the same way.

Never move or reuse a tag that has a published release; release a new patch version instead.

### Verifying a release

Each release made since signing was added carries two assets besides GitHub's automatic source archives: `status-page-vX.Y.Z.tar.gz`, the source of the tagged commit, and `status-page-vX.Y.Z.tar.gz.sigstore.json`, its [Sigstore](https://www.sigstore.dev/) bundle. The signature is keyless: the certificate in the bundle names the `release.yml` workflow of this repository on `main` (or on a `vX.Y.Z` tag pushed by hand), issued to GitHub Actions, and the signing is recorded in the public Rekor transparency log. To check a download with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) (v3 or later, the version `release.yml` signs with; earlier versions cannot read its bundle format):

```bash
VERSION=v0.6.0   # the release you downloaded
gh release download "$VERSION" --repo greenblacked/status-page \
  --pattern "status-page-$VERSION.tar.gz" --pattern "status-page-$VERSION.tar.gz.sigstore.json"
cosign verify-blob "status-page-$VERSION.tar.gz" \
  --bundle "status-page-$VERSION.tar.gz.sigstore.json" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/greenblacked/status-page/\.github/workflows/release\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$'
```

`Verified OK` means the archive is byte for byte what `release.yml` signed. Anything else, including a different workflow or repository in the certificate, means you should not use it. Earlier releases have no signed assets. The Worker itself is not a release asset: it is built and deployed from the same commit by [`deploy.yml`](.github/workflows/deploy.yml).

The Docker image is signed the same way, with the same identity. `cosign verify` needs the image's digest or tag, and checks the signature and its Rekor entry:

```bash
cosign verify ghcr.io/greenblacked/status-page:latest \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/greenblacked/status-page/\.github/workflows/release\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$'
docker buildx imagetools inspect ghcr.io/greenblacked/status-page:latest --format '{{ json .Provenance }}'   # the SLSA provenance
docker buildx imagetools inspect ghcr.io/greenblacked/status-page:latest --format '{{ json .SBOM }}'         # the SBOM
```

To keep what you verified, run it by digest (`ghcr.io/greenblacked/status-page@sha256:...`): a tag can move, a digest cannot.

### Publishing the Docker image

After a release is tagged, signed and public, `release.yml` builds the [Dockerfile](Dockerfile) at that tag in the `build and push image` job and pushes `ghcr.io/greenblacked/status-page:X.Y.Z` (lower case, as ghcr.io requires), plus `:latest` when the version is the newest published one (the rule the GitHub Release's Latest badge follows, so a backfill never moves it). The image is `linux/amd64` and `linux/arm64`; the bundler runs on the runner's own platform and only the production install is per platform, so the arm64 half does not run the build under emulation. Before anything is pushed, the amd64 image is built, started with `--read-only --cap-drop ALL` and checked with [`scripts/ci/image-smoke.sh`](scripts/ci/image-smoke.sh), the script `ci.yml`'s `docker image` job runs on every pull request. The push attaches a SLSA provenance attestation (`mode=max`) and an SBOM, and the job has `packages: write` and no `id-token`: it runs project code (the build), so it cannot sign. The `sign image` job runs none (cosign only), has `packages: write` and `id-token: write`, signs the pushed digest keylessly under the same workflow identity as the source archive and verifies the signature before it finishes. A tag with no Dockerfile (a backfill of an older release) is skipped with a notice.

One-time setup: a package that GitHub Actions creates in ghcr.io starts **private**. After the first release that pushes it, open the package's page (the repository's **Packages** sidebar → **status-page** → **Package settings**), confirm it is connected to the repository (the image's `org.opencontainers.image.source` label does that) and change its visibility to **Public**, or `docker pull` asks for a login.

## Deploying

[`deploy.yml`](.github/workflows/deploy.yml) builds the board for [Cloudflare Workers](https://developers.cloudflare.com/workers/) and deploys it with wrangler:

| Branch | Environment | Worker | Address |
| --- | --- | --- | --- |
| `dev` | none | Nothing deploys | none |
| `stage` | `staging` | `status-page` Worker Preview `stage` | [stage.status.szolotov.com](https://stage.status.szolotov.com) |
| `main` | `production` | `status-page` deploy | [status.szolotov.com](https://status.szolotov.com) |

There is one Worker, `status-page`. Every push to `stage` or `main` deploys; `dev`, where pull requests land, deploys nothing and never sees a Cloudflare credential. Pull requests into `dev`, `stage` and `main` build and dry-run the Worker without credentials. **Run workflow** deploys only `main` and `stage`: on any other branch, or on a tag, the first step fails at once and says so. The built Worker is also smoke-tested locally. A push to `main` runs `wrangler deploy`, which makes the new version the production Worker on its Custom Domain. A push to `stage` runs `wrangler preview --name stage`, which creates or updates a [Worker Preview](https://developers.cloudflare.com/workers/previews/) named `stage` of the same Worker: it never receives production traffic. A Preview takes its settings from the `previews` block of `wrangler.jsonc` (here `ROBOTS=noindex` and the version metadata binding), not from the top level. Its address is `https://stage.status.szolotov.com`: the production Custom Domain `status.szolotov.com` has `"previews_enabled": true` in `wrangler.jsonc`, so Cloudflare serves each Preview one level below it through the wildcard `*.status.szolotov.com`, which it creates itself. Each deployment also gets its own address, which `wrangler preview` prints. Preview addresses go live once a `wrangler deploy` on `main` has published that setting. A production deploy is checked against its `X-Worker-Version` header by the post-deploy smoke test, if `DEPLOY_URL` is configured, and is rolled back automatically when that test fails. A preview reports no version id to wait for, so its smoke test only checks that the address answers; a failed preview is not rolled back, since it never affects production. The preview answers `noindex`; production remains indexable.

### How the board stays fresh on Workers

Each Worker isolate collects the public vendor feeds on demand, shares a 45-second in-memory cache among its requests, serves a recently expired result while a new collection runs, and throttles forced refreshes to one per 15 seconds. A cold isolate can take several seconds to answer. Isolates do not share their cache, so traffic can cause more vendor requests than a shared store would. There is no persistent 30-day history; `/api/history.json` returns an empty compatible document.

The Cloudflare entry in `src/server.cloudflare.ts` only threads the preview's robots setting and version metadata into TanStack's request handler. It has no scheduled event or storage binding. The Node and Worker builds both use `src/lib/status/board.ts`.

### How the token is kept safe

The repository is public, so anyone can read the workflow and open a pull request. The Cloudflare API token is still reachable only by the deploy job for `stage` and `main`, never for `dev`:

- **It is an environment secret, not a repository secret.** GitHub hands it only to a job that names the `staging` or `production` environment, and each environment admits one branch.
- **Pull requests never get it,** from forks or not. The workflow has no `pull_request_target`, so pull request code never runs with secrets or a write token.
- **Nothing but wrangler runs beside it.** The job that holds the token installs with `pnpm install --frozen-lockfile --ignore-scripts`, so no dependency install script runs there, and checks that install with [`scripts/ci/audit-signatures.sh`](scripts/ci/audit-signatures.sh), so the wrangler that runs beside the token is the one the registry signed. It also runs no build, no package script and no dependency code: it only uploads what the build job made (`no_bundle`), and only its deploy, preview and rollback steps see the token. The repository files it runs are shell scripts, plus one TypeScript file that Node runs directly and that imports only `node:` built-ins, from the same protected branch as the deploy, each in a step without the token: [`scripts/ci/pnpm-pin.sh`](scripts/ci/pnpm-pin.sh), which makes Corepack install the pinned pnpm, [`scripts/ci/audit-signatures.sh`](scripts/ci/audit-signatures.sh), which retries the signature check only when the registry cannot be reached and runs [`scripts/ci/lockfile-integrity.ts`](scripts/ci/lockfile-integrity.ts), and the post-deploy smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh) (bash, curl and jq).
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
4. **Monitor production:** optionally set repository variable `PRODUCTION_URL` to its HTTPS address for hourly `/readyz` checks in `source-health.yml`.

No KV namespace or ID is needed. Deploying does not delete an old namespace; remove it in Cloudflare when you no longer need it.

### Locally

| Command | Runs | What it does |
| --- | --- | --- |
| `pnpm run build:cf` | `DEPLOY_TARGET=cloudflare vite build` | The Worker in `dist/`, the same for every branch |
| `pnpm run preview:cf` | `DEPLOY_TARGET=cloudflare vite preview --host 127.0.0.1` | Runs that build in workerd, Cloudflare's runtime, without storage bindings |
| `pnpm run deploy:dry-run` | `WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --config dist/server/wrangler.json` | Shows what would upload, as a pull request's CI does |

Without `DEPLOY_TARGET`, `pnpm run build` stays a plain Fetch handler, and `pnpm run preview` runs it on Node, as CI's smoke test does. `pnpm start` runs the same build with the production server in [`src/node/`](src/node) (`PORT`, `HOST`, `TRUST_PROXY`; the README's [Self-host with Docker](README.md#self-host-with-docker) lists them): static files from memory with the cache rules of `public/_headers`, Brotli and gzip, the security headers on every response, JSON request logs and a clean exit on `SIGTERM`. It runs under Node's own type stripping, so its files import each other with `.ts` extensions and use no syntax that needs a transform. `docker build -t status-page .` builds the image and `docker compose --profile serve up --build status-page` runs it on http://127.0.0.1:3000.

These scripts set their variables inline (`VAR=value command`), and `pnpm run check` calls the `scripts/ci/*.sh` checks, so they assume a POSIX shell. On Windows, pnpm runs scripts with `cmd.exe` even from a Git Bash window, and that syntax fails there: work in WSL, or point pnpm at Git Bash once with `pnpm config set script-shell "C:\Program Files\Git\bin\bash.exe"`.

CI and the deploy share one smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh): `/healthz`, the page and its security headers, `/api/status.json` with every service, `/feed.xml`, `/metrics` and `/readyz`. Run it against any running board:

```bash
./scripts/ci/smoke.sh http://127.0.0.1:4173                    # /readyz may be 503 when the vendors are unreachable
./scripts/ci/smoke.sh https://<your-host> --require-ready      # /readyz must be 200 right now
./scripts/ci/smoke.sh https://<your-host> --expect-version <id> --wait 120 --attempts 3 --require-ready --ready-wait 300 --require-asset-cache   # what the deploy checks
```

`--expect-version` takes a Worker version id (`pnpm exec wrangler deployments list`, or the `Current Version ID:` line `wrangler deploy` prints) and fails if `/healthz` still comes from another version when `--wait` runs out, then requires the same `X-Worker-Version` on every response it checks. `--require-asset-cache` takes the first `/assets/*.woff2` that the page's stylesheet names and requires `Cache-Control: ... max-age=31536000 ... immutable` on it, which proves that the Worker's asset server applies [`public/_headers`](public/_headers); the deploy and the workerd run pass it, the Node preview in CI does not (only Cloudflare reads that file). `--attempts` retries the page, API and feed checks 10 seconds apart; `--ready-wait` separately gives `/readyz` that many seconds, checked every 10, to turn `200` under `--require-ready`. On `main`, the deploy job reads the id from the `deploy` line wrangler writes to `WRANGLER_OUTPUT_FILE_PATH`, and stops with an error, before the smoke test, if there is none. On `stage`, the job reads the preview's addresses from the `preview` line instead and does not pass `--expect-version`: `wrangler preview` reports a preview and a deployment id, and nothing shows that either is the id in the Preview's `X-Worker-Version`. Nothing in the workflows calls [`scripts/ci/verify-deploy.sh`](scripts/ci/verify-deploy.sh): run it by hand after a deploy to check the live hosts (status and stage): headers, robots and TLS; until the first `main` deploy the stage Preview answers on `https://stage.stage.status.szolotov.com`, so pass `--stage-url https://stage.stage.status.szolotov.com` until then.

A cold local Worker collects vendors on its first request. Run `./scripts/ci/smoke.sh http://127.0.0.1:4173` against the preview.

### Rolling back

`deploy.yml` already does this by itself when a production deploy fails its smoke test (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` reach only that one rollback step, same as the deploy and preview steps). A failed preview is not rolled back: it never receives production traffic. If `wrangler deploy` fails after it has uploaded the script (for example when the token lacks Zone Workers Routes Edit or Zone Read, so publishing the Custom Domain fails), the new version is already live, and it was neither smoke-tested nor rolled back. The job says so; check it, and roll back by hand if needed. To go back to the previous production version by hand:

```bash
pnpm exec wrangler rollback --name status-page
```

You can also use **Workers & Pages → status-page → Deployments** in the dashboard, or revert the commit so the next push deploys the fix. A rollback lasts until the next deploy from `main`. Rollback applies to production only; a push to `stage` uploads a preview and leaves it alone. Rolling back changes which Worker version answers requests; each isolate collects vendor status again when its cache expires. To see which version is answering, `curl -sI https://<your-host>/healthz | grep -i x-worker-version`; a version from before `X-Worker-Version` sends none.

## Dependencies

Dependabot proposes npm-ecosystem updates (the project, whose lockfile is `pnpm-lock.yaml`: Dependabot's `npm` ecosystem covers pnpm), GitHub Actions updates and Docker base image updates weekly. npm updates are grouped into production dependencies, development dependencies and Playwright, Actions updates into one group, and Docker updates arrive on their own.

- Actions stay pinned to a full commit SHA with the version in a trailing comment
- The Dockerfile's Node base image is pinned by tag **and** digest (`node:22.22.2-bookworm-slim@sha256:...`) in its two `FROM` lines, which Dependabot's `docker` ecosystem moves together after the same 7-day cooldown; its major versions are skipped, because a new Node line is chosen by hand together with `engines` and `.nvmrc`. What the image runs at run time is only what `pnpm install --prod --frozen-lockfile` locks: anything `dist/server/server.js` or `src/node/` imports must be in `dependencies`, not `devDependencies` (`seroval` moved for this reason)
- A new release is proposed only after a cooldown, 7 days for npm and 3 for Actions, so a hijacked release that is pulled within days never reaches the lockfile. Security updates are not held back
- **pnpm is pinned by hash, and Corepack checks it.** `packageManager` in `package.json` is `pnpm@<version>+sha512.<hex>`: the version and the sha512 of that version's package tarball on the npm registry. Corepack (shipped with Node 22 and 24) downloads exactly that version and refuses it unless the hash matches, so a registry or cache that serves other bytes under the same name and version fails closed. CI, the deploy and release workflows and the container checks install it through [`scripts/ci/pnpm-pin.sh`](scripts/ci/pnpm-pin.sh) (`corepack enable` into a directory of its own, put first on `PATH`), never by `npm install --global pnpm@<version>`, which trusts the registry to serve the right bytes for a name and which OpenSSF Scorecard counts as unpinned. pnpm 12 is a native executable: the tarball Corepack hashes is a small wrapper, and the executable it then downloads is verified by pnpm's own downloader against npm's registry signature (npm's public keys are built into that wrapper). The `lint` job (`pnpm-pin.sh check`) and the unit tests fail on a `packageManager` without that hash. `pnpm-workspace.yaml` sets `pmOnFail: ignore`, so Corepack is the only thing that pins pnpm: by default pnpm 12 also writes itself into a first YAML document of `pnpm-lock.yaml`, and OSV-Scanner (behind OpenSSF Scorecard's Vulnerabilities check) reads only that first document, so it would scan pnpm and none of the project's dependencies. To move to a new pnpm: take the hex digest from `npm view pnpm@<version> dist.integrity` (base64 there; convert it to hex) and put `pnpm@<version>+sha512.<hex>` in `packageManager`; the next install makes Corepack fetch that version and fail unless the digest is the tarball's.
- **Why pnpm, and not the npm CLI.** CI used to run an npm CLI pinned from `tools/npm`. npm 12.1.0 bundles `http-cache-semantics` 4.2.0 inside itself (CVE-2026-93748, HIGH, with no fix upstream), besides `brace-expansion`, `undici` and `ip-address` versions that carry advisories, so the pin needed scanner exceptions (`.trivyignore.yaml`, `tools/npm/osv-scanner.toml`, `allow-ghsas` in dependency review) that expired on a timer. pnpm 12 has no dependencies (its only optional dependencies are its own platform binaries, which Corepack does not install), and its package bundles neither `http-cache-semantics` nor `make-fetch-happen` (what it does ship inside, `node-gyp` and its helpers and `undici` 6.28.1, is not listed in any lockfile). `pnpm-lock.yaml` lists none of them either, so no exception is left: dependency review, trivy and OSV-Scanner fail on any HIGH advisory. `scripts/ci/pnpm-pin.test.ts` fails if a scanner exception file, a second lockfile or those two packages come back.
- pnpm 12 does not run a dependency's install scripts unless `allowBuilds` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) says so. The install scripts of `esbuild`, `workerd` and `fsevents` only check or swap in the prebuilt binary that the platform package already ships, so they are denied there and `pnpm install` stays quiet. List a new dependency under `allowBuilds` (`true` or `false`) when `pnpm install` reports that its build script was ignored. `engines` (Node `^22.22.2 || ^24.15.0`, with `.nvmrc`) is unchanged: Corepack ships with those lines.
- **A trust policy applies to every install.** `pnpm-workspace.yaml` sets `trustPolicy: no-downgrade`: pnpm fails the install, frozen lockfile included, if a locked version carries less publisher evidence (provenance attestation, trusted publisher) than an earlier version of the same package, the usual sign of a package takeover (`ERR_PNPM_TRUST_DOWNGRADE`). Three exact versions are excluded, each a release that carries no attestation although an earlier release of the same package did: `semver@6.3.1`, `undici-types@6.21.0` and `why-is-node-running@3.2.2` (all dev-time transitive dependencies; a later version of any of them is checked again). Do not add an exclusion without looking at why the version lost its evidence.
- **Registry signatures are verified on every install** by [`scripts/ci/audit-signatures.sh`](scripts/ci/audit-signatures.sh), in CI and in the deploy workflow (its build, its dry run and the deploy job that holds the token), right after `pnpm install --frozen-lockfile`. It runs `pnpm audit signatures`, which checks npm's signature over every package version in the lockfile, and then [`scripts/ci/lockfile-integrity.ts`](scripts/ci/lockfile-integrity.ts), which verifies, with `node:crypto` and npm's two signing keys, a registry signature over `<name>@<version>:<integrity>` for the integrity that each entry of `pnpm-lock.yaml` records, not the unsigned `dist.integrity` the version document also carries. The keys are pinned in the script (`NPM_KEYS`, copied from `https://registry.npmjs.org/-/npm/v1/keys`), so a registry, mirror or proxy cannot bring its own; the npm CLI takes the same keys from Sigstore's TUF repository, which the script has no client for, so when npm rotates its keys a run fails with "signed only by key ..." until `NPM_KEYS` is updated. As in the npm CLI, a key with an expiry vouches only for a version published before it (the retired key expired 2025-01-29). The script fails on any `packages:` entry it cannot read (a missing or block-style resolution it cannot parse, a semver key with a git or directory resolution, a tarball URL that is not the registry's canonical one); it skips only a key whose version is not semver (a git, URL or file spec), and prints the count. Pointed at another registry with `LOCKFILE_INTEGRITY_REGISTRY`, it fetches that registry's keys unauthenticated, so that guards against an edited lockfile only. The second step exists because pnpm checks the registry's signature over the integrity the registry reports, not over the lockfile's, so an edited lockfile line would pass the first step alone; `npm audit signatures` verified the installed package's own integrity. `pnpm install` checks every tarball it downloads against the lockfile, so together the downloaded bytes are the signed bytes. That holds for what is downloaded, not for a pnpm store restored from the Actions cache, which is installed without its files being checked against the lockfile; so `deploy.yml` restores no package cache in any job (the build job makes the Worker, and the other two hold the token), and `pnpm-pin.test.ts` fails if a `cache:` returns there. The shared setup action used by the CI jobs, which ship nothing, does cache pnpm's store. A registry that cannot be reached is retried (three attempts); a signature that does not verify fails at once. **What is not verified:** `npm audit signatures` also verified the Sigstore provenance attestation that a package publishes (204 of the 307 registry packages in this lockfile do). pnpm 12 has no such check and nothing equivalent is added here, because the usual verifier (the `sigstore` package) would bring `make-fetch-happen` and `http-cache-semantics` back into the lockfile; the trust policy above is the nearest control. The release workflow's verify job takes `pnpm-pin.sh` and `packageManager` from the commit the run started on (a full checkout of it, with history), so backfilling an older release that predates them still works. It then adds the commit being released as `release/` with `git worktree add` from that history, after the pin is installed, and runs only `pnpm install --frozen-lockfile`, `typecheck`, `test` and `build` there. It does not check that commit out with a second `actions/checkout`: CodeQL reads a checkout whose ref is a job output such as `needs.plan.outputs.sha` as untrusted code that can poison the default branch's cache, although `plan` only ever picks a commit that is already on `main`. The job fails if the commit being released names a different pnpm (version and hash) than the pin in the commit the run started on, and says to backfill from a ref whose `packageManager` matches.
- pnpm's `node_modules` is strict: only the direct dependencies' commands are on the path, and no hoisting setting is needed (no `.npmrc`, no `public-hoist-pattern`). The one place it showed was `typecheck`: it used to call `tsc`, which npm found by hoisting the command of TypeScript's inner package, and now calls `tsc6`, the command `@typescript/typescript6` itself ships.
- `@types/node` must match the oldest supported Node (`engines` and `.nvmrc`), so Dependabot skips its major versions. Raise it by hand in the same PR that raises `engines`

## Adding a service

1. Add a catalog entry in `src/lib/status/catalog.ts`
2. Add a collector in `src/lib/status/sources.server.ts`, and call it from `collectAllServices` at the same position as its catalog entry. A test in `src/lib/status/collectors.test.ts` fails until the two lists match
3. Use an **official** machine-readable source (Statuspage JSON, vendor incident JSON, RSS, or a documented public API)
   - **Two exceptions, for vendor pages with no feed.** Microsoft publishes the Windows 11 versions and their build numbers only as a table on its own release health page (`learn.microsoft.com`), with no feed or API that lists new versions and needs no sign-in (the per-version update-history feeds do not announce a new version) (the Microsoft Graph catalogue wants OAuth and an admin role). That table is read as HTML, by a bounded linear scanner in `src/lib/status/windows-release.ts`, and a table that does not have the expected columns reads as unknown. The same goes for the Android versions: Google publishes them only on its releases page (`developer.android.com/about/versions`), which has no feed or API, and the Android Developers Blog's Atom feed that does announce releases keeps only its latest twenty posts (about seven weeks), so it is empty most of the year. The page is read as HTML, by a bounded linear scanner in `src/lib/status/android-release.ts` that collects the `/about/versions/<number>` links whose text is "Android <number>", and a page with none reads as unknown. Any further HTML source needs the same written reason here
4. Document the source in the README table
5. Map vendor states onto `operational | degraded | outage | maintenance | unknown`
6. Test the collector against a trimmed payload in `src/lib/status/__fixtures__` ([how](src/lib/status/__fixtures__/README.md)), with one malformed payload that must read as `unknown`

Do not scrape unofficial aggregators.

**A vendor's release or changelog feed** is not a new service. If the vendor also publishes an official RSS, Atom or JSON feed of its releases, add a source object to `RELEASE_SOURCES` in `src/lib/status/release-feeds.server.ts` (feed URL, the vendor's page, the hosts its links may be on, and how an entry becomes a title and notes), list it in the README's release feed table, and add a hand-built fixture, a test of the entry it yields, a malformed and an empty payload that must fail as a parser failure, and a case in `redos.test.ts` for any new regular expression. The feed adds one line to the card and never touches its health; to drop a feed, delete its object. A feed is read at most every 30 minutes per isolate, so count it against the subrequest budget in [SECURITY.md](SECURITY.md#release-feeds).

## Code style

- [Biome](https://biomejs.dev/) formats, lints and sorts imports ([`biome.json`](biome.json)); `pnpm run lint:fix` applies it. A `biome-ignore` comment must say why
- TypeScript strict, no `any`
- No unused locals, imports or parameters: `tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so `pnpm run typecheck` fails on them. Prefix a parameter that a signature requires but the body ignores with `_`
- Tokens live in `src/styles.css`; do not sprinkle raw hex in JSX (`scripts/ci/tokens.sh` checks). Every colour token has a light and a dark value, written with `light-dark()`. The build compiles that into toggles keyed on the system's `prefers-color-scheme`, so the whole page follows the system and `color-scheme` on one element does not switch its tokens. The theme clears Tailwind's default fonts and radii, so a stale `font-mono` or `rounded-xl` does nothing: use the tokens
- Text must clear 4.5:1 on every material's flat fill (the page, the card and the inset). A browser test proves it: on a fixture board with every state, incident times and the Stale badge ([`e2e/fixture-board.ts`](e2e/fixture-board.ts)), in light and dark, with and without Increase Contrast and on each background, it strips blur, gradients and pseudo-elements and runs axe's colour-contrast rule. The Full background's lenses have a pixel test of their own (below)
- Design, Quiet Hand: warm paper in light, true black in dark, opaque panels with a hairline, and colour rationed to small exact points. Emphasis has three moves only: size, weight and the presence of colour
  - A status is a glyph, a coloured word and nothing else: `StatusGlyph` draws the shape (outline circle and check, solid triangle, solid octagon, dashed circle, half circle) and `STATUS_TEXT` colours the word. The healthier a thing is, the lighter its mark. There are no status chips; `Tag` is for "Changed" and "New release" only
  - Type: SF first (`-apple-system`), Inter (self-hosted, `src/fonts`, served from hashed `/assets/` names, rebuilt by `scripts/fonts.sh`) where there is no system face, tabular numerals for anything that changes, and sentence case everywhere: no monospace, no all caps, no letter-spaced labels. Size, line, tracking and weight travel together in the `--text-*` steps (`text-body`, `text-caption`, ...); no arbitrary `text-[Npx]`. The handwriting (`font-hand`, `HandNote`) is the signature only, at most twice on a page
  - The hand: `PenUnderline` under the headline's count and `PenLoop` round a service in outage, both drawn from constants in `pen-marks.ts` (rebuilt by `node scripts/pen-paths.mjs`, never computed at render time, since a `Math.sin` that differs by a digit between the server and the browser is a hydration mismatch). The pen draws once, and never on a refetch
  - Times are the viewer's own after hydration and UTC before it (`LocalTime`), with the whole moment in UTC as the `title`. Never format a time on the server in a zone
  - The floating bar (`.float`) is the only translucent layer in Quiet; `.surface` (a card or a grouped list), `.inset`, `.control` and `.sheet` are opaque. Nothing else casts a shadow
  - Four radii and no pill: `sm` 6, `md` 10, `lg` 16, `bar` 20, and `thumb` 8 for a thumb inside a `md` track. A nested shape takes its parent's radius minus the inset between them. `rounded-full` is for dots and glyph rings only, and Tailwind's default radius scale is switched off
  - `text-card` is the 22/26 title step, which is why the card fill is `bg-card`, `border-card` and `fill-card` utilities and not a `--color-card` theme colour (that would also generate a `text-card` colour)
  - Backgrounds: Quiet (the default), Glass and Full, chosen in Settings and kept in `localStorage` as `status-bar:background`. `src/background.css` holds every layer: the aurora, the eleven `.lens` glass bubbles, the frosted panels, the wandering card light and the period dial's CSS. Its rules are behind two gates, `:root:is([data-background="glass"], [data-background="full"])` and `:root[data-background="full"]`, and the markup for every layer is always rendered so the server's HTML and the hydrated page never differ. Reduce glass, `prefers-reduced-transparency`, Increase Contrast and forced colours switch the layers off and make the panels opaque whatever is chosen
  - The layers are painted only (never `backdrop-filter`, never above the content); each bubble's place, size and float are fixed per-position numbers in `src/background.css` (no `Math.random`, so the server and the browser agree), and only `transform`-class properties (`translate`, `transform`, `scale`) animate, as the bubbles' float does under `(hover: hover) and (pointer: fine)`, in Full, never under Reduce Motion. Eleven bubbles on a wide screen, nine at laptop and tablet widths and the first six on a phone, each width with its own places so none sits over the margin column's bare text (`e2e/lenses.spec.ts` checks). The bubble tokens (`--lens-*`) hold a contrast budget: `--color-subtle` and `--color-muted` stay at 4.5:1 or better on every bubble pixel more than 3px inside the rim (the highlights included, which is why dark's are so faint), in light and dark, and only the rim hairline (the outer 3px) is exempt. The axe test cannot see these layers, so `e2e/lenses.spec.ts` measures the pixels itself, on the Full background; run it when you change a token (dark is the tight side)
  - `public/lens-map.png`, the displacement map the lens filter reads, is generated: run `node scripts/lens-map.mjs` to rebuild it, and it comes out byte for byte the same each time. Change the script, never the PNG by hand
- Never glass on glass: on the Glass and Full backgrounds, inside a `.surface`, `.float` or `.sheet` nest only `.control` or `.inset`
- Performance: no `will-change: backdrop-filter`, never animate a blur or a `filter`, and animate `transform` and `opacity` only. The one exception is a registered custom property on a small element, stepped so it repaints rarely, as the period dial does once a second. The other exception is the search dock's width, driven by `--dock` from 64rem up; one small contained element, no blur. Blur stays at 24px for `.surface` and 28px for `.sheet`
- Motion has three durations (`--t-quick` 150ms, `--t-reveal` 250ms, `--t-draw` 400ms) and one easing (`--ease-out`). The bar's copy of the search field, below 64rem, comes in over `--t-reveal` and leaves over `--t-quick`, with opacity and translate only, and steps under Reduce Motion; nothing loops while the board is healthy. Cards that change place (a star, a refresh) glide with FLIP: `withCardMotion` in [`src/components/status/effects.ts`](src/components/status/effects.ts) measures them, applies the update, and animates `transform` from the old place to the new one, and nothing else. Never use the View Transitions API for this, and never give a card a `view-transition-name`: a named card is captured by every transition, so one star pays for the whole board, and WebKit takes seconds. The glide must leave the DOM alone, so focus and node identity survive, and it must stay off under reduced motion
- Light that follows the device (Tilt lighting) is driven only through `--light-x` and `--light-y`, written by `src/components/status/use-tilt-lighting.ts` inline on the panels (`.surface`, `.float`, `.sheet`, `.spotlight`). It draws only on the Glass and Full backgrounds, so the hook stands down on Quiet. They are plain custom properties that the panels' `::before` and `::after` inherit; do not register them as non-inherited and hand them over with `inherit` (WebKit then draws the pseudo-elements as if they were unset, so the light does not move on an iPhone), and do not write them on `:root` or through a style sheet rule, either of which makes the browser re-style the whole page. It pauses under Reduce glass and `prefers-reduced-motion`, and nothing may depend on it. Do not move the aurora with it
- New motion goes under `prefers-reduced-motion` (the global rule in `src/styles.css` already stops every animation), and new translucency in `src/background.css` behind the Glass gate, with a Reduce glass override
- Newer CSS is welcome where it degrades to something correct: `@starting-style` and `linear()` easing are used unconditionally, since a browser without them just skips the flourish. Container queries lay out the card grids, which stay a single column without them; every engine the board supports has had them since Safari 16 and Chrome 105. Anything whose absence would break layout or meaning, such as scroll-driven animations, goes behind `@supports` and stays decorative
- Card internals respond to the card's own width with container-query variants (`@xs:`), not the viewport's (`sm:`), since a card's width depends on its group's grid and the margin column, not on the viewport
- Keep fetch timeouts short and failures isolated (`Promise.all` of per-service collectors)
