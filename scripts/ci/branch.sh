#!/usr/bin/env bash
# Check a branch name against CONTRIBUTING.md#branches:
# <prefix>/<short-kebab-description>, prefix one of fb, fix, chore, docs, ci.
# Given the pull request's base branch too, also check which branches may open
# a pull request into stage and main.
# Run locally: ./scripts/ci/branch.sh "$(git branch --show-current)" [base]
# CI sets FROM_FORK=true on a pull request from a fork: a fork's branch called
# dev or stage is not the repository's.
set -euo pipefail

name="${1:?usage: branch.sh <branch-name> [<base-branch>]}"
base="${2:-}"
prefixes='fb|fix|chore|docs|ci'
max=50

# Promotion is dev to stage, then stage to main, by the owner
# (CONTRIBUTING.md#branches). main is never a head branch: resolving a
# conflict on a main-to-dev pull request commits dev's work to main and
# releases it (CONTRIBUTING.md#releases has the safe way). stage heads only
# the pull request into main, and dev only the one into stage.
if [[ "$name" == dev || "$name" == stage ]]; then
  if [[ "${FROM_FORK:-false}" == true ]]; then
    echo "::error::branch  $name: a fork's $name is not the repository's; branch from dev and name the branch <prefix>/<short-kebab-description> (CONTRIBUTING.md#branches)" >&2
    exit 1
  fi
  case "$name:$base" in
    dev:stage | stage:main | dev: | stage:)
      echo "ok  branch  $name (long-lived)"
      exit 0
      ;;
  esac
  echo "::error::branch  $name: a pull request into $base cannot come from $name; promotion is dev to stage, then stage to main (CONTRIBUTING.md#branches)" >&2
  exit 1
fi

# Branches that tools name for us: Dependabot updates and bump.sh releases.
tooling=false
if [[ "$name" =~ ^dependabot/ || "$name" =~ ^release/v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  tooling=true
else
  if [[ ! "$name" =~ ^($prefixes)/[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "::error::branch  $name: expected <prefix>/<short-kebab-description>, prefix one of ${prefixes//|/, }, lowercase letters, digits and single hyphens (CONTRIBUTING.md#branches)" >&2
    exit 1
  fi
  if (( ${#name} > max )); then
    echo "::error::branch  $name: ${#name} characters, keep it to $max (CONTRIBUTING.md#branches)" >&2
    exit 1
  fi
fi

# Everything else goes into dev. main takes stage (above) and bump.sh's
# release/vX.Y.Z pull request; stage takes dev (above) and chore/sync-main, the
# way to resolve a conflict when release.yml cannot merge main into stage
# (CONTRIBUTING.md#releases).
case "$base" in
  main)
    if [[ ! "$name" =~ ^release/v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "::error::branch  $name: pull requests into main come from stage, not $name; open it into dev (CONTRIBUTING.md#branches)" >&2
      exit 1
    fi
    ;;
  stage)
    if [[ "$name" != chore/sync-main ]]; then
      echo "::error::branch  $name: pull requests into stage come from dev, not $name; open it into dev (CONTRIBUTING.md#branches)" >&2
      exit 1
    fi
    ;;
esac

if [[ "$tooling" == true ]]; then
  echo "ok  branch  $name (named by tooling)"
else
  echo "ok  branch  $name"
fi
