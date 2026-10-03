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
  echo "::error::$what: ${ref}'s ruleset blocks GitHub Actions; add GitHub Actions (integration 15368) to its bypass list - CONTRIBUTING.md#branch-protection"
else
  echo "::error::$what failed for a reason other than a ruleset or a newer push; the git output above says why (CONTRIBUTING.md#releases)"
fi
