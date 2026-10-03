#!/usr/bin/env bash
# Prepare a release: bump the version, date the changelog and commit.
#
#   ./scripts/release/bump.sh patch|minor|major|X.Y.Z
#     Locally: commits on a new release/vX.Y.Z branch (this script creates
#     it), from an up-to-date main or from the tip of origin/stage once that
#     contains main (git switch --detach origin/stage). Merging its pull
#     request into main makes release.yml tag the merge commit and publish.
#   ./scripts/release/bump.sh --ci patch|minor|major|X.Y.Z
#     In release.yml (Run workflow, or a merge to main): commits on the
#     checked-out main, which the workflow then pushes, tags and publishes.
#   --fallback-notes FILE
#     Changelog lines to release when ## [Unreleased] is empty, instead of
#     refusing. release.yml builds them from the merged commits' subjects
#     (scripts/release/next.sh notes).
#
# The commit is authored by whoever runs it, locally or by clicking Run
# workflow, never by a bot identity (CONTRIBUTING.md#authorship).
set -euo pipefail

die() { echo "bump: $*" >&2; exit 1; }

ci=false
fallback_notes=""
while [ $# -gt 1 ]; do
  case "$1" in
    --ci) ci=true; shift ;;
    --fallback-notes)
      [ $# -gt 2 ] || die "--fallback-notes needs a file"
      fallback_notes="$(realpath "$2")"
      shift 2
      ;;
    *) break ;;
  esac
done
[ $# -eq 1 ] || die "usage: $0 [--ci] [--fallback-notes FILE] patch|minor|major|X.Y.Z"
cd "$(git rev-parse --show-toplevel)"

[ -z "$(git status --porcelain)" ] || die "working tree is not clean"
if [ "$ci" = true ]; then
  # actions/checkout already fetched main; a mismatch means main moved
  # after the run started.
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
    die "main moved after this run started; run it again"
else
  # Release from an up-to-date main, or from the tip of stage once main is
  # part of it (stage is promoted into main by the pull request this opens).
  git fetch --quiet origin main
  head="$(git rev-parse HEAD)"
  if [ "$head" != "$(git rev-parse origin/main)" ]; then
    stage_tip=""
    if git fetch --quiet origin stage 2>/dev/null; then
      stage_tip="$(git rev-parse -q --verify refs/remotes/origin/stage || true)"
    fi
    if [ -z "$stage_tip" ] || [ "$head" != "$stage_tip" ] || ! git merge-base --is-ancestor origin/main HEAD; then
      die "release from an up-to-date main (git switch main && git pull --ff-only) or from origin/stage once it contains main (git switch --detach origin/stage)"
    fi
  fi
fi

current="$(node -p "require('./package.json').version")"
IFS=. read -r major minor patch <<<"$current"
case "$1" in
  patch) next="$major.$minor.$((patch + 1))" ;;
  minor) next="$major.$((minor + 1)).0" ;;
  major) next="$((major + 1)).0.0" ;;
  *)
    [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$1' is not patch, minor, major or X.Y.Z"
    next="$1"
    ;;
esac
if [ "$next" = "$current" ] || [ "$(printf '%s\n%s\n' "$current" "$next" | sort -V | tail -n1)" != "$next" ]; then
  die "$next is not newer than $current"
fi

tag="v$next"
branch="release/$tag"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null || [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  die "$tag already exists"
fi
if [ "$ci" = false ] && git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
  die "branch $branch already exists"
fi

# Something has to be released: Unreleased needs at least one line of content.
unreleased="$(awk '
  /^## \[Unreleased\]/ { found = 1; next }
  found && /^## \[/ { exit }
  found && NF { print }
' CHANGELOG.md)"
if [ -z "$unreleased" ] && [ -n "$fallback_notes" ] && [ -s "$fallback_notes" ]; then
  # Put the fallback lines under the empty Unreleased heading, so the rest
  # of the release reads them exactly like lines a pull request added.
  with_notes="$(mktemp)"
  awk -v notes="$fallback_notes" '
    { print }
    /^## \[Unreleased\]/ {
      print ""
      while ((getline line < notes) > 0) print line
    }
  ' CHANGELOG.md >"$with_notes"
  cat "$with_notes" >CHANGELOG.md
  rm -f "$with_notes"
  unreleased="$(cat "$fallback_notes")"
fi
[ -n "$unreleased" ] || die "CHANGELOG.md has nothing under ## [Unreleased]"

# The repository URL comes from the existing Unreleased compare link.
repo_url="$(sed -nE 's#^\[Unreleased\]: (.*)/compare/.*$#\1#p' CHANGELOG.md)"
[ -n "$repo_url" ] || die "CHANGELOG.md has no [Unreleased] compare link"

today="$(date -u +%F)"
changelog="$(mktemp)"
trap 'rm -f "$changelog"' EXIT
awk -v next_version="$next" -v current="$current" -v today="$today" -v url="$repo_url" '
  /^## \[Unreleased\]/ {
    print
    print ""
    print "## [" next_version "] - " today
    next
  }
  /^\[Unreleased\]: / {
    print "[Unreleased]: " url "/compare/v" next_version "...HEAD"
    print "[" next_version "]: " url "/compare/v" current "...v" next_version
    next
  }
  { print }
' CHANGELOG.md >"$changelog"
cat "$changelog" >CHANGELOG.md

npm version "$next" --no-git-tag-version --ignore-scripts >/dev/null
./scripts/ci/release-notes.sh "$next" >/dev/null

if [ "$ci" = true ]; then
  git commit --quiet -m "release: $next" -- package.json package-lock.json CHANGELOG.md
  echo "Prepared $tag ($current -> $next) on $(git rev-parse --short HEAD)."
  exit 0
fi

git switch --quiet -c "$branch"
git commit --quiet -m "release: $next" -- package.json package-lock.json CHANGELOG.md

cat <<EOF
Prepared $tag on branch $branch ($current -> $next).

Next:
  git push -u origin $branch
  then open a pull request into main titled "release: v$next". When it merges, release.yml tags
  the merge commit $tag and publishes the GitHub Release.
EOF
