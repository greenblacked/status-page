#!/usr/bin/env bash
# Run this repository's checks inside a greenblacked/github-base-images CI
# image. compose.yaml calls it; it is not meant for the host.
#
#   verify   pnpm install, lint, typecheck, tests, build, then the repository checks
#   preview  pnpm install and build, then serve the built board on 0.0.0.0:4173
set -euo pipefail

cd /workspace
mode="${1:-verify}"

# The images do not ship pnpm. Install the version package.json declares, the
# same way CI's setup action does: through Corepack, which refuses a download
# whose sha512 is not the one in packageManager. The shim goes into a
# directory of the container's own: /workspace is the host's checkout
# (bind-mounted read-write, and this runs as root), so nothing is written to
# it that a host-side install could not delete.
pnpm_bin="$(mktemp -d)"
PNPM_PIN_BIN="$pnpm_bin" ./scripts/ci/pnpm-pin.sh install
export PATH="$pnpm_bin:$PATH"
PNPM_PIN_BIN="$pnpm_bin" ./scripts/ci/pnpm-pin.sh verify
echo "node $(node --version), pnpm $(pnpm --version)"

pnpm install --frozen-lockfile

case "$mode" in
  verify)
    pnpm run lint
    pnpm run typecheck
    pnpm test
    pnpm run build
    ./scripts/ci/hygiene.sh
    ./scripts/ci/links.sh
    ;;
  preview)
    pnpm run build
    # `pnpm run preview` binds 127.0.0.1, which is unreachable from outside the
    # container, so call vite directly on every interface.
    exec pnpm exec vite preview --host 0.0.0.0 --port 4173 --strictPort
    ;;
  *)
    echo "usage: container-checks.sh [verify|preview]" >&2
    exit 2
    ;;
esac
