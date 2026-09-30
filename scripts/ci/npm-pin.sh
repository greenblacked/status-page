#!/usr/bin/env bash
# The npm CLI that CI runs, installed from a lockfile instead of by name.
#
# package.json's `packageManager` names one npm version. Node ships its own
# npm, which is usually another, so the jobs install the pinned one. They used
# to run `npm install --global npm@<version>`, which trusts whatever the
# registry serves for that name and version. tools/npm/package-lock.json
# records the tarball's sha512 instead, so `npm ci` refuses anything else
# (and OpenSSF Scorecard counts the install as pinned by hash).
#
#   check    tools/npm names the same npm version as packageManager, exactly,
#            in both its package.json and its lockfile. No network.
#   install  check, then `npm ci` into tools/npm/node_modules (no install
#            scripts), and confirm the npm it installed reports that version.
#            Under GitHub Actions it puts that npm first on PATH for the
#            following steps; elsewhere it prints the line to run.
#   verify   the `npm` on PATH is the pinned version, and is the one from
#            tools/npm. Run it in a step after `install`.
#
# To move to a new npm: change `packageManager`, run
#   npm install --package-lock-only --ignore-scripts --save-exact npm@<version> --prefix tools/npm
# and commit both. Dependabot proposes the tools/npm half; `check` (CI's lint
# job and the tests) fails until `packageManager` follows.
#
# Run locally: ./scripts/ci/npm-pin.sh check
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

mode="${1:-}"
tools=tools/npm
bin="$PWD/$tools/node_modules/.bin"

# Reads the versions with node (already on every runner) and prints them, one
# per line: packageManager's, the tools package.json's, the lockfile's.
declared() {
  node -e '
    const read = (p) => JSON.parse(require("node:fs").readFileSync(p, "utf8"));
    const pm = read("package.json").packageManager ?? "";
    const m = /^npm@(\d+\.\d+\.\d+)$/.exec(pm);
    console.log(m ? m[1] : "");
    console.log(read(process.argv[1] + "/package.json").dependencies?.npm ?? "");
    console.log(read(process.argv[1] + "/package-lock.json").packages?.["node_modules/npm"]?.version ?? "");
  ' "$tools"
}

check() {
  local versions want manifest locked
  versions="$(declared)"
  want="$(sed -n 1p <<<"$versions")"
  manifest="$(sed -n 2p <<<"$versions")"
  locked="$(sed -n 3p <<<"$versions")"
  if [ -z "$want" ]; then
    echo "::error file=package.json::packageManager must be npm@<major>.<minor>.<patch>, without a range or hash suffix" >&2
    return 1
  fi
  if [ "$manifest" != "$want" ]; then
    echo "::error file=$tools/package.json::npm is '$manifest', but packageManager pins $want. Run: npm install --package-lock-only --ignore-scripts --save-exact npm@$want --prefix $tools" >&2
    return 1
  fi
  if [ "$locked" != "$want" ]; then
    echo "::error file=$tools/package-lock.json::locks npm '$locked', but packageManager pins $want. Regenerate it: npm install --package-lock-only --ignore-scripts --prefix $tools" >&2
    return 1
  fi
  echo "npm-pin: packageManager, $tools/package.json and its lockfile all pin npm $want"
}

case "$mode" in
  check)
    check
    ;;
  install)
    check
    want="$(node -p "require('./package.json').packageManager.split('@')[1]")"
    npm ci --prefix "$tools" --ignore-scripts --no-audit --no-fund
    got="$("$bin/npm" --version)"
    if [ "$got" != "$want" ]; then
      echo "::error::installed npm $got from $tools, expected $want" >&2
      exit 1
    fi
    if [ -n "${GITHUB_PATH:-}" ]; then
      echo "$bin" >>"$GITHUB_PATH"
    else
      echo "npm-pin: installed npm $got. Put it first on PATH: export PATH=\"$bin:\$PATH\""
    fi
    ;;
  verify)
    want="$(node -p "require('./package.json').packageManager.split('@')[1]")"
    got="$(npm --version)"
    where="$(command -v npm)"
    if [ "$got" != "$want" ]; then
      echo "::error::expected npm $want, got $got ($where)" >&2
      exit 1
    fi
    case "$(readlink -f "$where")" in
      "$PWD/$tools/node_modules/"*) ;;
      *)
        echo "::error::npm $got is at $where, not the one installed from $tools" >&2
        exit 1
        ;;
    esac
    echo "npm-pin: npm $got from $tools"
    ;;
  *)
    echo "usage: npm-pin.sh check|install|verify" >&2
    exit 2
    ;;
esac
