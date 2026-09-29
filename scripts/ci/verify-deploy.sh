#!/usr/bin/env bash
# Verifies what only a real deployment can get wrong: that production and the
# stage preview answer, run the expected Worker version, index (or refuse to
# index) as intended, and serve a certificate that covers their name and is not
# about to expire. It does not test the page, the JSON API or the feed: run
# scripts/ci/smoke.sh for those, and do not duplicate them here.
#
#   ./scripts/ci/verify-deploy.sh
#   ./scripts/ci/verify-deploy.sh --only prod --expect-version <id>
#   ./scripts/ci/verify-deploy.sh --only stage --stage-url https://stage.stage.status.szolotov.com
#   ./scripts/ci/verify-deploy.sh --only prod --prod-url http://127.0.0.1:4190 --skip-tls
#
# Options (defaults in brackets):
#   --prod-url URL        production [https://status.szolotov.com]
#   --stage-url URL       stage preview [https://stage.status.szolotov.com]
#   --only prod|stage     check one target instead of both
#   --expect-version ID   X-Worker-Version that production must answer with
#                         (production only; stage runs whatever dev last built)
#   --timeout SEC         per-request limit, also bounds the TLS check [15]
#   --skip-tls            skip the certificate check (plain-http local runs)
#
# Until the first deploy from main, the stage Preview answers on
# https://stage.stage.status.szolotov.com, so pass
# --stage-url https://stage.stage.status.szolotov.com until then. Production
# checks cannot pass before that first main deploy either: production is still
# a Hello-world stub.
#
# Checks per target, one output line each:
#   /                 answers 200
#   /healthz          carries a non-empty X-Worker-Version (and, on production,
#                     the --expect-version one)
#   /readyz           answers 200 (503 when the vendors are unreachable is a
#                     failure here: a deployment should be ready)
#   /robots.txt       production allows crawling, stage disallows it
#   X-Robots-Tag      on /: stage "noindex, nofollow", production none
#   tls               the certificate names the host (exactly, or by a wildcard
#                     one label above it) and is valid for at least 7 more days;
#                     connects to the URL's port (443 by default)
#
# Every check runs even after an earlier one fails. Output is
# "ok   <prod|stage> <check>" or "FAIL <prod|stage> <check>: <reason>", then
# "verify-deploy: N checks, M failed". Needs bash, curl and openssl. Exits 0
# when every check passes, 1 when any fails, 2 on bad usage.
set -euo pipefail

usage() {
  echo "usage: $0 [--prod-url URL] [--stage-url URL] [--only prod|stage] [--expect-version ID] [--timeout SEC] [--skip-tls]"
}

prod_url="https://status.szolotov.com"
stage_url="https://stage.status.szolotov.com"
only=""
expect_version=""
timeout=15
skip_tls=false
while [ $# -gt 0 ]; do
  case "$1" in
    --prod-url) [ $# -ge 2 ] || { usage >&2; exit 2; }; prod_url="$2"; shift 2 ;;
    --stage-url) [ $# -ge 2 ] || { usage >&2; exit 2; }; stage_url="$2"; shift 2 ;;
    --only) [ $# -ge 2 ] || { usage >&2; exit 2; }; only="$2"; shift 2 ;;
    --expect-version) [ $# -ge 2 ] || { usage >&2; exit 2; }; expect_version="$2"; shift 2 ;;
    --timeout) [ $# -ge 2 ] || { usage >&2; exit 2; }; timeout="$2"; shift 2 ;;
    --skip-tls) skip_tls=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$only" in
  "" | prod | stage) ;;
  *) echo "::error::--only takes prod or stage" >&2; usage >&2; exit 2 ;;
esac
for u in "$prod_url" "$stage_url"; do
  [[ "$u" =~ ^https?://[^[:space:]]+$ ]] || { echo "::error::not an http(s) URL: $u" >&2; exit 2; }
done
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] || { echo "::error::--timeout takes a positive number of seconds" >&2; exit 2; }
if [ -n "$expect_version" ] && ! [[ "$expect_version" =~ ^[A-Za-z0-9-]{1,64}$ ]]; then
  echo "::error::--expect-version takes a Worker version id such as 8842dd8a-be26-460d-a3ea-2890e9015024" >&2
  exit 2
fi

if [ -n "$expect_version" ] && [ "$only" = stage ]; then
  echo "::error::--expect-version applies to production only and cannot be combined with --only stage" >&2
  usage >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
hdr="$work/headers"
body="$work/body"

total=0
failed=0
target=""

pass() { total=$((total + 1)); printf 'ok   %s %s\n' "$target" "$1"; }
fail() { total=$((total + 1)); failed=$((failed + 1)); printf 'FAIL %s %s: %s\n' "$target" "$1" "$2"; }

# get <url>: fetches into $hdr and $body and sets $status to the HTTP code, or
# 000 (with the reason in $curl_error) when nothing answered.
status=000
curl_error=""
get() {
  local url="$1"
  : >"$hdr"
  : >"$body"
  status="$(curl --silent --show-error --max-time "$timeout" --dump-header "$hdr" --output "$body" --write-out '%{http_code}' "$url" 2>"$work/curl-error")" || status=000
  curl_error="$(tr -d '\r' <"$work/curl-error" | head -n 1)"
}

# header <name>: the value of the first such header of the last response,
# matched case-insensitively; empty when absent.
header() { grep -i "^$1:" "$hdr" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' || true; }

# expect_200 <check> <path>: the check passes when the path answers 200.
expect_200() {
  get "$base$2"
  if [ "$status" = 000 ]; then
    fail "$1" "no answer from $base$2: ${curl_error:-unknown error}"
  elif [ "$status" != 200 ]; then
    fail "$1" "$2 answered $status, expected 200"
  else
    pass "$1"
  fi
}

# tls_cert <connect-host> <port> <sni-name>: the certificate's text form (which
# lists the subjectAltName) and, through the exit status, whether it expires
# within 7 days. An empty <sni-name> sends no SNI. Exit 124 (timeout, gtimeout)
# or 142 (the perl fallback's SIGALRM) means the TLS handshake hung.
tls_cert() {
  # Constant script, host/port/name passed as positional arguments: nothing from
  # the URL is ever parsed as shell. -text rather than -ext, which LibreSSL (the
  # macOS /usr/bin/openssl) does not have.
  # shellcheck disable=SC2016 # $1..$3 are expanded by the inner bash, not here
  local run='openssl s_client -connect "$1:$2" ${3:+-servername "$3"} </dev/null 2>/dev/null | openssl x509 -noout -text -checkend 604800'
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout" bash -c "$run" _ "$1" "$2" "$3"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$timeout" bash -c "$run" _ "$1" "$2" "$3"
  elif command -v perl >/dev/null 2>&1; then
    # Runs the command in its own process group and, on SIGALRM, kills the whole
    # group so that a hung openssl does not outlive the check (or hold the pipe).
    perl -e '
      my $t = shift;
      my $pid = fork();
      if (!$pid) { setpgrp(0, 0); exec @ARGV; exit 127; }
      $SIG{ALRM} = sub { kill "TERM", -$pid; waitpid($pid, 0); exit 142; };
      alarm $t;
      waitpid($pid, 0);
      exit(($? & 127) ? 128 + ($? & 127) : $? >> 8);
    ' "$timeout" bash -c "$run" _ "$1" "$2" "$3"
  else
    bash -c "$run" _ "$1" "$2" "$3"
  fi
}

# check_tls <host> <port>: <host> is a bare name or address (no brackets).
check_tls() {
  local host="$1" port="$2" out rc=0 name san connect sni shown problems=() found=false
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  if [[ "$host" == *:* ]]; then
    # IPv6 literal: bracketed for connecting, no SNI (an address is not a name).
    connect="[$host]"
    sni=""
  else
    connect="$host"
    sni="$host"
  fi
  shown="$connect:$port"
  if ! [[ "$port" =~ ^[0-9]{1,5}$ ]]; then
    fail tls "invalid port \"$port\" in the URL"
    return
  fi
  out="$(tls_cert "$connect" "$port" "$sni" 2>/dev/null)" || rc=$?
  if [ "$rc" = 124 ] || [ "$rc" = 142 ]; then
    fail tls "timed out after ${timeout}s connecting to $shown"
    return
  fi
  if ! grep -Eq 'DNS:|Certificate will' <<<"$out"; then
    fail tls "could not read a certificate from $shown (openssl exit $rc)"
    return
  fi
  # The names are on the line after "X509v3 Subject Alternative Name", as
  # "DNS:a, DNS:b". A name covers the host when it is the host, or a wildcard
  # exactly one label above it: *.status.example.com covers
  # stage.status.example.com but not stage.stage.status.example.com.
  san="$(awk '/X509v3 Subject Alternative Name/ { getline; print; exit }' <<<"$out")"
  while IFS= read -r name; do
    name="$(printf '%s' "${name#DNS:}" | tr '[:upper:]' '[:lower:]')"
    if [ "$name" = "$host" ] || { [[ "$host" == *.* ]] && [ "$name" = "*.${host#*.}" ]; }; then
      found=true
    fi
  done < <(printf '%s\n' "$san" | tr ',' '\n' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | grep -E '^DNS:' || true)
  if [ "$found" != true ]; then
    if [[ "$host" == *.* ]]; then
      problems+=("no subjectAltName covers $host (looked for DNS:$host or DNS:*.${host#*.})")
    else
      problems+=("no subjectAltName covers $host (looked for DNS:$host)")
    fi
  fi
  [ "$rc" = 0 ] || problems+=("certificate expires within 7 days")
  if [ "${#problems[@]}" -eq 0 ]; then
    pass tls
  else
    local joined
    joined="$(printf '%s; ' "${problems[@]}")"
    fail tls "${joined%; }"
  fi
}

# robots_star_rules: the rule lines of the "User-agent: *" group of $body, one
# per line, CR and trailing blanks removed. A group is one or more User-agent
# lines followed by its rules; it ends at the next User-agent line after a rule.
robots_star_rules() {
  awk '
    { sub(/\r$/, ""); sub(/[ \t]+$/, "") }
    tolower($0) ~ /^user-agent:/ {
      agent = $0
      sub(/^[^:]*:[ \t]*/, "", agent)
      if (in_rules) { star = 0; in_rules = 0 }
      if (agent == "*") star = 1
      next
    }
    /^[ \t]*(#.*)?$/ { next }
    { in_rules = 1; if (star) print }
  ' "$body"
}

# verify <prod|stage> <url> [expected-version]
verify() {
  target="$1"
  base="${2%/}"
  local want_version="${3:-}" host authority rest port version robots home_status home_curl_error home_robots

  # 1. / answers 200, and its X-Robots-Tag is kept for check 5.
  get "$base/"
  home_status="$status"
  home_curl_error="$curl_error"
  home_robots="$(header X-Robots-Tag)"
  if [ "$status" = 000 ]; then
    fail / "no answer from $base/: ${curl_error:-unknown error}"
  elif [ "$status" != 200 ]; then
    fail / "/ answered $status, expected 200"
  else
    pass /
  fi

  # 2. /healthz names the Worker version that answered.
  get "$base/healthz"
  version="$(header X-Worker-Version)"
  if [ "$status" = 000 ]; then
    fail /healthz "no answer from $base/healthz: ${curl_error:-unknown error}"
  elif [ "$status" != 200 ]; then
    fail /healthz "/healthz answered $status, expected 200"
  elif [ -z "$version" ]; then
    fail /healthz "no X-Worker-Version header"
  elif [ -n "$want_version" ] && [ "$version" != "$want_version" ]; then
    fail /healthz "X-Worker-Version is \"$version\", expected \"$want_version\""
  else
    pass /healthz
  fi

  # 3. /readyz answers 200.
  expect_200 /readyz /readyz

  # 4. /robots.txt allows crawling on production and forbids it on stage.
  get "$base/robots.txt"
  if [ "$status" = 000 ]; then
    fail /robots.txt "no answer from $base/robots.txt: ${curl_error:-unknown error}"
  elif [ "$status" != 200 ]; then
    fail /robots.txt "/robots.txt answered $status, expected 200"
  else
    robots_star_rules >"$work/robots-rules"
    if [ "$target" = stage ]; then
      if grep -qx 'Disallow: /' "$work/robots-rules"; then pass /robots.txt; else fail /robots.txt "no \"Disallow: /\" line"; fi
    elif grep -qx 'Disallow: /' "$work/robots-rules"; then
      fail /robots.txt "contains \"Disallow: /\", production must be indexable"
    elif grep -qx 'Allow: /' "$work/robots-rules"; then
      pass /robots.txt
    else
      fail /robots.txt "no \"Allow: /\" line"
    fi
  fi

  # 5. X-Robots-Tag on /: stage refuses indexing, production says nothing.
  robots="$home_robots"
  if [ "$home_status" = 000 ]; then
    fail X-Robots-Tag "no answer from $base/: ${home_curl_error:-unknown error}"
  elif [ "$target" = stage ]; then
    if [ "$robots" = "noindex, nofollow" ]; then
      pass X-Robots-Tag
    else
      fail X-Robots-Tag "on /, got \"$robots\", expected \"noindex, nofollow\""
    fi
  elif [ -z "$robots" ]; then
    pass X-Robots-Tag
  else
    fail X-Robots-Tag "on /, got \"$robots\", production must send none"
  fi

  # 6. The certificate names the host and is not about to expire.
  if [ "$skip_tls" = false ]; then
    # authority = [userinfo@]host[:port], with the host possibly a [v6] literal.
    authority="${base#*://}"
    authority="${authority%%/*}"
    authority="${authority%%[?#]*}"
    authority="${authority##*@}"
    port=443
    case "$authority" in
      \[*)
        host="${authority#\[}"
        host="${host%%\]*}"
        rest="${authority#*\]}"
        [ -z "${rest#:}" ] || port="${rest#:}"
        ;;
      *)
        host="${authority%%:*}"
        if [[ "$authority" == *:* ]] && [ -n "${authority##*:}" ]; then port="${authority##*:}"; fi
        ;;
    esac
    check_tls "$host" "$port"
  fi
}

if [ "$only" != stage ]; then verify prod "$prod_url" "$expect_version"; fi
if [ "$only" != prod ]; then verify stage "$stage_url"; fi

echo "verify-deploy: $total checks, $failed failed"
[ "$failed" -eq 0 ]
