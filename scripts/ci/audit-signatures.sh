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
# npm keeps the trust root it fetched under its cache (`<cache>/_tuf`), so a
# retry would read back the same broken copy. Each retry deletes it first,
# which makes npm fetch it again from its built-in root, and asks the
# registry for its keys again (--prefer-online) instead of reusing a cached
# answer. Sigstore outages have lasted over a minute, so the four attempts
# span 90 seconds (AUDIT_SIGNATURES_BACKOFF=0 makes the waits zero, for tests).
#
# Run locally: ./scripts/ci/audit-signatures.sh (after `npm ci`)
set -uo pipefail

attempts=4
backoff="${AUDIT_SIGNATURES_BACKOFF:-15}"
tuf_cache="$(npm config get cache)/_tuf"

for attempt in $(seq 1 "$attempts"); do
  extra=""
  [ "$attempt" -gt 1 ] && extra="--prefer-online"
  # $extra unquoted on purpose: empty on the first attempt, one flag after.
  # shellcheck disable=SC2086
  if output="$(npm audit signatures $extra 2>&1)"; then
    printf '%s\n' "$output"
    exit 0
  fi
  printf '%s\n' "$output" >&2
  if ! grep -qE 'EMISSINGSIGNATUREKEY|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up' <<<"$output"; then
    echo "::error::npm audit signatures failed on a package, not on fetching keys" >&2
    exit 1
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    echo "::warning::npm audit signatures could not load a verification key (attempt $attempt of $attempts); retrying with a fresh trust root"
    rm -rf "$tuf_cache"
    sleep $((attempt * backoff))
  fi
done
echo "::error::npm audit signatures could not load a verification key in $attempts attempts" >&2
exit 1
