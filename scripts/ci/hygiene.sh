#!/usr/bin/env bash
# Repository hygiene checks. No dependencies beyond git, grep and coreutils.
# Run locally: ./scripts/ci/hygiene.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
note() { printf '::error file=%s::%s\n' "$1" "$2" >&2; fail=1; }

# Text files only: skip anything git considers binary.
mapfile -t files < <(git ls-files | while read -r f; do
  if [ -z "$(git diff --no-index --numstat /dev/null "$f" 2>/dev/null | cut -f1 | grep -x -- '-' || true)" ]; then
    printf '%s\n' "$f"
  fi
done)

echo "Checking ${#files[@]} text files"

for f in "${files[@]}"; do
  [ -s "$f" ] || continue

  if grep -qU $'\r' "$f"; then
    note "$f" "CRLF line endings; commit LF only"
  fi

  if grep -qnE '[[:blank:]]+$' "$f"; then
    note "$f" "trailing whitespace"
  fi

  if [ -n "$(tail -c1 "$f")" ]; then
    note "$f" "missing newline at end of file"
  fi
done

# The project ships no credentials and never should (CONTRIBUTING.md).
# No -q: grep -q exits at the first match, and git ls-files, still writing,
# dies of SIGPIPE; under pipefail that fails the pipeline and the guard passes.
if git ls-files | grep -E '(^|/)\.env($|\.)' >/dev/null; then
  note ".env" "environment files must not be committed"
fi

# CONTRIBUTING.md: TypeScript strict, no \`any\`.
# Matched with grep, not a pathspec: 'src/**/*.ts' needs an intermediate
# directory, so it silently skipped src/router.tsx.
# Generated output is excluded from the style bans: routeTree.gen.ts is
# written by TanStack Router and legitimately contains `as any`.
ts_files() { git ls-files -- src | grep -E '\.tsx?$' | grep -vE '\.gen\.tsx?$'; }

if ts_files | xargs -r grep -nE ':\s*any\b|<any>|as any' ; then
  echo "::error::explicit \`any\` found; CONTRIBUTING.md requires TypeScript strict with no \`any\`" >&2
  fail=1
fi

# CONTRIBUTING.md: tokens live in src/styles.css, do not sprinkle raw hex in JSX.
# `theme-color` is exempt: a meta tag cannot resolve a CSS custom property.
if ts_files | grep '\.tsx$' | xargs -r grep -nE '#[0-9a-fA-F]{3,8}\b' | grep -v 'theme-color' ; then
  echo "::error::raw hex color in JSX; use the tokens in src/styles.css" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "hygiene: FAILED" >&2
  exit 1
fi
echo "hygiene: OK"
