#!/usr/bin/env bash
# The pnpm CLI that every job runs, pinned by hash and installed by Corepack.
#
# package.json's `packageManager` is `pnpm@<version>+sha512.<hex>`. Corepack
# (shipped with Node 22 and 24) downloads exactly that version from the npm
# registry and refuses it unless the sha512 of the pnpm package tarball is
# that hex digest, so a registry or cache that serves other bytes under the
# same name and version fails closed. (pnpm 12 is a native executable; the
# tarball Corepack hashes is the small wrapper, and the executable it then
# downloads is checked against npm's registry signature by pnpm's own
# downloader, with npm's keys built into that wrapper.) This is why jobs no
# longer run `npm install --global pnpm@<version>`: that trusts whatever the
# registry serves for the name, and OpenSSF Scorecard counts it as unpinned.
#
# Corepack alone pins pnpm: pnpm-workspace.yaml sets `pmOnFail: ignore`, so
# pnpm does not also record itself in a second YAML document of
# pnpm-lock.yaml, which OSV-Scanner would read instead of the dependencies.
#
#   check    packageManager is pnpm@X.Y.Z+sha512.<128 hex digits>. No network.
#   install  check, then enable Corepack's pnpm shim in a directory of its
#            own, which makes Corepack fetch and verify the pinned pnpm, and
#            confirm that `pnpm --version` reports it. Under GitHub Actions it
#            puts the shim first on PATH for the following steps; elsewhere it
#            prints the line to run.
#   verify   the `pnpm` on PATH is that shim and reports the pinned version.
#            Run it in a step after `install`, from the repository root.
#
# To move to a new pnpm: take the digest from the registry, as hex
#   npm view pnpm@<version> dist.integrity   (base64; convert it to hex)
# and put `pnpm@<version>+sha512.<hex>` in packageManager. The next
# `pnpm-pin.sh install` makes Corepack fetch it and fail unless the hash is
# the tarball's. `check` (CI's lint job and the tests) fails on a missing or
# malformed hash.
#
# Run locally: ./scripts/ci/pnpm-pin.sh check
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

mode="${1:-}"
bin="${PNPM_PIN_BIN:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pnpm-pin-bin}"

# Prints the pinned version and hex digest from packageManager, as two lines;
# empty lines when it is missing or malformed.
declared() {
  node -e '
    const pm = JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager ?? "";
    const m = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/.exec(pm);
    console.log(m ? m[1] : "");
    console.log(m ? m[2] : "");
  '
}

check() {
  local lines want hash
  lines="$(declared)"
  want="$(sed -n 1p <<<"$lines")"
  hash="$(sed -n 2p <<<"$lines")"
  if [ -z "$want" ]; then
    echo "::error file=package.json::packageManager must be pnpm@<major>.<minor>.<patch>+sha512.<128 hex digits>: the hash is what Corepack verifies the download against" >&2
    return 1
  fi
  echo "pnpm-pin: packageManager pins pnpm $want (sha512.${hash:0:12}...)"
}

want_version() {
  node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]"
}

case "$mode" in
  check)
    check
    ;;
  install)
    check
    want="$(want_version)"
    if ! command -v corepack >/dev/null; then
      echo "::error::corepack is not on PATH. It ships with Node 22 and 24; this Node ($(command -v node || echo none)) has none" >&2
      exit 1
    fi
    # Never ask: a CI job cannot answer, and the hash is the consent.
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    mkdir -p "$bin"
    corepack enable --install-directory "$bin" pnpm
    # The first run downloads and verifies the pinned pnpm.
    got="$("$bin/pnpm" --version)"
    if [ "$got" != "$want" ]; then
      echo "::error::installed pnpm $got, expected $want" >&2
      exit 1
    fi
    if [ -n "${GITHUB_PATH:-}" ]; then
      echo "$bin" >>"$GITHUB_PATH"
    else
      echo "pnpm-pin: pnpm $got ready. Put it first on PATH: export PATH=\"$bin:\$PATH\""
    fi
    ;;
  verify)
    want="$(want_version)"
    got="$(pnpm --version)"
    where="$(command -v pnpm)"
    if [ "$got" != "$want" ]; then
      echo "::error::expected pnpm $want, got $got ($where)" >&2
      exit 1
    fi
    if [ "$where" != "$bin/pnpm" ]; then
      echo "::error::pnpm $got is at $where, not the Corepack shim that pnpm-pin.sh install made at $bin/pnpm" >&2
      exit 1
    fi
    echo "pnpm-pin: pnpm $got from $where"
    ;;
  *)
    echo "usage: pnpm-pin.sh check|install|verify" >&2
    exit 2
    ;;
esac
