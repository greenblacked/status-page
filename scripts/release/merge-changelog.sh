#!/usr/bin/env bash
# Resolves the one CHANGELOG.md conflict that merging main into dev hits on
# its own: a release on main (usually a hotfix) turns `## [Unreleased]` into
# a dated section while dev has added lines under the same heading.
#
# Usage: merge-changelog.sh <base> <dev> <main>
#   The merge base's, dev's and main's CHANGELOG.md. Prints main's file with
#   dev's Unreleased lines under its Unreleased heading.
#
# Resolves only when that is all that happened: the base and main have
# nothing under Unreleased, and dev changed nothing outside it. Anything else
# exits 1 so a person resolves it.
set -euo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <base> <dev> <main>" >&2; exit 2; }

# Copied first: the arguments may be pipes such as <(git show :1:CHANGELOG.md),
# which can be read only once, and each file is read more than once below.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$1" "$work/base"; cp "$2" "$work/dev"; cp "$3" "$work/main"
base="$work/base" dev="$work/dev" main="$work/main"

# The lines between `## [Unreleased]` and the next `## [` heading.
unreleased() {
  awk '/^## \[/ { inside = ($0 ~ /^## \[Unreleased\]/); next } inside' "$1"
}

# The file without those lines.
outside() {
  awk '/^## \[/ { inside = ($0 ~ /^## \[Unreleased\]/); print; next } !inside' "$1"
}

# No -q: grep -q exits early and the writer dies of SIGPIPE under pipefail.
# Relies on grep reading its input to the end when not -q (GNU grep; covered
# by hygiene.test.ts).
blank() { ! grep '[^[:space:]]' >/dev/null; }

grep -q '^## \[Unreleased\]' "$main" || { echo "merge-changelog: main has no ## [Unreleased] heading" >&2; exit 1; }
unreleased "$base" | blank || { echo "merge-changelog: the merge base has Unreleased lines; resolve by hand" >&2; exit 1; }
unreleased "$main" | blank || { echo "merge-changelog: main has Unreleased lines; resolve by hand" >&2; exit 1; }
if ! diff -q <(outside "$base") <(outside "$dev") >/dev/null; then
  echo "merge-changelog: dev changed CHANGELOG.md outside Unreleased; resolve by hand" >&2
  exit 1
fi

body="$work/body"
unreleased "$dev" >"$body"

awk -v body="$body" '
  /^## \[/ { inside = 0 }
  /^## \[Unreleased\]/ {
    print
    while ((getline line < body) > 0) print line
    inside = 1
    next
  }
  !inside
' "$main"
