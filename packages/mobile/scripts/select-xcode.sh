#!/bin/sh
# Selects the newest released Xcode at or above a minimum major version (default 27) on a GitHub macOS
# runner, and fails with a clear message when the image has none. App Store Connect rejects uploads
# built with an older iOS SDK (ITMS-90725), so RELEASING-MOBILE.md names the same minimum.
# `sh scripts/select-xcode.sh 27`
set -eu
min="${1:-27}"
best=""
best_version=""
for app in /Applications/Xcode_*.app; do
  [ -d "$app" ] || continue
  [ -L "$app" ] && continue # Xcode_27.0.app and friends are aliases of the real bundle
  case "$app" in *[Bb]eta*|*_RC*|*_rc*) continue ;; esac
  version="$(basename "$app" .app)"
  version="${version#Xcode_}"
  major="${version%%.*}"
  case "$major" in ''|*[!0-9]*) continue ;; esac
  [ "$major" -ge "$min" ] || continue
  if [ -z "$best" ] || [ "$(printf '%s\n%s\n' "$best_version" "$version" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$version" ]; then
    best="$app"
    best_version="$version"
  fi
done
if [ -z "$best" ]; then
  echo "::error title=Xcode $min or later is missing::This runner image has no released Xcode $min or later under /Applications ($(ls -d /Applications/Xcode*.app 2>/dev/null | tr '\n' ' ')). App Store Connect requires the iOS $min SDK. Use a runner image that ships it (runs-on: xcode-$min); see RELEASING-MOBILE.md."
  exit 1
fi
sudo xcode-select --switch "$best/Contents/Developer"
xcodebuild -version
sdk="$(xcrun --sdk iphoneos --show-sdk-version)"
echo "iOS SDK: $sdk ($(xcrun --sdk iphoneos --show-sdk-path))"
if [ "${sdk%%.*}" -lt "$min" ]; then
  echo "::error title=iOS SDK too old::$best ships the iOS $sdk SDK; App Store Connect requires iOS $min or later."
  exit 1
fi
echo "::notice title=Xcode::$(xcodebuild -version | head -n 1), iOS SDK $sdk"
