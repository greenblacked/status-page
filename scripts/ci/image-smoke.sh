#!/usr/bin/env bash
# Starts a built Docker image the way the README tells self-hosters to run it
# (read-only root, no capabilities, no new privileges), waits for its
# HEALTHCHECK to turn healthy, runs scripts/ci/smoke.sh against it, then stops
# it with SIGTERM, as an orchestrator does, and requires a clean exit.
#
#   docker build -t status-page:smoke .
#   ./scripts/ci/image-smoke.sh status-page:smoke
#
# Used by ci.yml for every pull request and by release.yml before the image is
# pushed. Needs docker, curl and jq. Exits 1 on any failed check, 2 on bad usage.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

image="${1:-}"
if [ -z "$image" ] || [ $# -ne 1 ]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi

name="status-page-smoke-$$"
port="${SMOKE_PORT:-3000}"
[[ "$port" =~ ^[1-9][0-9]*$ ]] || { echo "::error::SMOKE_PORT must be a port number" >&2; exit 2; }

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p "127.0.0.1:$port:3000" "$image" >/dev/null || { echo "::error::could not start $image" >&2; exit 1; }

healthy=false
for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || true)"
  if [ "$status" = healthy ]; then
    healthy=true
    break
  fi
  sleep 2
done
if [ "$healthy" != true ]; then
  echo "::error::the container did not become healthy within 60 s (last status: ${status:-none})" >&2
  docker logs "$name" >&2
  exit 1
fi
echo "ok  the container is healthy (HEALTHCHECK on /healthz)"

if ! ./scripts/ci/smoke.sh "http://127.0.0.1:$port" --attempts 3 --require-asset-cache; then
  docker logs "$name" >&2
  exit 1
fi

# SIGTERM, then Docker's own 10 s before it would send SIGKILL: a server that
# handles the signal exits at once with 0, one that does not is killed (137).
docker stop "$name" >/dev/null
code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
if [ "$code" != 0 ]; then
  echo "::error::the container stopped with exit code $code after SIGTERM, not 0" >&2
  docker logs "$name" >&2
  exit 1
fi
echo "ok  SIGTERM stops the container with exit code 0"
