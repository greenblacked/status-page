#!/usr/bin/env bash
# Smoke-tests a running Status Bar: the same checks for CI's Node preview,
# the Worker running locally in workerd, and a fresh Cloudflare deploy.
#
#   ./scripts/ci/smoke.sh http://127.0.0.1:4173
#   ./scripts/ci/smoke.sh http://127.0.0.1:4173 --cron status-bar
#   ./scripts/ci/smoke.sh https://status.example.com --require-ready --attempts 6
#   ./scripts/ci/smoke.sh https://status.example.com --expect-version <id> --wait 120
#
# Checks /healthz, the page (title, footer, security headers), the JSON API
# (14 services), the Atom feed, /metrics and /readyz. /readyz may answer 503
# unless --require-ready: CI and sandboxes cannot always reach the vendors,
# and an all-Unknown board is a correct answer there, not a broken build.
#
# --expect-version <id> first waits, within --wait, until /healthz carries
# X-Worker-Version: <id> (src/lib/worker-version.ts), then requires it on
# every response it checks. After a Cloudflare deploy this is the version id
# wrangler reported, so the checks run against the new version rather than
# the old one it is still replacing somewhere, and a new version that never
# starts answering fails instead of passing on the old one.
#
# --cron <worker> also runs the Worker's Cron Trigger through the Local
# Explorer API that `vite preview` of a DEPLOY_TARGET=cloudflare build
# serves, and checks that the snapshot the API returns moves forward. Only
# for local previews: a deployed Worker has no Local Explorer.
#
# Needs curl and jq. Exits 1 on any failed check, 2 on bad usage.
set -euo pipefail

SERVICES=14
TITLE='<title>Status Bar</title>'
FOOTER='Cached server snapshots update every two minutes from official vendor feeds.'
# cron-sweep.ts skips a sweep within MIN_FORCED_REFRESH_MS (15 s) of the
# last snapshot, so --cron waits until the snapshot is older than this.
CRON_THROTTLE_S=16
# The sweep itself (vendor timeouts are 9 s) plus the Worker's 5 s isolate
# memo, with room to spare on a slow runner.
CRON_ADVANCE_S=60

usage() {
  echo "usage: $0 <base-url> [--cron <worker-name>] [--require-ready] [--attempts <n>] [--wait <seconds>] [--expect-version <id>]"
}

base=""
cron_worker=""
require_ready=false
attempts=1
wait_s=60
expect_version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cron) [ $# -ge 2 ] || { usage >&2; exit 2; }; cron_worker="$2"; shift 2 ;;
    --require-ready) require_ready=true; shift ;;
    --attempts) [ $# -ge 2 ] || { usage >&2; exit 2; }; attempts="$2"; shift 2 ;;
    --wait) [ $# -ge 2 ] || { usage >&2; exit 2; }; wait_s="$2"; shift 2 ;;
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
# Worker version ids are UUIDs; this keeps anything else out of the messages.
if [ -n "$expect_version" ] && ! [[ "$expect_version" =~ ^[A-Za-z0-9-]{1,64}$ ]]; then
  echo "::error::--expect-version takes a Worker version id such as 8842dd8a-be26-460d-a3ea-2890e9015024" >&2
  exit 2
fi
# The name goes into a URL query string; Worker names are this shape anyway.
if [ -n "$cron_worker" ] && ! [[ "$cron_worker" =~ ^[a-z0-9-]+$ ]]; then
  echo "::error::--cron takes a Worker name such as status-bar" >&2
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
    grep -aqF "$FOOTER" "$work/body" || fail "/: no footer line \"$FOOTER\""
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

  get /readyz
  check_version /readyz
  case "$status" in
    200) ;;
    503)
      if [ "$require_ready" = true ]; then
        fail "/readyz: 503 $(head -c 300 "$work/body")"
      else
        echo "note: /readyz is 503 (allowed without --require-ready): $(head -c 300 "$work/body")"
      fi
      ;;
    *) fail "/readyz: $status, expected 200 or 503" ;;
  esac

  return "$failed"
}

generated_at() {
  get /api/status.json
  [ "$status" = 200 ] && jq -r '.generatedAt // empty' "$work/body" 2>/dev/null
}

# jq's fromdateiso8601 takes no fractional seconds, and toISOString always
# writes milliseconds.
age_seconds() {
  jq -nr --arg t "$1" '(now - ($t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) | floor'
}

check_cron() {
  local before after age deadline
  before="$(generated_at)" || true
  if [ -z "$before" ]; then
    fail "--cron: /api/status.json had no generatedAt to compare against"
    return 1
  fi
  age="$(age_seconds "$before")" || age=0
  if ((age < CRON_THROTTLE_S)); then
    echo "snapshot is ${age}s old; waiting past the sweep throttle"
    sleep $((CRON_THROTTLE_S - age))
  fi

  local explorer="$base/cdn-cgi/local/explorer/api/local/scheduled?worker=$cron_worker"
  status="$(curl --silent --show-error --max-time 90 --output "$work/body" --write-out '%{http_code}' \
    -X POST -H 'Content-Type: application/json' -d '{"cron":"*/2 * * * *"}' "$explorer")" || status=000
  if [ "$status" != 200 ] || ! jq -e '.success == true and .result.outcome == "ok"' "$work/body" >/dev/null 2>&1; then
    fail "--cron: the scheduled handler of $cron_worker did not run cleanly ($status): $(head -c 300 "$work/body")"
    return 1
  fi

  deadline=$((SECONDS + CRON_ADVANCE_S))
  while :; do
    after="$(generated_at)" || true
    if [ -n "$after" ] && [[ "$after" > "$before" ]]; then
      echo "ok  cron sweep moved the snapshot from $before to $after"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      fail "--cron: the snapshot stayed at $before for ${CRON_ADVANCE_S}s after the cron ran"
      return 1
    fi
    sleep 2
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
echo "ok  /healthz, /, /api/status.json, /feed.xml, /metrics and /readyz answer on $base"

if [ -n "$cron_worker" ]; then
  check_cron || { echo "smoke: FAILED against $base" >&2; exit 1; }
fi
echo "smoke: OK"
