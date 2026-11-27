# Homebrew tap: setup and maintenance

`brew install --cask open-mercato/tap/cezar` resolves to the GitHub repo
**open-mercato/homebrew-tap**, file `Casks/cezar.rb`. This folder holds what that repo starts
from:

| Here | In the tap repo |
| --- | --- |
| `Casks/cezar.rb` | `Casks/cezar.rb` |
| `README.md` | `README.md` |

The cask points at the VERSIONED release (`desktop-v#{version}/cezar-macos-<arch>.dmg`), never the
rolling `desktop-latest` release, whose files change under a fixed `sha256`.

## One-time setup (by hand)

1. Create the public repo `open-mercato/homebrew-tap` with default branch `main`.
2. Push `Casks/cezar.rb` and `README.md` from this folder to its `main`, unchanged.
3. Give the release GitHub App access to the tap. The app is the one `release.yml`,
   `release-cut.yml` and `backport.yml` mint their token from (`vars.RELEASE_APP_CLIENT_ID`,
   `secrets.RELEASE_APP_PRIVATE_KEY`): today that is **open-mercato-assistant**. An org owner
   opens Org settings → GitHub Apps → the release app → Configure → Repository access and adds
   `open-mercato/homebrew-tap`. The app already has **Contents: Read and write**, which releases
   and backports need, so no permission change is required. No new secret either.

## What each release does

The `homebrew-tap` job in `.github/workflows/desktop-release.yml` runs after **Publish release**,
on real, release-signed releases only (never `dry_run`, never an `allow_untrusted` prerelease). It downloads the two `cezar-macos-*.dmg.sha256` assets,
runs `packages/desktop/scripts/bump-homebrew-cask.mjs` on the tap's `Casks/cezar.rb` and pushes a
`cezar <version>` commit to the tap's `main` with a release-app token scoped to the tap alone
(`owner: open-mercato`, `repositories: homebrew-tap`, `permission-contents: write`). A re-run is a
no-op, and re-running an older release never downgrades the cask.

It skips with a warning, without failing the release, when that token cannot be minted (the release
app is not installed on the tap, or lacks Contents write there: "install the release app on
open-mercato/homebrew-tap"), or when the tap has no `Casks/cezar.rb` yet. In that case bump the cask by hand:

```sh
node packages/desktop/scripts/bump-homebrew-cask.mjs Casks/cezar.rb <version> <arm64 sha256> <x86_64 sha256>
```

## The `cez` binaries

`Cezar.app` carries the `cez` shim (`Contents/Resources/bin/cez`, and `cezar` beside it) from the
first desktop release built from a commit that has `packages/desktop/src-tauri/resources/bin/cez`.
Releases up to 0.1.11 do not. A `binary` stanza whose source is missing fails `brew install`. So
`Casks/cezar.rb` here and in the tap stays WITHOUT `binary` lines, and the release job adds them:
it checks the release's own commit for the shim and passes `--binaries` to the bump script. That
script adds

```ruby
  binary "#{appdir}/Cezar.app/Contents/Resources/bin/cez"
  binary "#{appdir}/Cezar.app/Contents/Resources/bin/cezar"
```

right after `app "Cezar.app"`, once, and never removes them. Nobody has to remember to add them,
and no cask version ever names a shim its DMG lacks. Once the tap has them, copy the tap's cask
back here so the two match.

## Changing the cask

The job only rewrites `version` and the two `sha256` values (plus the one-time `binary` lines
above). For any other change, edit
`Casks/cezar.rb` here, then copy it to the tap with the tap's current `version` and `sha256` lines
kept. Check it with a local tap first:

```sh
brew tap-new --no-git cezartest/tap
cp Casks/cezar.rb "$(brew --repository cezartest/tap)/Casks/"
brew trust --tap cezartest/tap
brew style --cask cezartest/tap/cezar
brew audit --cask --strict --online cezartest/tap/cezar
brew livecheck --cask cezartest/tap/cezar
brew untap cezartest/tap && brew untrust --tap cezartest/tap
```

`zap` removes the desktop app's macOS containers (`com.openmercato.cezar`) and the files only the
app writes in `~/.cezar` (`desktop-window.json`, `desktop-notch.json`, `node/`). It never removes
the rest of `~/.cezar`, which the `cezar` CLI shares. Keep that list in step with `cezar_home()`
uses in `packages/desktop/src-tauri/src/`.
