#!/usr/bin/env bash
# Checks that every package pnpm-lock.yaml locks is the one the npm registry
# signed, the way `npm audit signatures` did for package-lock.json. Two steps:
#
#   1. `pnpm audit signatures` verifies the registry's signature over every
#      package version pnpm-lock.yaml lists, using npm's
#      published keys. It fails on an invalid or a missing signature.
#   2. scripts/ci/lockfile-integrity.ts checks that the integrity the lockfile
#      records for each package is the one the registry signs. pnpm does not
#      compare the two, so without this step an edited lockfile line would
#      still audit clean; `pnpm install` has already checked every tarball
#      against that line, so together the installed bytes are the signed ones.
#
# What pnpm 12 does not do, and npm did: verify the Sigstore provenance
# attestation that about two thirds of these packages publish. The
# trustPolicy in pnpm-workspace.yaml is the nearest control (see
# CONTRIBUTING.md#dependencies).
#
# A failure to reach the registry (or a 5xx from it) is retried, three
# attempts. A signature that does not verify is not: it fails at once.
#
# Run locally: ./scripts/ci/audit-signatures.sh [pnpm-lock.yaml] (after `pnpm install`)
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

lockfile="${1:-pnpm-lock.yaml}"
attempts=3
backoff="${AUDIT_SIGNATURES_BACKOFF:-15}"

audit_signatures() {
  local attempt output
  for attempt in $(seq 1 "$attempts"); do
    if output="$(pnpm audit signatures 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi
    printf '%s\n' "$output" >&2
    # A package that fails verification is reported with the key id it was
    # signed with, or as missing its signature; that is never retried. Only a
    # registry that could not answer is (pnpm lists a package whose manifest
    # came back as a 5xx under "invalid registry signature" too, but with the
    # status instead of a key id).
    if grep -qE 'has an invalid registry signature with keyid|missing registry signature' <<<"$output" ||
      ! grep -qiE 'ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL|error sending request|responded with (429|5[0-9][0-9])|timed out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|connection (reset|closed|refused)' <<<"$output"; then
      echo "::error::pnpm audit signatures failed on a package, not on reaching the registry" >&2
      return 1
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      echo "::warning::pnpm audit signatures could not reach the registry (attempt $attempt of $attempts); retrying"
      sleep $((attempt * backoff))
    fi
  done
  echo "::error::pnpm audit signatures could not reach the registry in $attempts attempts" >&2
  return 1
}

audit_signatures || exit 1
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/ci/lockfile-integrity.ts "$lockfile"
