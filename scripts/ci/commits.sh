#!/usr/bin/env bash
# Enforce the Conventional Commits rules from CONTRIBUTING.md on a commit range.
# Run locally: ./scripts/ci/commits.sh origin/dev..HEAD
#   ./scripts/ci/commits.sh --subject "feat: add a feed" [--base main --head release/v0.6.0]
#     Checks one subject, such as a pull request title: a squash merge makes
#     it the commit on dev, and release.yml reads its type once it reaches main.
#     With --base or --head (pr-title.yml always passes both) a release title
#     is accepted only for a release/vX.Y.Z pull request into main, with the
#     same version in the title. Without them (a local check) it is not tied
#     to a pull request, so the release form is accepted.
set -euo pipefail

types='feat|fix|docs|refactor|test|chore|perf|ci|build|style|revert|release'
fail=0
# Set by --subject when --base or --head is given: the pull request's branches.
pr_context=0 base="" head=""

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
  # "release: v0.6.0"). It is never a breaking or scoped change, and its summary
  # is only a version: next.sh skips every release commit, so a real change
  # titled "release: ..." would release nothing.
  if grep -qE '^release(\(|!)' <<<"$subject"; then
    echo "::error::$label  release takes no scope and no !: $subject" >&2
    fail=1; bad=1
  elif grep -qE '^release: ' <<<"$subject" &&
    ! grep -qE '^release: v?[0-9]+\.[0-9]+\.[0-9]+( \(#[0-9]+\))?$' <<<"$subject"; then
    echo "::error::$label  release takes only a version: release: X.Y.Z or release: vX.Y.Z: $subject" >&2
    fail=1; bad=1
  elif [ "$pr_context" -eq 1 ] && grep -qE '^release: ' <<<"$subject"; then
    # next.sh skips every release commit, so a feature or fix pull request
    # titled "release: ..." would be squash-merged as a commit that releases
    # nothing. Only bump.sh's release/vX.Y.Z branch into main may use it, and
    # the title must name that branch's version.
    local title_version="${subject#release: }"
    title_version="${title_version#v}"
    title_version="${title_version%% *}"
    if [ "$base" != main ] || [[ ! "$head" =~ ^release/v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
      echo "::error::$label  release: titles are only for a release/vX.Y.Z pull request into main: $subject" >&2
      fail=1; bad=1
    elif [ "${BASH_REMATCH[1]}" != "$title_version" ]; then
      echo "::error::$label  the release title's version is not the release branch's version: $subject" >&2
      fail=1; bad=1
    fi
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
  usage="usage: $0 --subject <text> [--base <branch>] [--head <branch>]"
  [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }
  subject="$2"
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }; base="$2"; pr_context=1; shift 2 ;;
      --head) [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }; head="$2"; pr_context=1; shift 2 ;;
      *) echo "$usage" >&2; exit 2 ;;
    esac
  done
  check title "$subject"
  if [ "$fail" -ne 0 ]; then
    echo "commits: FAILED" >&2
    exit 1
  fi
  echo "commits: OK"
  exit 0
fi

# A range reads commits, not a pull request title: it still accepts the
# "release: X.Y.Z" commit bump.sh makes, because a chore/sync-main pull request
# carries main's release commits into stage, and a squash merge uses the title,
# which --subject guards.
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
