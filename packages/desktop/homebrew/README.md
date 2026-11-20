# open-mercato/homebrew-tap

Homebrew tap for [cezar](https://github.com/open-mercato/cezar), the local cockpit for AI coding
agents.

## Install

```sh
brew trust --cask open-mercato/tap/cezar   # Homebrew loads a non-official cask only once you trust it
brew install --cask open-mercato/tap/cezar
```

This installs the signed, notarized `Cezar.app` desktop app into `/Applications`. It needs
macOS 12 (Monterey) or newer, on Apple silicon or Intel.

## Upgrade

The app updates itself in place. When an update is available, Cezar offers it inside the app,
so `brew upgrade` skips it by default. To make Homebrew reinstall the newest release anyway:

```sh
brew upgrade --cask --greedy cezar
```

## Uninstall

```sh
brew uninstall --cask cezar
```

To also remove the desktop app's own data (window state, caches, WebKit storage, its managed
Node.js runtime):

```sh
brew uninstall --cask --zap cezar
```

`--zap` leaves `~/.cezar` alone apart from the desktop app's own files there. That folder also
belongs to the `cezar` CLI: your projects, managers and agent accounts. Delete it by hand only if
you want to reset cezar completely.

## How this tap is updated

Every desktop release (`desktop-v*` tag in open-mercato/cezar) bumps the version and both
`sha256` values in `Casks/cezar.rb` automatically. Change anything else in the cask in
[`packages/desktop/homebrew/`](https://github.com/open-mercato/cezar/tree/main/packages/desktop/homebrew)
in the cezar repository first, then copy it here.
