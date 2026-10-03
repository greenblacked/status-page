#!/usr/bin/env bash
# Push HEAD to a branch of origin without force, and say why if it fails.
# Usage: push.sh <branch> <expected-sha>
#   <expected-sha> is the tip of <branch> the work was planned from.
# Exit status:
#   0   pushed (including a push that reported an error but landed: the
#       remote tip is the commit that was pushed)
#   10  the push failed because the remote branch really moved: its tip is no
#       longer <expected-sha>. The caller decides whether that is benign.
#   1   the push failed and the branch did NOT move (a ruleset rejection such
#       as GH013, an expired token, a network error), or the branch could not
#       be looked up. An ::error:: names the cause and the fix. A rejected
#       push is never reported as "moved": nothing was released.
set -euo pipefail

branch="${1:?usage: push.sh <branch> <expected-sha>}"
expected="${2:?usage: push.sh <branch> <expected-sha>}"
here="$(dirname "${BASH_SOURCE[0]}")"

pushed=0
output="$(git push origin "HEAD:refs/heads/$branch" 2>&1)" || pushed=$?
printf '%s\n' "$output" >&2
[ "$pushed" = 0 ] && exit 0

# Look the branch up again instead of trusting the error text.
looked=0
tip="$(git ls-remote --heads origin "refs/heads/$branch")" || looked=$?
if [ "$looked" != 0 ]; then
  echo "::error::push to $branch failed, and its tip could not be looked up to tell why; re-run the job" >&2
  exit 1
fi
tip="${tip%%[[:space:]]*}"
# The server may have applied the push although the client saw an error (a
# dropped connection after the ref update): the branch is at what we sent.
if [ -n "$tip" ] && [ "$tip" = "$(git rev-parse HEAD)" ]; then
  echo "::notice::push to $branch reported an error but landed" >&2
  exit 0
fi
if [ -n "$tip" ] && [ "$tip" != "$expected" ]; then
  exit 10
fi
"$here/explain-failure.sh" "push to $branch" "$branch" <<<"$output" >&2
exit 1
