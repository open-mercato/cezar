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
3. Create a fine-grained personal access token:
   - Resource owner: `open-mercato`. Repository access: only `open-mercato/homebrew-tap`.
   - Repository permissions: **Contents: Read and write**. Nothing else.
   - Pick an expiry and put a reminder in the calendar to rotate it.
4. In `open-mercato/cezar` → Settings → Secrets and variables → Actions, add the repository secret
   `HOMEBREW_TAP_TOKEN` with that token.

## What each release does

The `homebrew-tap` job in `.github/workflows/desktop-release.yml` runs after **Publish release**,
on real releases only (never `dry_run`). It downloads the two `cezar-macos-*.dmg.sha256` assets,
runs `packages/desktop/scripts/bump-homebrew-cask.mjs` on the tap's `Casks/cezar.rb` and pushes a
`cezar <version>` commit to the tap's `main`. A re-run is a no-op.

It skips with a warning, without failing the release, when `HOMEBREW_TAP_TOKEN` is missing or the
tap has no `Casks/cezar.rb` yet. In that case bump the cask by hand:

```sh
node packages/desktop/scripts/bump-homebrew-cask.mjs Casks/cezar.rb <version> <arm64 sha256> <x86_64 sha256>
```

## Changing the cask

The job only rewrites `version` and the two `sha256` values. For any other change, edit
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
