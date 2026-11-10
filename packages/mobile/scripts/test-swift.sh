#!/bin/sh
# Compiles the plain iOS classes for macOS and runs them. Needs only the Command Line Tools.
set -eu
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
plain="$(ls ios/App/App/Shell/*.swift | grep -v ServerViewController)"
# shellcheck disable=SC2086
swiftc $plain test/swift/main.swift -o "$out/shell-tests"
"$out/shell-tests"
