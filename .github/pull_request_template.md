## What changes

<!-- The user-visible change, in one or two sentences. -->

## Why

<!-- The decision a future reader cannot recover from the diff. -->

## Checklist

- [ ] Commits follow [Conventional Commits](../CONTRIBUTING.md#commits) (`<type>(<scope>): <imperative summary>`, subject ≤ 72 chars)
- [ ] `pnpm run typecheck` and `pnpm test` pass locally
- [ ] `./scripts/ci/hygiene.sh` and `./scripts/ci/links.sh` pass locally
- [ ] README updated in the same commit if vendor coverage or health rules changed
- [ ] `CHANGELOG.md` has a line under `## [Unreleased]` if the change is user-visible
- [ ] New services read an **official** machine-readable source, documented in the README table
- [ ] No secrets, `.env` files, or vendor credentials

Fixes #
