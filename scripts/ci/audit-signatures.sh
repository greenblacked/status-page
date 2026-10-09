#!/usr/bin/env bash
# Checks that every package pnpm-lock.yaml locks is the one the npm registry
# signed, the way `npm audit signatures` did for package-lock.json. Two steps:
#
#   1. `pnpm audit signatures` verifies the registry's signature over every
#      package version pnpm-lock.yaml lists, using npm's
#      published keys. It fails on an invalid or a missing signature.
#   2. scripts/ci/lockfile-integrity.ts verifies, with npm's signing keys
#      (pinned in the script, expiry applied as the npm CLI does), a registry
#      signature over `name@version:integrity` for the integrity the
#      lockfile records for each package. It fails on any entry it cannot
#      read, so none is dropped silently. pnpm does not compare the two,
#      so without this step an edited lockfile line would still audit clean;
#      `pnpm install` checks every tarball it downloads against that line, so
#      together the downloaded bytes are the signed ones. A pnpm store
#      restored from a cache is not checked against the lockfile on install,
#      so the deploy workflow restores none.
#
# What pnpm 12 does not do, and npm did: verify the Sigstore provenance
# attestation that about two thirds of these packages publish. The
# trustPolicy in pnpm-workspace.yaml is the nearest control (see
# CONTRIBUTING.md#dependencies).
#
# A failure to reach the registry (the signing keys cannot be fetched, a
# connection error, a manifest response whose body cannot be read, or a 429 or
# 5xx from the manifest endpoint) is retried, three attempts. Nothing else is:
# the retry is an allowlist, so any output that is not wholly made of
# registry-reach failures fails at once, and a retry that still fails fails the
# job. See reach_failures_only below.
#
# Run locally: ./scripts/ci/audit-signatures.sh [pnpm-lock.yaml] (after `pnpm install`)
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

lockfile="${1:-pnpm-lock.yaml}"
attempts=3
backoff="${AUDIT_SIGNATURES_BACKOFF:-15}"

# Succeeds only when `pnpm audit signatures` (its output on stdin) failed on
# nothing but reaching the registry, so a retry can help. An allowlist: every
# line must be one of
#   - a count or heading pnpm prints around its report ("audited N packages",
#     "N packages have verified registry signatures", "N packages have an
#     invalid registry signature:", the "Someone might have tampered" line),
#   - a row of the "invalid registry signature" table (box-drawing or ASCII
#     bars; package, registry, cause) whose cause is a failed request to the
#     packument endpoint ("Failed to request the packument endpoint ...", which
#     covers "error decoding response body" and connection errors) or a 429 or
#     5xx answer from it ("The packument endpoint (at ...) responded with
#     503"), or the same text unboxed,
#   - the failure to fetch the registry's signing keys: the
#     ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL line and the message block under
#     it (a "×" line, then the "│" lines it wraps onto, up to the blank line).
#     pnpm fetches the keys before it audits any package, so that error never
#     comes with a package, a heading or a table; if one does, the output is
#     not trusted and fails at once,
#   - when the output lists no package at all, a connection error (timeout,
#     reset, DNS).
# Any other line fails at once: an invalid signature, a signature with a key
# pnpm cannot find or whose key has expired, a missing signature (that table
# has no cause column), "Malformed registry signatures metadata", "Missing
# registry metadata", a row with a cause not listed here, a row that does not
# parse, or any text this list has not seen. The number of rows must also equal
# the count in the heading, so a row that was not read cannot hide. At least
# one reach failure must be present, or there is nothing to retry.
reach_failures_only() {
  awk '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    function bad() { unknown = 1 }
    BEGIN { reach = 0; rows = 0; expected = 0; headings = 0; unknown = 0; packages = 0; transport = 0; keys = 0; keysfail = 0 }
    {
      line = $0
      gsub(/\033\[[0-9;]*[A-Za-z]/, "", line)
      gsub(/\r/, "", line)
      line = trim(line)
      # The message block under ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL. pnpm
      # prints it with miette: a blank line, a "×" line (or "x" on a terminal
      # without Unicode), then the text wrapped at 80 columns onto "│" lines,
      # then a blank line. keys is 1 after the error line, 2 inside the block.
      if (keys == 1 && line == "") next
      if (keys == 1 && line ~ /^(×|x) /) { keys = 2; next }
      if (keys == 2 && line ~ /^(│|\|)/) {
        # A line with a second bar is a table row, not wrapped text.
        rest = line
        sub(/^(│|\|)/, "", rest)
        if (rest !~ /(│|\|)/) next
      }
      if (keys != 0) keys = 0
      if (line == "" || line ~ /^[-+=─│┌┐└┘├┤┬┴┼ \t]+$/) next
      if (line ~ /^(│|\|)/) {
        packages = 1
        rows++
        s = line
        sub(/^(│|\|)[ \t]*/, "", s)
        if (!match(s, /[ \t]*(│|\|)[ \t]*/)) { bad(); next }
        pkg = substr(s, 1, RSTART - 1)
        s = substr(s, RSTART + RLENGTH)
        if (!match(s, /[ \t]*(│|\|)[ \t]*/)) { bad(); next }
        s = substr(s, RSTART + RLENGTH)
        cause = s
        sub(/[ \t]*(│|\|)[ \t]*$/, "", cause)
        if (pkg == "" || cause == "") { bad(); next }
        if (is_reach_cause(cause)) reach++; else bad()
        next
      }
      if (line ~ /^audited [0-9]+ packages?$/) next
      if (line ~ /^[0-9]+ packages? (has|have) a? ?verified registry signatures?$/) next
      if (line ~ /^[0-9]+ packages? (has|have) (an )?invalid registry signatures?:$/) {
        packages = 1
        split(line, w, " ")
        expected += w[1]
        headings++
        next
      }
      if (line ~ /^Someone might have tampered with (this package|these packages) since (it was|they were) published on the registry!$/) next
      if (is_reach_cause(line)) { packages = 1; rows++; reach++; next }
      if (line ~ /^(Error: )?ERR_PNPM_AUDIT_SIGNATURE_KEYS_FETCH_FAIL$/) { keys = 1; keysfail = 1; reach++; next }
      if (line !~ /registry signature|keyid|public key|signatures? metadata|registry metadata|@[0-9]/ &&
          line ~ /error sending request|timed out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|connection (reset|closed|refused)/) { transport = 1; reach++; next }
      bad()
    }
    function is_reach_cause(c) {
      return c ~ /^Failed to request the packument endpoint( |$)/ ||
        c ~ /^The packument endpoint \(at [^)]*\) responded with (429|5[0-9][0-9])([^0-9]|$)/
    }
    END {
      if (unknown || reach == 0) exit 1
      if (headings > 0 && rows != expected) exit 1
      if (headings == 0 && rows > 0) exit 1
      if (keysfail && packages) exit 1
      if (packages && transport) exit 1
      exit 0
    }'
}

audit_signatures() {
  local attempt output
  for attempt in $(seq 1 "$attempts"); do
    if output="$(pnpm audit signatures 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi
    printf '%s\n' "$output" >&2
    if ! reach_failures_only <<<"$output"; then
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
