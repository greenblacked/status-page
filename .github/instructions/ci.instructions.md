---
applyTo: "scripts/ci/**,.github/workflows/**,.github/actions/**"
---
# CI scripts and workflows

Full rules: [AGENTS.md](../../AGENTS.md#security-and-supply-chain), [CONTRIBUTING.md#ci](../../CONTRIBUTING.md#ci) and [CONTRIBUTING.md#dependencies](../../CONTRIBUTING.md#dependencies); workflow overview in [.github/workflows/README.md](../workflows/README.md). If they differ from this file, they and the scripts win.

- Pin every GitHub Action to a full commit SHA with the version in a trailing comment.
- Workflows default to `permissions: contents: read`; request more per job only. No `pull_request_target`. The two `workflow_run` workflows (`ci-triage.yml`, `rerun-infra.yml`) never check out or run pull request code.
- The Cloudflare token is an environment secret reachable only by the `deploy.yml` job for `stage` and `main`. Pull request code never runs with it.
- A deliberate zizmor exception carries `# zizmor: ignore[<audit>]` with its reason next to it.
- pnpm is installed through `scripts/ci/pnpm-pin.sh` (Corepack checks the sha512 in `packageManager`), never `npm install --global pnpm`. Installs use `--frozen-lockfile`, then `scripts/ci/audit-signatures.sh`.
- `CI OK` is the one aggregate required check. A red check is fixed in code, never by weakening the check, skipping a test or lowering a coverage threshold.
- When `@playwright/test` moves, the Playwright image tag and digest in `ci.yml` move with it.
- Branch names are checked by `scripts/ci/branch.sh` and commit subjects by `scripts/ci/commits.sh` (Conventional Commits, 72 characters at most); do not loosen them.
- Run what applies: `./scripts/ci/hygiene.sh`, `./scripts/ci/links.sh`, `shellcheck scripts/ci/*.sh scripts/release/*.sh` for shell scripts, and actionlint and zizmor for workflows, when installed.
- Changes under `.github/`, `scripts/` and `wrangler.jsonc` are code-owner paths.
