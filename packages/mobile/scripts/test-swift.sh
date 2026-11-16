#!/bin/sh
# Compiles the plain iOS classes for macOS and runs them. Needs only the Command Line Tools.
# One suite per test/swift/<suite>/: its `sources` file lists globs under packages/mobile, and its
# *.swift files are the checks. A source that imports UIKit or Capacitor is left out: macOS has neither.
# `sh scripts/test-swift.sh relay` runs one suite.
set -eu
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
status=0
for dir in test/swift/*/; do
  suite="$(basename "$dir")"
  [ -f "$dir/sources" ] || continue
  if [ $# -gt 0 ] && [ "$suite" != "$1" ]; then continue; fi
  files=""
  # shellcheck disable=SC2013
  for pattern in $(grep -v '^#' "$dir/sources"); do
    for file in $pattern; do
      [ -f "$file" ] || continue
      if grep -qE '^import (UIKit|Capacitor)' "$file"; then continue; fi
      files="$files $file"
    done
  done
  echo "== $suite"
  # shellcheck disable=SC2086
  swiftc -O $files "$dir"*.swift -o "$out/$suite" || { status=1; continue; }
  "$out/$suite" || status=1
done
exit $status
