#!/usr/bin/env bash
# Run this repository's checks inside a greenblacked/github-base-images CI
# image. compose.yaml calls it; it is not meant for the host.
#
#   verify   npm ci, lint, typecheck, tests, build, then the repository checks
#   preview  npm ci and build, then serve the built board on 0.0.0.0:4173
set -euo pipefail

cd /workspace
mode="${1:-verify}"

# The images ship whatever npm their Node release bundles. Pin the version
# package.json declares, the same way CI's setup action does: from the
# hash-locked tools/npm lockfile, not by name. /workspace is the host's
# checkout (bind-mounted read-write, and this runs as root), so the install
# goes into a directory of the container's own: writing tools/npm/node_modules
# there would leave a root-owned tree on the host that a host-side
# `npm-pin.sh install` cannot delete.
want_npm="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if [ "$(npm --version)" != "$want_npm" ]; then
  ./scripts/ci/npm-pin.sh check
  pinned="$(mktemp -d)"
  cp tools/npm/package.json tools/npm/package-lock.json "$pinned/"
  npm ci --prefix "$pinned" --ignore-scripts --no-audit --no-fund
  export PATH="$pinned/node_modules/.bin:$PATH"
  if [ "$(npm --version)" != "$want_npm" ]; then
    echo "container-checks: expected npm $want_npm, got $(npm --version)" >&2
    exit 1
  fi
fi
echo "node $(node --version), npm $(npm --version)"

npm ci --no-audit --no-fund

case "$mode" in
  verify)
    npm run lint
    npm run typecheck
    npm test
    npm run build
    ./scripts/ci/hygiene.sh
    ./scripts/ci/links.sh
    ;;
  preview)
    npm run build
    # `npm run preview` binds 127.0.0.1, which is unreachable from outside the
    # container, so call vite directly on every interface.
    exec npx vite preview --host 0.0.0.0 --port 4173 --strictPort
    ;;
  *)
    echo "usage: container-checks.sh [verify|preview]" >&2
    exit 2
    ;;
esac
