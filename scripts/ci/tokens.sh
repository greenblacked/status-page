#!/usr/bin/env bash
# Design-token guard. The theme clears Tailwind's default fonts and radii
# (`--font-*: initial`, `--radius-*: initial`), so a stale utility such as
# font-mono or rounded-xl silently does nothing. This fails on:
#
#   - the retired names: font-mono, font-serif, font-display, glass-inset,
#     glass-whisper, glass-chrome, .glass, and rounded-2xs / xs / xl / full
#   - an arbitrary type size, text-[11px] and the like (use a --text-* step)
#   - a raw colour, #hex or rgb(, in src/**/*.tsx (use a token)
#
# rounded-full is for dots and glyph rings only: a file that draws one says so
# in its first lines with a comment containing "tokens-allow: rounded-full". A
# file with a colour that is not a design colour (a filter's neutral grey) says
# "tokens-allow: raw-color" the same way. The theme-color meta tags, which must
# be literal, are skipped by name.
#
# Run locally: ./scripts/ci/tokens.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
report() { # pattern, message, files...
  local pattern="$1" message="$2"
  shift 2
  local hits
  hits=$(grep -nE -- "$pattern" "$@" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    printf '::error::%s\n%s\n' "$message" "$hits" >&2
    fail=1
  fi
}

mapfile -t sources < <(git ls-files -- 'src/*.tsx')

# Split off the files that are allowed a rounded-full dot or a raw colour.
allowed=()
checked=()
colours=()
for f in "${sources[@]}"; do
  head=$(head -n 5 "$f")
  if grep -q 'tokens-allow: rounded-full' <<<"$head"; then allowed+=("$f"); else checked+=("$f"); fi
  if ! grep -q 'tokens-allow: raw-color' <<<"$head"; then colours+=("$f"); fi
done

report 'font-(mono|serif|display)\b' 'retired font utility (the theme has font-sans and font-hand)' "${sources[@]}"
report 'text-\[[0-9.]+(px|rem)\]' 'arbitrary type size: use a --text-* step (text-caption, text-footnote, ...)' "${sources[@]}"
report 'glass-(inset|whisper|chrome)\b' 'retired material: glass-inset -> inset, glass-whisper -> control, glass-chrome -> float or sheet' "${sources[@]}"
report 'rounded-(2xs|xs|xl)\b' 'retired radius: 2xs -> sm, xs -> md, xl -> lg' "${sources[@]}"
if [ "${#checked[@]}" -gt 0 ]; then
  report 'rounded-full\b' 'rounded-full is for dots and glyph rings only (add "tokens-allow: rounded-full" to the file if it draws one)' "${checked[@]}"
fi

# A bare `glass` is only the retired material where it is used as a class: on a line that names classes.
glass_hits=$(grep -nE 'className|cn\(|rounded-|flex |grid |px-|p-[0-9]' "${sources[@]}" | grep -E "[\"' \`]glass[\"' \`]" || true)
if [ -n "$glass_hits" ]; then
  printf '::error::%s\n%s\n' 'retired material: glass -> surface' "$glass_hits" >&2
  fail=1
fi

if [ "${#colours[@]}" -gt 0 ]; then
  hex_hits=$(grep -nE '#[0-9a-fA-F]{3,8}\b' "${colours[@]}" | grep -v 'theme-color' || true)
  if [ -n "$hex_hits" ]; then
    printf '::error::%s\n%s\n' 'raw hex colour: use a token' "$hex_hits" >&2
    fail=1
  fi
  report 'rgba?\(' 'raw rgb() colour: use a token' "${colours[@]}"
fi

if [ "$fail" -ne 0 ]; then
  echo "Design-token guard failed." >&2
  exit 1
fi
echo "Design tokens ok (${#sources[@]} files, ${#allowed[@]} allowed rounded-full)"
