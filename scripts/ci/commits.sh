#!/usr/bin/env bash
# Enforce the Conventional Commits rules from CONTRIBUTING.md on a commit range.
# Run locally: ./scripts/ci/commits.sh origin/dev..HEAD
#   ./scripts/ci/commits.sh --subject "feat: add a feed"
#     Checks one subject, such as a pull request title: a squash merge makes
#     it the commit on dev, and release.yml reads its type once it reaches main.
set -euo pipefail

types='feat|fix|docs|refactor|test|chore|perf|ci|build|style|revert|release'
fail=0

# Prints "ok" or the problems with one subject; sets fail=1 on a problem.
check() {
  local label="$1" subject="$2" bad=0

  if ! grep -qE "^($types)(\([a-z0-9._/-]+\))?!?: .+" <<<"$subject"; then
    echo "::error::$label  not a Conventional Commit: $subject" >&2
    echo "         expected <type>(<optional scope>): <imperative summary>, type one of: ${types//|/, }" >&2
    fail=1
    return
  fi

  # release marks a release commit or release pull request ("release: 0.6.0",
  # "release: v0.6.0"). It is never a breaking or scoped change: next.sh skips
  # it, so a scope or a `!` would only mislead.
  if grep -qE '^release(\(|!)' <<<"$subject"; then
    echo "::error::$label  release takes no scope and no !: $subject" >&2
    fail=1; bad=1
  fi

  # A squash merge appends " (#123)" to the title, which was held to 72
  # characters on its own; the suffix does not count against the limit.
  local measured="$subject"
  [[ "$measured" =~ ^(.*)\ \(#[0-9]+\)$ ]] && measured="${BASH_REMATCH[1]}"
  if [ "${#measured}" -gt 72 ]; then
    echo "::error::$label  subject is ${#measured} chars, limit is 72: $subject" >&2
    fail=1; bad=1
  fi

  if grep -qE '\.$' <<<"$subject"; then
    echo "::error::$label  subject ends with a period: $subject" >&2
    fail=1; bad=1
  fi

  # CONTRIBUTING.md: imperative mood ("add", not "added").
  if grep -qiE "^($types)(\([a-z0-9._/-]+\))?!?: (added|fixed|updated|removed|changed|created|bumped) " <<<"$subject"; then
    echo "::error::$label  use imperative mood (add, not added): $subject" >&2
    fail=1; bad=1
  fi

  if [ "$bad" -eq 0 ]; then
    echo "ok  $label  $subject"
  fi
}

if [ "${1:-}" = --subject ]; then
  [ $# -eq 2 ] || { echo "usage: $0 --subject <text>" >&2; exit 2; }
  check title "$2"
  if [ "$fail" -ne 0 ]; then
    echo "commits: FAILED" >&2
    exit 1
  fi
  echo "commits: OK"
  exit 0
fi

range="${1:-origin/dev..HEAD}"

# `mapfile < <(...)` cannot see the subshell's exit status, so an unfetched or
# malformed range would look like "no commits" and pass the gate silently.
if ! git rev-list --no-merges "$range" >/dev/null 2>&1; then
  echo "::error::cannot resolve commit range: $range" >&2
  exit 1
fi

mapfile -t shas < <(git rev-list --no-merges "$range")

if [ "${#shas[@]}" -eq 0 ]; then
  echo "commits: no non-merge commits in $range"
  exit 0
fi

for sha in "${shas[@]}"; do
  check "${sha:0:8}" "$(git log -1 --format=%s "$sha")"
done

if [ "$fail" -ne 0 ]; then
  echo "commits: FAILED" >&2
  exit 1
fi
echo "commits: OK"
