#!/usr/bin/env bash
# Read the Conventional Commits in a range to decide the next release.
#
#   ./scripts/release/next.sh level v0.3.0..HEAD
#     Prints the bump the commits call for: major, minor, patch or none.
#       major  a `!` after the type, or a BREAKING CHANGE footer
#       minor  feat
#       patch  fix, perf, revert
#       none   anything else (docs, ci, build, chore, refactor, test, style)
#   ./scripts/release/next.sh notes v0.3.0..HEAD
#     Prints changelog lines built from those commits' subjects, for a
#     release whose pull requests added nothing under ## [Unreleased].
#
# release.yml runs `level` on every push to main, so merging stage into main
# (in a merge commit) releases every feat, fix or breaking change that came
# through dev and stage since the last tag, as one version. Merge commits never count.
# chore(release) commits are the bumps themselves and never count.
set -euo pipefail

die() { echo "next: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: $0 level|notes <range>"
mode="$1"
range="$2"

# An unresolvable range must fail loudly: silently reading it as "no
# commits" would skip a release.
git rev-list "$range" >/dev/null 2>&1 || die "cannot resolve commit range: $range"

type_re='^([a-z]+)(\([a-z0-9._/-]+\))?(!?): (.+)$'

# One NUL-terminated record per commit: subject, a unit separator, then body.
# -z keeps git from also putting a newline between records.
commits() { git log -z --no-merges --format='%s%x1f%b' "$range"; }

case "$mode" in
  level)
    level=none
    rank() { case "$1" in major) echo 3 ;; minor) echo 2 ;; patch) echo 1 ;; *) echo 0 ;; esac; }
    while IFS=$'\x1f' read -r -d '' subject body; do
      [[ "$subject" =~ $type_re ]] || continue
      type="${BASH_REMATCH[1]}"
      bang="${BASH_REMATCH[3]}"
      [ "$type" = chore ] && [ "${BASH_REMATCH[2]}" = "(release)" ] && continue
      this=none
      case "$type" in
        feat) this="minor" ;;
        fix | perf | revert) this="patch" ;;
      esac
      if [ -n "$bang" ] || grep -qE '^BREAKING[ -]CHANGE: ' <<<"$body"; then
        this="major"
      fi
      if [ "$(rank "$this")" -gt "$(rank "$level")" ]; then
        level="$this"
      fi
    done < <(commits)
    echo "$level"
    ;;

  notes)
    added=()
    changed=()
    fixed=()
    while IFS=$'\x1f' read -r -d '' subject _body; do
      [[ "$subject" =~ $type_re ]] || continue
      type="${BASH_REMATCH[1]}"
      [ "$type" = chore ] && [ "${BASH_REMATCH[2]}" = "(release)" ] && continue
      text="${BASH_REMATCH[4]}"
      text="$(printf '%s' "${text:0:1}" | tr '[:lower:]' '[:upper:]')${text:1}"
      case "$type" in
        feat) added+=("- $text") ;;
        fix | perf | revert) fixed+=("- $text") ;;
        *)
          # Other types only reach the notes when they break something.
          if [ -n "${BASH_REMATCH[3]}" ]; then
            changed+=("- $text")
          fi
          ;;
      esac
    done < <(commits)

    out=""
    section() {
      local heading="$1"
      shift
      [ $# -gt 0 ] || return 0
      [ -z "$out" ] || out+=$'\n'
      out+="### $heading"$'\n\n'
      out+="$(printf '%s\n' "$@")"$'\n'
    }
    section Added "${added[@]+"${added[@]}"}"
    section Changed "${changed[@]+"${changed[@]}"}"
    section Fixed "${fixed[@]+"${fixed[@]}"}"
    printf '%s' "$out"
    ;;

  *) die "unknown mode '$mode': use level or notes" ;;
esac
