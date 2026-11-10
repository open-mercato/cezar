#!/bin/sh
# Typechecks every iOS source against the Mac Catalyst SDK the Command Line Tools ship: the real
# UIKit, WebKit, AVFoundation, LocalAuthentication, UserNotifications, Network and CryptoKit, but a
# Capacitor STUB (test/swift/stubs). It is not an iOS build: APIs Catalyst lacks fail here, and iOS-only
# rules (deployment target, entitlements, Info.plist) are not checked. Xcode is the real gate.
set -eu
cd "$(dirname "$0")/.."
sdk="$(xcrun --show-sdk-path --sdk macosx)"
target="arm64-apple-ios17.0-macabi"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
common="-target $target -sdk $sdk -Fsystem $sdk/System/iOSSupport/System/Library/Frameworks -swift-version 5"
# shellcheck disable=SC2086
swiftc $common -parse-as-library -emit-module -module-name Capacitor -emit-module-path "$out/Capacitor.swiftmodule" test/swift/stubs/Capacitor.swift
# shellcheck disable=SC2086
swiftc $common -typecheck -I "$out" -module-name App $(find ios/App/App -name '*.swift' | sort)
echo "typecheck ok (Mac Catalyst SDK, Capacitor stub): $(find ios/App/App -name '*.swift' | wc -l | tr -d ' ') files"
