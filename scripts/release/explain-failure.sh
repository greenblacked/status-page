#!/usr/bin/env bash
# Turn the captured output of a failed push (or of a gh api call that creates
# a ref) into one ::error:: annotation that names the cause and the fix.
# Usage: explain-failure.sh <what> <branch-or-tag> <<<"$output>"
# The output is read from stdin and only matched, never run or interpolated
# into a command. Always exits 0; the caller fails the job.
set -euo pipefail

what="${1:?usage: explain-failure.sh <what> <ref>}"
ref="${2:?usage: explain-failure.sh <what> <ref>}"
output="$(cat)"

if grep -qiE 'GH013|Repository rule violations' <<<"$output"; then
  case "$ref" in
    main)
      echo "::error::$what: main's ruleset refused GitHub Actions' push; nothing was released. Release with ./scripts/release/bump.sh <level|X.Y.Z> from an up-to-date main (it creates release/vX.Y.Z) and a pull request into main (merge commit) - CONTRIBUTING.md#releases. Adding GitHub Actions to the bypass list is an alternative only where the GitHub settings offer it (organisation repositories, or via the API)"
      ;;
    stage | dev)
      echo "::error::$what: ${ref}'s ruleset refused GitHub Actions' push; bring main in through a chore/sync-main branch and a pull request (merge commit) - CONTRIBUTING.md#releases"
      ;;
    *)
      echo "::error::$what: a ruleset refused GitHub Actions' request for ${ref}; check the rulesets that cover it - CONTRIBUTING.md#branch-protection"
      ;;
  esac
else
  echo "::error::$what failed for a reason other than a ruleset or a newer push; the git output above says why (CONTRIBUTING.md#releases)"
fi
