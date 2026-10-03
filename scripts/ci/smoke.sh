#!/usr/bin/env bash
# Smoke-tests a running board: the same checks for CI's Node preview,
# the Worker running locally in workerd, and a fresh Cloudflare deploy.
#
#   ./scripts/ci/smoke.sh http://127.0.0.1:4173
#   ./scripts/ci/smoke.sh https://status.example.com --require-ready --attempts 6
#   ./scripts/ci/smoke.sh https://status.example.com --expect-version <id> --wait 120
#   ./scripts/ci/smoke.sh https://status.example.com --require-ready --ready-wait 300
#   ./scripts/ci/smoke.sh http://127.0.0.1:4181 --require-asset-cache
#
# Checks /healthz, the page (title, footer, security headers), the JSON API
# (20 services), the Atom feed, /metrics and /readyz. /readyz may answer 503
# unless --require-ready: CI and sandboxes cannot always reach the vendors,
# and an all-Unknown board is a correct answer there, not a broken build.
#
# --attempts retries the whole set of checks, 10 s apart. With
# --require-ready, /readyz then has to answer 200, checked again every 10 s
# for up to --ready-wait seconds (default 0: once). The two are separate
# because they wait for different things: a broken page or API should fail
# within a minute, while a cold Worker collects vendors on its first request.
#
# --expect-version <id> first waits, within --wait, until /healthz carries
# X-Worker-Version: <id> (src/lib/worker-version.ts), then requires it on
# every dynamic response it checks (not a static asset: Cloudflare serves
# those without invoking the Worker, so they carry no version). After a
# Cloudflare deploy this is the version id wrangler reported, so the checks
# run against the new version rather than the old one it is still replacing
# somewhere, and a new version that never starts answering fails instead of
# passing on the old one.
#
# --require-asset-cache also fetches the page's stylesheet, takes the first
# /assets/*.woff2 it names and requires Cache-Control: max-age=31536000 and
# immutable on it (public/_headers). Only Cloudflare reads that file, so the
# deploy asks for this check on the Worker (in workerd and live) and CI's Node
# preview does not.
#
# Needs curl and jq. Exits 1 on any failed check, 2 on bad usage.
set -euo pipefail

SERVICES=20
TITLE='<title>Status</title>'
FOOTER='Not affiliated with any of these vendors. I only read their public status pages.'
usage() {
  echo "usage: $0 <base-url> [--require-ready] [--ready-wait <seconds>] [--attempts <n>] [--wait <seconds>] [--expect-version <id>] [--require-asset-cache]"
}

base=""
require_ready=false
ready_wait=0
attempts=1
wait_s=60
expect_version=""
require_asset_cache=false
while [ $# -gt 0 ]; do
  case "$1" in
    --require-ready) require_ready=true; shift ;;
    --ready-wait) [ $# -ge 2 ] || { usage >&2; exit 2; }; ready_wait="$2"; shift 2 ;;
    --attempts) [ $# -ge 2 ] || { usage >&2; exit 2; }; attempts="$2"; shift 2 ;;
    --wait) [ $# -ge 2 ] || { usage >&2; exit 2; }; wait_s="$2"; shift 2 ;;
    --require-asset-cache) require_asset_cache=true; shift ;;
    --expect-version) [ $# -ge 2 ] || { usage >&2; exit 2; }; expect_version="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
    *) [ -z "$base" ] || { usage >&2; exit 2; }; base="${1%/}"; shift ;;
  esac
done
[ -n "$base" ] || { usage >&2; exit 2; }
[[ "$base" =~ ^https?://[^[:space:]]+$ ]] || { echo "::error::not an http(s) URL: $base" >&2; exit 2; }
[[ "$attempts" =~ ^[1-9][0-9]*$ ]] || { echo "::error::--attempts takes a positive number" >&2; exit 2; }
[[ "$wait_s" =~ ^[0-9]+$ ]] || { echo "::error::--wait takes a number of seconds" >&2; exit 2; }
[[ "$ready_wait" =~ ^[0-9]+$ ]] || { echo "::error::--ready-wait takes a number of seconds" >&2; exit 2; }
# Worker version ids are UUIDs; this keeps anything else out of the messages.
if [ -n "$expect_version" ] && ! [[ "$expect_version" =~ ^[A-Za-z0-9-]{1,64}$ ]]; then
  echo "::error::--expect-version takes a Worker version id such as 8842dd8a-be26-460d-a3ea-2890e9015024" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failed=0
fail() { echo "::error::$1" >&2; failed=1; }

# get <path>: fetches base+path into $work/body and $work/headers and sets
# $status to the HTTP code, or 000 when nothing answered.
status=000
quiet=false
get() {
  status="$(curl --silent --show-error --max-time 30 --dump-header "$work/headers" \
    --output "$work/body" --write-out '%{http_code}' "$base$1" 2>"$work/curl-error")" || status=000
  [ "$status" != 000 ] || [ "$quiet" = true ] || sed 's/^/  /' "$work/curl-error" >&2
}

header() { grep -i "^$1:" "$work/headers" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# True when the last response came from the expected version, or when no
# version is expected.
from_expected_version() { [ -z "$expect_version" ] || [ "$(header X-Worker-Version)" = "$expect_version" ]; }

# check_version <path>: fails the check when the last response came from
# another version.
check_version() {
  from_expected_version || fail "$1: answered by version \"$(header X-Worker-Version)\", expected $expect_version"
}

wait_for_server() {
  local deadline=$((SECONDS + wait_s)) announced=""
  quiet=true
  while :; do
    get /healthz
    if [ "$status" = 200 ] && from_expected_version; then
      quiet=false
      [ -z "$expect_version" ] || echo "ok  version $expect_version is answering"
      return 0
    fi
    if [ "$status" = 200 ] && [ "$announced" != "$(header X-Worker-Version)" ]; then
      announced="$(header X-Worker-Version)"
      echo "waiting for version $expect_version; ${announced:-a version without X-Worker-Version} is answering"
    fi
    if ((SECONDS >= deadline)); then
      quiet=false
      if [ "$status" = 200 ]; then
        fail "$base/healthz was still answered by version \"$(header X-Worker-Version)\" after ${wait_s}s, not $expect_version"
      else
        fail "$base/healthz did not answer 200 within ${wait_s}s (last: $status)"
      fi
      return 1
    fi
    sleep 2
  done
}

# check_asset_cache: the hashed font under /assets/ has to be cacheable for a
# year, or font-display: optional never draws Inter on a return visit. It goes
# from the page to its stylesheet to the font, so the file is the one a browser
# would request, answered by the same asset server. The page that names the
# stylesheet is held to --expect-version, so the font checked belongs to the
# expected version. The font itself is not: on Cloudflare a matching static
# asset is served without invoking the Worker, so it carries no X-Worker-Version
# and --expect-version would fail every attempt.
check_asset_cache() {
  local sheets css font cache
  get /
  check_version /
  [ "$status" = 200 ] || { fail "/: $status, so no stylesheet to check the font cache with"; return; }
  sheets="$(grep -aoE '/assets/[^"'"'"' ]+\.css' "$work/body" | sort -u || true)"
  font=""
  for css in $sheets; do
    get "$css"
    [ "$status" = 200 ] || { fail "$css: $status, expected 200"; return; }
    font="$(grep -aoE '/assets/[^")'"'"' ]+\.woff2' "$work/body" | head -n 1 || true)"
    [ -z "$font" ] || break
  done
  [ -n "$font" ] || { fail "/: no stylesheet under /assets/ names a .woff2 font"; return; }
  get "$font"
  [ "$status" = 200 ] || { fail "$font: $status, expected 200"; return; }
  cache="$(header Cache-Control)"
  if [[ "$cache" != *max-age=31536000* || "$cache" != *immutable* ]]; then
    fail "$font: Cache-Control \"$cache\", expected max-age=31536000 and immutable (public/_headers)"
  fi
}

run_checks() {
  failed=0

  get /healthz
  if [ "$status" != 200 ] || ! grep -qx 'ok' "$work/body"; then fail "/healthz: $status, expected 200 ok"; fi
  check_version /healthz

  get /
  check_version /
  if [ "$status" != 200 ]; then
    fail "/: $status, expected 200"
  else
    grep -aqF "$TITLE" "$work/body" || fail "/: no $TITLE"
    # React's server renderer separates adjacent text nodes with <!-- -->; the
    # sentence is still one sentence to a reader, so match it without them.
    # No -q: grep -q exits at the footer and sed, still writing the rest of the
    # page, dies of SIGPIPE; under pipefail that fails the check on a good page.
    sed 's/<!-- -->//g' "$work/body" | grep -aF "$FOOTER" >/dev/null || fail "/: no footer line \"$FOOTER\""
    [ -n "$(header Content-Security-Policy)" ] || fail "/: no Content-Security-Policy header"
    [ -n "$(header X-Frame-Options)" ] || fail "/: no X-Frame-Options header"
  fi

  get /api/status.json
  check_version /api/status.json
  if [ "$status" != 200 ]; then
    fail "/api/status.json: $status, expected 200"
  elif ! jq -e --argjson n "$SERVICES" '(.services | length) == $n and (.generatedAt | type) == "string"' "$work/body" >/dev/null 2>&1; then
    fail "/api/status.json: not JSON with $SERVICES services and a generatedAt"
  fi

  get /api/history.json
  check_version /api/history.json
  if [ "$status" != 200 ]; then
    fail "/api/history.json: $status, expected 200"
  elif ! jq -e '.schema == 1 and .timezone == "UTC" and .retentionDays == 30 and (.services | type) == "object" and (.services | length) == 0' "$work/body" >/dev/null 2>&1; then
    fail "/api/history.json: not JSON with schema 1, UTC, retentionDays 30 and services"
  fi

  get /feed.xml
  check_version /feed.xml
  if [ "$status" != 200 ]; then
    fail "/feed.xml: $status, expected 200"
  elif [[ "$(header Content-Type)" != *xml* ]]; then
    fail "/feed.xml: Content-Type \"$(header Content-Type)\" is not XML"
  fi

  get /metrics
  check_version /metrics
  [ "$status" = 200 ] || fail "/metrics: $status, expected 200"

  if [ "$require_asset_cache" = true ]; then check_asset_cache; fi

  get /readyz
  check_version /readyz
  case "$status" in
    200) ;;
    # --require-ready holds /readyz to 200 in wait_for_ready, after these.
    503) [ "$require_ready" = true ] || echo "note: /readyz is 503 (allowed without --require-ready): $(head -c 300 "$work/body")" ;;
    *) fail "/readyz: $status, expected 200 or 503" ;;
  esac

  return "$failed"
}

wait_for_ready() {
  local deadline=$((SECONDS + ready_wait))
  while :; do
    get /readyz
    if [ "$status" = 200 ] && from_expected_version; then
      echo "ok  /readyz is 200"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      check_version /readyz
      [ "$status" = 200 ] || fail "/readyz: $status after ${ready_wait}s, expected 200 (--require-ready): $(head -c 300 "$work/body")"
      return 1
    fi
    echo "/readyz is $status: $(head -c 200 "$work/body"); checking again in 10s"
    sleep 10
  done
}

wait_for_server || exit 1

attempt=1
until run_checks; do
  if ((attempt >= attempts)); then
    echo "smoke: FAILED against $base" >&2
    exit 1
  fi
  echo "attempt $attempt of $attempts failed; retrying in 10s"
  attempt=$((attempt + 1))
  sleep 10
done
echo "ok  /healthz, /, /api/status.json, /api/history.json, /feed.xml, /metrics and /readyz answer on $base"
[ "$require_asset_cache" != true ] || echo "ok  the font under /assets/ is cached for a year on $base"

if [ "$require_ready" = true ]; then
  wait_for_ready || { echo "smoke: FAILED against $base" >&2; exit 1; }
fi

echo "smoke: OK"
