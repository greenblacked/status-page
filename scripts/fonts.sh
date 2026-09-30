#!/usr/bin/env bash
# Rebuilds public/fonts/*.woff2 from the two upstream font files. A one-off:
# the outputs are committed, so a normal build never runs this.
#
#   INTER_TTF=/path/to/InterVariable.ttf HAND_TTF=/path/to/NothingYouCouldDo-Regular.ttf scripts/fonts.sh
#
# Inputs (both SIL Open Font License 1.1, see public/fonts/OFL.txt):
#   InterVariable.ttf  from https://github.com/rsms/inter/releases/tag/v4.1 (Inter-4.1.zip)
#   NothingYouCouldDo-Regular.ttf  from Google Fonts (Kimberly Geswein)
# Needs fonttools and brotli: python3 -m pip install fonttools brotli
#
# Inter keeps its weight axis at 400 to 700 and its optical-size axis at
# 14 to 32, and only the Latin the board prints; the handwriting keeps
# lower-case letters and light punctuation (it only writes "all quiet"). Budgets: Inter 48 KB, hand 6 KB.
set -euo pipefail

: "${INTER_TTF:?set INTER_TTF to InterVariable.ttf}"
: "${HAND_TTF:?set HAND_TTF to NothingYouCouldDo-Regular.ttf}"

out="$(cd "$(dirname "$0")/.." && pwd)/public/fonts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

fonttools varLib.instancer "$INTER_TTF" wght=400:700 opsz=14:32 -o "$work/inter-r.ttf"
pyftsubset "$work/inter-r.ttf" \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2013,U+2014,U+2018-201D,U+2022,U+2026,U+202F,U+2190-2199,U+2212,U+00D7" \
  --layout-features='kern,liga,calt,ccmp,locl,tnum,case,zero' \
  --flavor=woff2 --output-file="$out/inter-var.woff2"

pyftsubset "$HAND_TTF" --unicodes="U+0020-0021,U+0027,U+002C-002E,U+0061-007A,U+2019" --layout-features="" --no-hinting --name-IDs=0,1,2,4,13 --notdef-outline --drop-tables+=DSIG,GPOS,GSUB,kern --flavor=woff2 --output-file="$out/hand.woff2"

check() { # file, budget in bytes
  local size
  size=$(wc -c <"$1")
  echo "$(basename "$1"): $size bytes (budget $2)"
  [ "$size" -le "$2" ] || { echo "over budget: $1" >&2; exit 1; }
}
check "$out/inter-var.woff2" 49152
check "$out/hand.woff2" 6144
