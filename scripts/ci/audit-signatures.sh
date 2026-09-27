#!/usr/bin/env bash
# `npm audit signatures`, retried when it cannot load a verification key.
#
# Provenance attestations are checked against Sigstore's trust root, which
# npm fetches at run time. When that fetch fails, npm reports
# EMISSINGSIGNATUREKEY for whichever attested package it reaches first,
# although the package is fine: the same lockfile verifies on the next
# runner. A tampered package fails differently (an invalid signature or an
# integrity mismatch), and that fails here at once, without a retry.
#
# Run locally: ./scripts/ci/audit-signatures.sh (after `npm ci`)
set -uo pipefail

attempts=3
for attempt in $(seq 1 "$attempts"); do
  if output="$(npm audit signatures 2>&1)"; then
    printf '%s\n' "$output"
    exit 0
  fi
  printf '%s\n' "$output" >&2
  if ! grep -qE 'EMISSINGSIGNATUREKEY|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up' <<<"$output"; then
    echo "::error::npm audit signatures failed on a package, not on fetching keys" >&2
    exit 1
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    echo "::warning::npm audit signatures could not load a verification key (attempt $attempt of $attempts); retrying"
    sleep $((attempt * 10))
  fi
done
echo "::error::npm audit signatures could not load a verification key in $attempts attempts" >&2
exit 1
