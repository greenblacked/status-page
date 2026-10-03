#!/usr/bin/env bash
# Print true while the dev branch is paused (CONTRIBUTING.md#branches), false
# once it is back. The one source of truth: scripts/ci/branch.sh (which branch
# takes feature pull requests) and release.yml (whether main is merged into
# dev) both ask here, and the switch itself is the dev-paused file next to
# this script. DEV_PAUSED in the environment overrides the file, which the
# tests use to check both modes. A missing file means paused, the state the
# repository is in; anything but true or false fails rather than guess.
set -euo pipefail

file="$(dirname "${BASH_SOURCE[0]}")/dev-paused"
value="${DEV_PAUSED:-}"
if [[ -z "$value" && -f "$file" ]]; then
  value="$(grep -v '^[[:space:]]*#' "$file" | tr -d '[:space:]' || true)"
fi
value="${value:-true}"
if [[ "$value" != true && "$value" != false ]]; then
  echo "::error::dev paused: expected true or false, got '$value' (scripts/ci/dev-paused, CONTRIBUTING.md#branches)" >&2
  exit 1
fi
echo "$value"
