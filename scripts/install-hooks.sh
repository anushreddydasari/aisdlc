#!/bin/sh
#
# Activates the hooks in .githooks/ for this clone.
#
#   sh scripts/install-hooks.sh
#
# core.hooksPath is local configuration and is not carried by a clone, so
# this has to be run once per checkout. That is the cost of hooks with no
# npm dependency — a gate that needs `npm install` before it protects
# anything is the wrong shape.

set -eu

cd "$(dirname "$0")/.."

git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true

# This repository has core.filemode=false (Windows), so the executable bit is
# not tracked by default. Set it explicitly or the hooks land non-executable
# on Linux and macOS.
for hook in .githooks/*; do
  [ -f "$hook" ] || continue
  git update-index --chmod=+x "$hook" 2>/dev/null || true
done

printf 'hooks installed: core.hooksPath -> .githooks\n'
printf 'checks: credential files, credential shapes, local .env values,\n'
printf '        .env.example values, >1MB blobs, typecheck + offline tests\n'
