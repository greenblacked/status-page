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

> **`dev` is paused.** For now, branch from `stage` and open the pull request into `stage`, squash-merged; `stage` still goes to `main` with a merge commit. Nothing else changes. The `stage` ruleset must allow squash merges meanwhile (see [Branch protection](#branch-protection)). To bring `dev` back, recreate it from `stage`, set `DEV_PAUSED=false` at the top of [`scripts/ci/branch.sh`](scripts/ci/branch.sh) (the one switch the branch name check reads), and set `stage`'s allowed merge method back to a merge commit only. The rest of this page describes the flow with `dev` active.

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
- **Tooling names its own branches.** Dependabot opens `dependabot/…`, and [`scripts/release/bump.sh`](scripts/release/bump.sh) opens `release/vX.Y.Z`. Don't create either by hand.

The **branch name** job in [CI](.github/workflows/ci.yml) fails a pull request whose branch breaks these rules. It also checks where the pull request goes: `main` takes only `stage` (and the `release/vX.Y.Z` branch that [`scripts/release/bump.sh`](scripts/release/bump.sh) opens), `stage` takes only `dev` (and `chore/sync-main`, see [Releases](#releases)), and `dev` takes everything else. While `dev` is paused, `stage` also takes everything else, a fork's feature branch included, and `main` still takes only `stage` and `release/vX.Y.Z`. `dev` and `stage` are accepted as head branches for those two promotions only, and never from a fork; `main` is never a head branch. A Dependabot security update opens against `main`, the default branch: change its base to `dev` (to `stage` while `dev` is paused). Check a name before pushing, with the base branch as a second argument for the full check:

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

The tests run in five projects: `desktop` and `mobile` on Chromium, and `Desktop Safari`, `iPhone 17 Pro` and `iPad Pro 11` on WebKit, Safari's engine. Pick some with `--project`, for example `npm run test:e2e -- --project=desktop --project="iPhone 17 Pro"`. On Linux, WebKit needs system libraries: `npx playwright install --with-deps webkit` installs them. `PLAYWRIGHT_PORT` moves the preview the tests start off port 4173. The Tilt lighting tests (`e2e/tilt.spec.ts`) need no sensor: they dispatch synthetic `deviceorientation` events and stub iOS's motion permission request, and on an engine without `DeviceOrientationEvent` (Playwright's WebKit on Linux) they supply an empty one.

[`ci.yml`](.github/workflows/ci.yml) splits the work into one job per concern, so a red check names its cause: `lint`, `typecheck`, `test` and `build` (each on the pinned Node and on Node 24), `browser tests` (four shards: `chromium`, `desktop-safari`, `iphone` and `ipad`; the three WebKit shards run in Playwright's own image, pinned by digest, so they fetch no system libraries from apt: when `@playwright/test` moves, move the image tag and digest in `ci.yml` with it, and the shards' `Check the browser` step says so if they differ; Dependabot opens Playwright bumps on their own for that), `commit messages`, `branch name` and `workflow lint`. Every job gets its toolchain from [`.github/actions/setup`](.github/actions/setup/action.yml): Node, the npm version in `packageManager` (installed from a hash-locked lockfile, see [Dependencies](#dependencies)), `npm ci` and a registry signature check.

**`CI OK` is the one check to require.** It needs every job above and passes only when none of them failed or was cancelled (the commit and branch checks are skipped outside pull requests, which is fine). Requiring it alone means a renamed or added job never needs a branch protection change. The same jobs run on pull requests into `dev`, `stage` and `main` and on pushes to each of them. In **Settings → Rules → Rulesets** each of the three requires a pull request and these status checks: `CI OK`, `pull request title`, `analyze (javascript-typescript)`, `analyze (actions)` and `dependency-review`. [Branch protection](#branch-protection) has the exact settings and the API commands.

Coverage has thresholds in [`vitest.config.ts`](vitest.config.ts), set just under the current numbers, so `npm run test:coverage` fails if coverage drops. When coverage goes up, raise them in the same pull request. The pinned-Node test job writes coverage to its summary and uploads the HTML report, and a failed browser test shard uploads its Playwright report with traces, as `playwright-report-<shard>`.

The parsers that read vendor input are also fuzzed. [`src/lib/status/fuzz.test.ts`](src/lib/status/fuzz.test.ts) uses [fast-check](https://fast-check.dev/) to feed the bounds, the changelog and Windows release parsers and the feed and payload helpers of `sources.server.ts` generated garbage (broken markup, lone surrogates, dates no `Date` holds, any JSON) and states what must hold for all of it: no throw, output inside its documented ceilings, and linear time on crafted repetition. It runs with `npm test` on a fixed seed (a few seconds), so a run is the same everywhere and a failure prints its counterexample and seed. To search wider, for example before a release: `FUZZ_SEED=<n> FUZZ_RUNS=2000 npx vitest run src/lib/status/fuzz.test.ts`. When it finds a bug, fix it and add the shrunk input to the parser's own `*.test.ts` as a plain case. This is also what OpenSSF Scorecard's Fuzzing check looks for (an import of `fast-check` in a `.ts` file), so keep the import in a test file.

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
4. Tags the commit `vX.Y.Z` and creates the GitHub Release as a draft on that tag, with that section as its notes. A draft is visible only to people who can write to the repository.
5. Signs and publishes the release. A separate `sign release` job archives the tag (`git archive`) as `status-page-vX.Y.Z.tar.gz`, signs it keylessly with [Sigstore cosign](https://docs.sigstore.dev/cosign/signing/overview/) under the workflow's GitHub identity, checks the signature with `cosign verify-blob` (a bad one fails the run before anything is attached), uploads the archive and its bundle, `status-page-vX.Y.Z.tar.gz.sigstore.json`, to the draft, and only then publishes it. It fails instead of signing if the tag no longer names the commit the run tagged. The Latest badge is worked out from the published releases at that moment, so a backfill never takes it from a newer release. A release that is already public (made before signing was added, by hand, or by an earlier run) only gets whichever of the two assets it lacks, and existing ones are never replaced, but they are checked first: a present pair must pass `cosign verify-blob`, a lone archive must match the freshly built one byte for byte (same sha256), and a lone bundle must verify the fresh archive. Any mismatch fails the run instead of attaching a signature for different bytes. The job is the only one in `release.yml` with `id-token: write`, and it runs no project code.
6. Merges `main` back into `stage` and then `dev`, released or not, so both carry the release commit and anything that reached `main` without going through `stage`, such as a `release/vX.Y.Z` bump. When that merge actually moves `stage`, it also starts [`deploy.yml`](.github/workflows/deploy.yml) on `stage` by hand: the merge is pushed with a token that starts no workflow of its own, so without this, the preview would keep running the pre-release code until an unrelated push to `stage` updated it. `dev` deploys nothing, so its merge needs no follow-up. A release on `main` while `stage` or `dev` has lines under Unreleased conflicts on `CHANGELOG.md`. The job resolves that case itself: it keeps `main`'s released section and puts the branch's lines back under Unreleased ([`scripts/release/merge-changelog.sh`](scripts/release/merge-changelog.sh)). Any other conflict fails the job, after it has tried the other branch, and you resolve it on a branch from the one that conflicted:

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
| [`scripts/release/bump.sh`](scripts/release/bump.sh) `minor` | Makes the same bump commit locally on `release/vX.Y.Z` for review in a pull request. Merging it releases that version as it is. |
| **Run workflow** with `version` and `commit` | Backfills an older release: tags that commit on `main` with a version whose section is already in `main`'s changelog, and publishes it without taking Latest from a newer published release. `gh workflow run release.yml --ref main -f version=0.1.1 -f commit=4cf30fd` |
| A tag pushed by hand | `git tag -a v0.4.0 -m "Status Page 0.4.0" && git push origin v0.4.0` publishes that tag, if it matches `package.json` and is on `main`. |

The bump commit and the tag are pushed with the workflow's `GITHUB_TOKEN`, so they start no other workflow and CI does not run on the bump commit itself. The verify job has already checked the same code.

A ruleset on `main`, `stage` or `dev` that requires pull requests or status checks rejects the workflow's direct pushes to it (the release commit, and the merges of `main` back) unless GitHub Actions is a bypass actor; [Branch protection](#branch-protection) adds it. Without that, release with `bump.sh` and a pull request into `main`, and bring `main` into `stage` and `dev` through a `chore/sync-main` branch and pull request (see above).

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
- **Nothing but wrangler runs beside it.** The job that holds the token installs with `npm ci --ignore-scripts`, so no dependency install script runs there, and checks that install with `npm audit signatures`, so the wrangler that runs beside the token is the one the registry signed. It also runs no build, no npm script and no project JavaScript: it only uploads what the build job made (`no_bundle`), and only its deploy, preview and rollback steps see the token. The repository files it runs are three shell scripts from the same protected branch as the deploy, each in a step without the token: [`scripts/ci/npm-pin.sh`](scripts/ci/npm-pin.sh), which installs the pinned npm from `tools/npm` with `npm ci --ignore-scripts`, [`scripts/ci/audit-signatures.sh`](scripts/ci/audit-signatures.sh), which retries the signature check only when npm cannot load a verification key, and the post-deploy smoke test, [`scripts/ci/smoke.sh`](scripts/ci/smoke.sh) (bash, curl and jq).
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
| `npm run build:cf` | `DEPLOY_TARGET=cloudflare vite build` | The Worker in `dist/`, the same for every branch |
| `npm run preview:cf` | `DEPLOY_TARGET=cloudflare vite preview --host 127.0.0.1` | Runs that build in workerd, Cloudflare's runtime, without storage bindings |
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

Dependabot proposes npm (the project, and the pinned npm CLI in `tools/npm`) and GitHub Actions updates weekly, grouped into production dependencies, development dependencies and Actions.

- Actions stay pinned to a full commit SHA with the version in a trailing comment
- A new release is proposed only after a cooldown, 7 days for npm and 3 for Actions, so a hijacked release that is pulled within days never reaches the lockfile. Security updates are not held back
- npm itself is pinned twice over: `packageManager` in `package.json` names the version, and [`tools/npm`](tools/npm/package.json) holds a lockfile for exactly that `npm` package, with the tarball's sha512. CI and the deploy and release workflows install it with `npm ci --prefix tools/npm --ignore-scripts` (through [`scripts/ci/npm-pin.sh`](scripts/ci/npm-pin.sh)) and put it first on `PATH`, instead of `npm install --global npm@<version>`, which trusts the registry to serve the right bytes for a name. The `lint` job (`npm-pin.sh check`) and the unit tests fail if `packageManager`, `tools/npm/package.json` and its lockfile name different versions. Dependabot proposes new npm releases for `tools/npm`; that PR stays red until `packageManager` is moved to the same version in it. To move by hand, edit `packageManager`, then run `npm install --package-lock-only --ignore-scripts --save-exact npm@<version> --prefix tools/npm`
- npm 12 blocks dependency install scripts unless `allowScripts` in `package.json` allows them, and runs only on Node `^22.22.2 || ^24.15.0` (`engines` and `.nvmrc` follow it). The install scripts of `esbuild`, `workerd` and `fsevents` only check or swap in the prebuilt binary that the platform package already ships, so `allowScripts` denies them and `npm ci` stays quiet. List a new dependency there (`npm install-scripts approve <pkg>` or `deny <pkg>`) when `npm ci` warns that its script was blocked.
- **One narrow scanner exception covers the pinned npm's bundled dependencies.** The lockfile in `tools/npm` lists the packages that npm 12.1.0 bundles inside itself, and two of them carry advisories: brace-expansion 5.0.9 (GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) and undici 6.28.0 (GHSA-rfgv-xxqx-mfg5). That npm runs in CI only and never ships to users, and every published npm (11.19.1, 11.20.0, 12.1.0) bundles these same versions, so bumping the pin does not clear them; before the pin, `npm install -g` ran the same code and nothing scanned it. Dependency review allows exactly these three IDs (`allow-ghsas` in [`dependency-review.yml`](.github/workflows/dependency-review.yml)), and trivy ignores them, and their CVE aliases, only in `tools/npm/package-lock.json` ([`.trivyignore.yaml`](.trivyignore.yaml), which `docker compose run --rm security` reads). Trivy's entries expire on 2026-12-31, when the scan fails again; review the exception by then. Remove it once npm bundles brace-expansion 5.0.12 or later and undici 6.28.1 or later. `npm-pin.test.ts` fails if either list gains an ID, a path is dropped or an entry has no expiry
- **OpenSSF Scorecard reads the same exception from [`tools/npm/osv-scanner.toml`](tools/npm/osv-scanner.toml).** Its Vulnerabilities check runs OSV-Scanner, which finds that file because it sits next to the lockfile, and skips the ten advisories listed in it (brace-expansion 5.0.9, ip-address 10.5.0 and undici 6.28.0, all bundled inside the pinned npm CLI, none in the app's lockfile or the Worker bundle). Each entry carries `ignoreUntil = 2026-12-01`, so the exception lapses on that date and Scorecard reports the advisories again. Before then, remove the entries Dependabot's new npm release fixes, or re-justify the rest by moving the date. `npm-pin.test.ts` fails if the list gains an ID, an entry has no expiry or another `osv-scanner.toml` is tracked anywhere in the repository (one beside the app's lockfile would hide advisories in its own dependencies)
- Every install in CI and in the deploy workflow (its build, its dry run and the deploy job that holds the token) runs `npm audit signatures` right after `npm ci`, so a tarball that does not match the registry's signature fails the run. The pinned npm in `tools/npm` is checked the same way, by `npm-pin.sh install` right after its `npm ci` and with the runner's own npm, so the pinned npm never verifies itself. The release workflow's verify job takes `npm-pin.sh`, `audit-signatures.sh` (which `npm-pin.sh install` runs), `tools/npm` and `packageManager` from the commit the run started on (a full checkout of it, with history), so backfilling an older release that predates them still works. It then adds the commit being released as `release/` with `git worktree add` from that history, after the pin is installed, and runs only `npm ci`, `typecheck`, `test` and `build` there. It does not check that commit out with a second `actions/checkout`: CodeQL reads a checkout whose ref is a job output such as `needs.plan.outputs.sha` as untrusted code that can poison the default branch's cache, although `plan` only ever picks a commit that is already on `main`. The job fails if the commit being released names a different npm than the pin in the commit the run started on, and says to backfill from a ref whose `packageManager` matches.
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

## Code style

- [Biome](https://biomejs.dev/) formats, lints and sorts imports ([`biome.json`](biome.json)); `npm run lint:fix` applies it. A `biome-ignore` comment must say why
- TypeScript strict, no `any`
- No unused locals, imports or parameters: `tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so `npm run typecheck` fails on them. Prefix a parameter that a signature requires but the body ignores with `_`
- Tokens live in `src/styles.css`; do not sprinkle raw hex in JSX (`scripts/ci/tokens.sh` checks). Every colour token has a light and a dark value, written with `light-dark()`. The build compiles that into toggles keyed on the system's `prefers-color-scheme`, so the whole page follows the system and `color-scheme` on one element does not switch its tokens. The theme clears Tailwind's default fonts and radii, so a stale `font-mono` or `rounded-xl` does nothing: use the tokens
- Text must clear 4.5:1 on every material's flat fill (the page, the card and the inset). A browser test proves it: on a fixture board with every state, incident times and the Stale badge ([`e2e/fixture-board.ts`](e2e/fixture-board.ts)), in light and dark, with and without Increase Contrast and on each background, it strips blur, gradients and pseudo-elements and runs axe's colour-contrast rule. The Full background's lenses have a pixel test of their own (below)
- Design, Quiet Hand: warm paper in light, true black in dark, opaque panels with a hairline, and colour rationed to small exact points. Emphasis has three moves only: size, weight and the presence of colour
  - A status is a glyph, a coloured word and nothing else: `StatusGlyph` draws the shape (outline circle and check, solid triangle, solid octagon, dashed circle, half circle) and `STATUS_TEXT` colours the word. The healthier a thing is, the lighter its mark. There are no status chips; `Tag` is for "Changed" and "New release" only
  - Type: SF first (`-apple-system`), Inter (self-hosted, `public/fonts`, rebuilt by `scripts/fonts.sh`) where there is no system face, tabular numerals for anything that changes, and sentence case everywhere: no monospace, no all caps, no letter-spaced labels. Size, line, tracking and weight travel together in the `--text-*` steps (`text-body`, `text-caption`, ...); no arbitrary `text-[Npx]`. The handwriting (`font-hand`, `HandNote`) is the signature only, at most twice on a page
  - The hand: `PenUnderline` under the headline's count and `PenLoop` round a service in outage, both drawn from constants in `pen-marks.ts` (rebuilt by `node scripts/pen-paths.mjs`, never computed at render time, since a `Math.sin` that differs by a digit between the server and the browser is a hydration mismatch). The pen draws once, and never on a refetch
  - Times are the viewer's own after hydration and UTC before it (`LocalTime`), with the whole moment in UTC as the `title`. Never format a time on the server in a zone
  - The floating bar (`.float`) is the only translucent layer in Quiet; `.surface` (a card or a grouped list), `.inset`, `.control` and `.sheet` are opaque. Nothing else casts a shadow
  - Four radii and no pill: `sm` 6, `md` 10, `lg` 16, `bar` 20, and `thumb` 8 for a thumb inside a `md` track. A nested shape takes its parent's radius minus the inset between them. `rounded-full` is for dots and glyph rings only, and Tailwind's default radius scale is switched off
  - `text-card` is the 22/26 title step, which is why the card fill is `bg-card`, `border-card` and `fill-card` utilities and not a `--color-card` theme colour (that would also generate a `text-card` colour)
  - Backgrounds: Quiet (the default), Glass and Full, chosen in Settings and kept in `localStorage` as `status-bar:background`. `src/background.css` holds every layer: the aurora, the eleven `.lens` glass bubbles, the frosted panels, the wandering card light and the period dial's CSS. Its rules are behind two gates, `:root:is([data-background="glass"], [data-background="full"])` and `:root[data-background="full"]`, and the markup for every layer is always rendered so the server's HTML and the hydrated page never differ. Reduce glass, `prefers-reduced-transparency`, Increase Contrast and forced colours switch the layers off and make the panels opaque whatever is chosen
  - The layers are painted only (never `backdrop-filter`, never above the content); each bubble's place, size and float are fixed per-position numbers in `src/background.css` (no `Math.random`, so the server and the browser agree), and only `transform`-class properties (`translate`, `transform`, `scale`) animate, as the bubbles' float does under `(hover: hover) and (pointer: fine)`, in Full, never under Reduce Motion. Eleven bubbles on a wide screen, nine at laptop and tablet widths and the first six on a phone, each width with its own places so none sits over the margin column's bare text (`e2e/lenses.spec.ts` checks). The bubble tokens (`--lens-*`) hold a contrast budget: `--color-subtle` and `--color-muted` stay at 4.5:1 or better on every bubble pixel more than 3px inside the rim (the highlights included, which is why dark's are so faint), in light and dark, and only the rim hairline (the outer 3px) is exempt. The axe test cannot see these layers, so `e2e/lenses.spec.ts` measures the pixels itself, on the Full background; run it when you change a token (dark is the tight side)
  - `public/lens-map.png`, the displacement map the lens filter reads, is generated: run `node scripts/lens-map.mjs` to rebuild it, and it comes out byte for byte the same each time. Change the script, never the PNG by hand
- Never glass on glass: on the Glass and Full backgrounds, inside a `.surface`, `.float` or `.sheet` nest only `.control` or `.inset`
- Performance: no `will-change: backdrop-filter`, never animate a blur or a `filter`, and animate `transform` and `opacity` only. The one exception is a registered custom property on a small element, stepped so it repaints rarely, as the period dial does once a second. The other exception is the search dock's width, driven by `--dock`; one small contained element, no blur. Blur stays at 24px for `.surface` and 28px for `.sheet`
- Motion has three durations (`--t-quick` 150ms, `--t-reveal` 250ms, `--t-draw` 400ms) and one easing (`--ease-out`); the search field's merge into the bar on a phone also waits `--t-dock-lead` (50ms, `DOCK_LEAD_MS` in `dock.ts`) before it moves, drawn at its starting size meanwhile, so that a start the browser draws late (seen on an iPhone, not yet confirmed fixed there) comes out of the wait and not out of the motion; nothing loops while the board is healthy. Cards that change place (a star, a refresh) glide with FLIP: `withCardMotion` in [`src/components/status/effects.ts`](src/components/status/effects.ts) measures them, applies the update, and animates `transform` from the old place to the new one, and nothing else. Never use the View Transitions API for this, and never give a card a `view-transition-name`: a named card is captured by every transition, so one star pays for the whole board, and WebKit takes seconds. The glide must leave the DOM alone, so focus and node identity survive, and it must stay off under reduced motion
- Light that follows the device (Tilt lighting) is driven only through `--light-x` and `--light-y`, written by `src/components/status/use-tilt-lighting.ts` inline on the panels (`.surface`, `.float`, `.sheet`, `.spotlight`). It draws only on the Glass and Full backgrounds, so the hook stands down on Quiet. They are plain custom properties that the panels' `::before` and `::after` inherit; do not register them as non-inherited and hand them over with `inherit` (WebKit then draws the pseudo-elements as if they were unset, so the light does not move on an iPhone), and do not write them on `:root` or through a style sheet rule, either of which makes the browser re-style the whole page. It pauses under Reduce glass and `prefers-reduced-motion`, and nothing may depend on it. Do not move the aurora with it
- New motion goes under `prefers-reduced-motion` (the global rule in `src/styles.css` already stops every animation), and new translucency in `src/background.css` behind the Glass gate, with a Reduce glass override
- Newer CSS is welcome where it degrades to something correct: `@starting-style` and `linear()` easing are used unconditionally, since a browser without them just skips the flourish. Container queries lay out the card grids, which stay a single column without them; every engine the board supports has had them since Safari 16 and Chrome 105. Anything whose absence would break layout or meaning, such as scroll-driven animations, goes behind `@supports` and stays decorative
- Card internals respond to the card's own width with container-query variants (`@xs:`), not the viewport's (`sm:`), since a card's width depends on its group's grid and the margin column, not on the viewport
- Keep fetch timeouts short and failures isolated (`Promise.all` of per-service collectors)
