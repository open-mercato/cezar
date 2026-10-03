# Desktop distribution — where cezar desktop is published and how it updates

**Status:** design + workflow in place, no release cut yet. 2026-09-25. Companion to
`2026-09-25-self-update-and-desktop.md` (the shell itself and the managed install).

## TLDR

The desktop shell (`packages/desktop`, Tauri 2) is published as **signed installers on GitHub
Releases**, one release per shell version under a `desktop-v<version>` tag, built by
`.github/workflows/desktop-release.yml`. Everything downstream — the landing page's Download
button, a Homebrew cask, winget, the shell's own auto-update — is a pointer to that release
page. The shell ships **rarely and on its own version** (`0.1.1` today, decoupled from cezar's
`0.11.x`): it contains no cezar code, because the cockpit and server come from
`~/.cezar/versions` and update from inside the cockpit.

## Two things update on two cadences

| What | Contains | Updated by | How often |
| --- | --- | --- | --- |
| **cezar** (`@open-mercato/cezar`) | server + cockpit | the cockpit's version chip → dialog, or `cezar update` (managed install, spec self-update) | every release / nightly |
| **cezar desktop** (`packages/desktop`) | window, title bar, sidecar supervisor, splash, icon | Tauri's updater plugin polling `desktop-latest.json` on GitHub Releases | a few times a year |

The shell must ship when: the shell changes (window, supervisor, splash), a Tauri/webview
security fix lands, or the icon/name/signing identity changes. Never for a cezar release.

## The release: GitHub Releases, tag `desktop-v<version>`

`desktop-release.yml` runs on a `desktop-v*` tag push, or by hand from the Actions tab (it then releases the
version `tauri.conf.json` names; `dry_run` builds the installers as run artifacts and publishes
nothing), and:

1. **prepare** — verifies the tag equals `packages/desktop/src-tauri/tauri.conf.json`'s
   `version` (a mismatched tag fails before any build) and creates a draft release.
2. **build** (matrix) — macOS Apple silicon, macOS Intel, Windows x64, Linux x64, through
   `tauri-apps/tauri-action`. Each job uploads the versioned bundle AND a **stable, versionless
   copy** plus its `.sha256`:

   | Platform | Stable asset |
   | --- | --- |
   | macOS (arm64) | `cezar-macos-aarch64.dmg` |
   | macOS (x64) | `cezar-macos-x86_64.dmg` |
   | Windows | `cezar-windows-x86_64-setup.exe` (NSIS) |
   | Linux (any distribution) | `cezar-linux-x86_64.AppImage` |
   | Debian, Ubuntu | `cezar-linux-x86_64.deb` |
   | Arch Linux (Omarchy, Manjaro, EndeavourOS) | `cezar-linux-x86_64.pkg.tar.zst` — `sudo pacman -U <file>` |

   The Arch package is its own job (`arch`): it repackages the `.deb`'s binary with
   `packages/desktop/arch/PKGBUILD` inside an `archlinux` container, installs the result with
   `pacman -U` and fails if `ldd` finds a library Arch does not provide. It runs against the
   system's WebKitGTK, which the AppImage cannot. Two limits: the in-app shell updater only
   replaces AppImages, so a pacman install is updated by installing the next package; and the
   package is not in the AUR — publishing there needs an AUR account and is a follow-up.

   Stable names are the contract: `https://github.com/open-mercato/cezar/releases/download/desktop-latest/<asset>`
   always resolves to the newest shell, so the landing page and package-manager manifests never
   change when a version ships. `desktop-latest` is a ROLLING release the publish job refreshes;
   GitHub's own `releases/latest/download/…` cannot be used, because the repo's "latest" release
   is cezar's `v*` release, which carries no installers.
3. **publish** — renames tauri-action's `latest.json` to **`desktop-latest.json`** (the name
   the shells poll; namespaced so a future cezar manifest on the same page cannot collide),
   flips the draft to published with `--latest=false` (cezar's `v*` releases stay the repo's
   "latest"), copies the stable-named installers and `desktop-latest.json` onto the rolling
   `desktop-latest` release (its assets and title change; its tag stays where the first
   release put it, because the workflow's token may not move a tag), and writes a summary with the stable links and loud warnings for anything unsigned.

`createUpdaterArtifacts` is passed **only in CI** (`--config`), never in the checked-in
config, so a local `tauri build` does not demand the signing key.

## Signing — the real gate on "easy install"

Secret-gated, all-or-nothing per platform, and the workflow degrades to unsigned builds with a
warning rather than failing — unsigned builds are fine for a maintainer to test and NOT fit for
a Download button (Gatekeeper reports them "damaged"; SmartScreen blocks them).

| Secret | Used for |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) | updater artifacts + `desktop-latest.json`. Public key is in `tauri.conf.json` `plugins.updater.pubkey`. Generated with `npx tauri signer generate`; the private half lives in the maintainer's `~/.tauri/cezar-desktop.key` and in this secret — lose it and installed shells can never adopt another update. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Developer ID Application certificate (base64 .p12) for code signing |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization (app-specific password) |
| Windows code signing | not wired yet — Azure Trusted Signing via `bundle.windows.signCommand` is the intended route; until then Windows builds are unsigned |

Apple Developer Program membership (99 USD/year) is the one purchase required before publishing
to anyone but maintainers.

## Shell auto-update

`tauri-plugin-updater` is initialised in `lib.rs`; once per launch, in the background, the shell
fetches `desktop-latest.json`, verifies the minisign signature against the embedded public key,
and installs silently — the new shell takes over on the **next** launch. It never restarts under
the user (only the cockpit's own updater does that, after asking), never blocks startup, and is
disabled in debug builds and by `CEZ_DESKTOP_NO_UPDATE=1`.

## Shipping a shell change — what the maintainer does, what the user sees

Most "app" changes never touch the shell: the title strip, the update pill, the dialog and
everything else painted by the cockpit ship with cezar itself through the channel updates.
The shell must ship only for native things — the app menu, window behaviour, the splash, the
injected fallbacks for legacy cockpits, OS-level features (native notifications need a Tauri
plugin in the shell, one release, then every cockpit version can use them).

Maintainer, per shell release:

1. Bump the shell version in all three manifests: `packages/desktop/package.json`,
   `packages/desktop/src-tauri/Cargo.toml`, `packages/desktop/src-tauri/tauri.conf.json`.
   The shell is versioned on its own (`0.1.1` today), never in step with cezar.
2. `git tag desktop-v<version> && git push --tags`. `desktop-release.yml` builds, signs, uploads
   the installers under stable names and publishes `desktop-latest.json`. (Or run the
   workflow by hand: it reads the version from `tauri.conf.json`.)

User: nothing. On the next launch the installed shell fetches `desktop-latest.json`, verifies
the minisign signature against the compiled-in public key, downloads and installs the bundle
in place (on macOS: the contents of `Cezar.app`), and the NEW shell runs on the launch after
that. It never restarts under the user, so a running task is never interrupted by a shell
update. A "Relaunch to update" prompt is a small later addition if the one-launch lag bothers.

Until signing is set up, a shell update is manual: download the new `.dmg`, drag it over the
old app. `~/.cezar` (versions, settings, window geometry) is untouched by that.

## One-time setup checklist (before the first public shell release)

| Step | Where | Why |
| --- | --- | --- |
| Back up `~/.tauri/cezar-desktop.key` (private half of the updater keypair, generated 2026-09-25, no password) | password manager / team vault | lose it and no installed shell can ever adopt another update; the public half is in `tauri.conf.json` |
| Add `TAURI_SIGNING_PRIVATE_KEY` (the file's contents) as a repository secret | GitHub → Settings → Secrets | without it the workflow builds installers but no `desktop-latest.json`, so shells never see a new version |
| Join the Apple Developer Program (99 USD/year), create a Developer ID Application certificate, export as base64 `.p12` | developer.apple.com | without it the build is signed AD-HOC (`signingIdentity: "-"`), which seals the bundle: a downloaded copy gets "could not verify" and Open Anyway in System Settings. A bundle that is not sealed at all is what macOS calls "damaged" — the first 0.1.1 build shipped that way. Notarization (no prompt at all) still needs the certificate |
| Add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` | GitHub secrets | tauri-action signs and notarizes with these; all-or-nothing |
| Windows: Azure Trusted Signing (or an EV cert), wired through `bundle.windows.signCommand` | later | SmartScreen otherwise warns on every install |
| Cut `desktop-v0.1.0` and check the workflow summary shows no "UNSIGNED" warning | GitHub Actions | the first real run will surface platform-specific matrix issues |
| Landing page + Homebrew tap pointing at the stable asset URLs | after the first green release | see "Downstream pointers" |

## The Node.js prerequisite

The shell runs cezar with the user's own Node (through the login shell, so nvm/volta/homebrew
installs resolve). Node 20+ is the ONE thing the installer cannot provide today, and it is
checked first: without it — or with an older one — the splash shows "cezar needs Node.js 20 or
newer" with the reason, a **Download Node.js** button (opens nodejs.org in the browser) and
**Try again** (re-runs the check and boots without relaunching the app). Nothing else runs
until Node is there: no npm, no sidecar, no update check. `CEZ_DESKTOP_NODE=<path>` overrides
which node the shell uses (also how the page is tested).

Next step, so the app has NO prerequisite: a managed Node runtime. The shell downloads the
official Node tarball for the platform into `~/.cezar/node/<version>/` (verified against
`SHASUMS256.txt`), and runs the sidecar with it when the login shell has none. The agent CLIs
are unaffected — `claude`'s native installer bundles its own runtime and `codex` is a binary —
so this closes the last gap between "download the app" and "it works".

## Replacing the icon (or any rebrand)

The mark lives in three places, on two cadences:

| Where | Ships with | Command |
| --- | --- | --- |
| Cockpit brand tile + favicon (`packages/web/public/icon.svg`) | cezar (npm) — every channel update | replace the SVG |
| App icon set (`packages/desktop/src-tauri/icons/*`: `.icns`, `.ico`, PNGs) and the splash logo (`packages/desktop/ui/icon.svg`) | the shell — one shell release | `cd packages/desktop && npm run icon [-- path/to/new.svg]` |

`npm run icon` wraps the SVG full-bleed (macOS masks its own squircle; a transparent corner or
margin gets a white plate in the Dock) — filled with `--bg` when given, the mark's gradient when
it has one, else the brand tile's black — renders it and runs `tauri icon`. It bumps nothing: bump
the shell version, tag `desktop-v…`, and every installed app shows the new icon after its next
launch (the shell auto-update). Nobody is stuck on an old icon: it is a bundle resource, not
something installed once.

The icon MUST ship with a version bump. macOS caches app icons keyed by bundle identifier and
version, so a bundle replaced in place at the same version keeps showing the old picture in the
Dock, Launchpad and Spotlight however new the `.icns` inside it is (seen on 2026-09-27: new
icon in the bundle, old icon in the Dock). A release always bumps, so users never hit it; a
maintainer iterating locally at one version clears it with
`lsregister -f /Applications/Cezar.app && killall Dock`.

## Being an application — what makes it show up and launch like one

The shell is a real native app the moment its release bundle is INSTALLED where the OS looks
for apps; nothing in cezar has to change per platform. `npx tauri build` (release, in
`packages/desktop`) produces the bundles; `desktop-release.yml` does the same in CI.

| Platform | Bundle | Installed how | Then it is… |
| --- | --- | --- | --- |
| macOS | `Cezar.app` (+ `.dmg` to ship it) | drag into `/Applications` (the dmg's only step), or `brew install --cask` | in Launchpad, Spotlight, the Dock (right-click → Options → Keep in Dock), Cmd+Tab; icon, menu bar, About box from the bundle |
| Windows | NSIS `cezar-…-setup.exe` (`.msi` optional) | run the installer, or `winget install` | Start menu entry, desktop shortcut, Apps & features (uninstall), taskbar pinning; needs WebView2, preinstalled on Windows 10/11 |
| Linux | `.deb` (+ `.AppImage` portable) | `apt install ./cezar….deb` — installs `/usr/bin/cezar-desktop` and a `.desktop` entry | in the app launcher/menu with icon; the AppImage runs from anywhere but only appears in menus after `--appimage-integrate` or a Flatpak (later) |

Launching from any of those is a plain double-click: the shell needs no terminal, no
environment, no PATH — it resolves everything itself (login shell for `node` and the agent
CLIs, `~/.cezar` for the managed cezar, first-launch install when none is there).

Worth adding once real users have it:

- **Open at login** (`tauri-plugin-autostart`, a menu toggle) so the cockpit is up with the
  machine and tasks keep running under the Dock icon.
- **Single instance** (`tauri-plugin-single-instance`): a second double-click focuses the
  running window instead of starting a second shell and a second sidecar.
- **Deep links** (`cezar://task/<id>`) so a notification or a browser link opens the task in
  the app.

A locally built bundle (no Developer ID) opens fine on the machine that built it — it carries no
quarantine flag. The same bundle DOWNLOADED by someone else is what Gatekeeper refuses; that is
the signing checklist above, not a packaging gap.

## What verifies the shell

`packages/desktop` is outside the npm workspaces, so the main CI job never compiles it.
`.github/workflows/desktop-check.yml` does, on every pull request and push that touches
`packages/desktop/**`: `cargo check --locked --all-targets` and `cargo test --locked` on Linux,
with no bundling, signing or secrets. Platform-gated code (`cfg(target_os = "macos")`, the
overlay title bar) is only compiled by the release build.

## Who may call the shell's commands

The capability file grants the three app commands to `http://127.0.0.1:*` and
`http://localhost:*`, because its URL patterns are static and the sidecar's port is picked at
launch. The narrowing is in the code: every command starts with `caller_is_trusted`, which
admits the splash and the cockpit **on the port this shell spawned** and nothing else, and
`on_navigation` applies the same rule, so a link to another local server (a dev server on
`localhost:3000`) opens in the browser instead of taking over the window.

## Downstream pointers (in the order to add them)

1. **Landing page "Download"** — a static page (Cloudflare/GitHub Pages) with OS detection and
   the stable asset links; optionally reads the release JSON for the version. No backend.
2. **Homebrew cask** in an `open-mercato/homebrew-tap`: `brew install --cask open-mercato/tap/cezar`,
   `url` = the stable dmg link, `sha256` from the `.sha256` asset, `livecheck` on GitHub Releases.
3. **winget** manifest (community repo), automatable from the publish job.
4. **Flathub** later; the AppImage covers Linux until then.

## The shell ↔ cezar contract (a public surface)

Any shell version must run any cezar version, so these are frozen and listed in
`BACKWARD_COMPATIBILITY.md`: the managed entry path
`~/.cezar/versions/current/node_modules/@open-mercato/cezar/dist/index.js`; the launch
`serve --no-open --port <n>`; `CEZ_DESKTOP=1`, `CEZ_SUPERVISED=1`, `CEZ_SUPERVISOR_PID`;
exit status **75** = "relaunch me"; `GET /api/v1/health` as the readiness probe. Changing any
of them is the one case where the shell must ship BEFORE the cezar version that needs it.

## What the shell does on its own (supervisor duties)

- **First launch** with no managed install: installs the channel's newest cezar
  (`npm install --prefix` into `~/.cezar/versions/<v>`, manifest, `current` link — the same
  layout the cockpit's updater writes) with progress on the splash, then starts it. Node 20+
  is the one prerequisite; the failure page says so.
- **App menu → "Update cezar to latest…"**: the same install, then a relaunch. This is what
  makes a downgrade into a version that predates the cockpit's updater recoverable from the
  GUI — the shell never depends on the sidecar being able to update itself.
- **App menu → Versions**: one check item per install under `~/.cezar/versions`, the active
  one checked; picking another flips `current` and relaunches. With "Update to latest" this is
  the complete recovery set: any installed version, including a local build, is one click away
  from any other, whatever the running cockpit knows.
- **Legacy title strip**: a cockpit that predates the desktop-aware shell paints no strip and the
  traffic lights would sit on its brand row. The shell's init script waits for the app to
  render, and when no `data-slot="desktop-titlebar"` appears it injects a draggable 28px strip
  (transparent, with the columns inset so they paint the band in their own live theme colours)
  and insets the app shell — so every version looks right under the shell, not only the ones
  that know about it. The same path injects the "Update cezar" pill there, driven by the
  shell's own `npm view` of the channel's dist-tag; a desktop-aware cockpit paints its own.
- **Version chip** (legacy cockpits): beside the pill, always present, `v<running> ▾` — a click
  pops the Versions list up as a native menu at the pointer. A registry cockpit without the
  update dialog therefore still has a visible, in-window way to any installed version,
  local builds included.
- **New task from anywhere**: a system-wide **Cmd/Ctrl+Alt+N** (`tauri-plugin-global-shortcut`,
  registered at launch) brings the main window forward, un-minimized and un-hidden, and moves
  the cockpit client-side to the active project's `/new` (`history.pushState` + `popstate`, so
  the page keeps its state and the composer focuses itself). Before the cockpit is up it only
  shows the window. A combination another app already owns is logged and skipped; the shell
  starts without it. A separate always-on-top quick-entry window was tried first and dropped
  for this: it showed a second, partial cockpit and stayed over the main one.
- **Port**: 4321 first (so `http://localhost:4321` works in a browser beside the app), the
  next few when busy, then any free port; the actual URL is on the app menu's
  "Open … in browser" item.
- The sidecar writes the `~/.cezar/bin` launchers on boot when they are missing, so a
  machine that only ever installed the app still gets `cezar` in a terminal (PATH hook is
  left to `cezar install`).

## Open items

- **Windows is built, and verified by CI rather than by hand.** The shell never hands Windows
  a script: `tool_command` starts `node` and `npm.cmd` directly with an argument list (there is
  no login shell, and a GUI process already has the user's PATH), the install is filesystem
  calls in Rust (`install_into`) instead of `sh`, and `current` is a junction — a directory
  link that needs no privilege. `desktop-check.yml` runs on `windows-latest` and proves the
  three things that used to be impossible there: Node is found, a sidecar starts and answers
  health, npm installs into a prefix with a space in it. What NO automated run covers is the
  window itself — nobody has clicked through the installed app on Windows. Do that once,
  from the first release's installer, before the download link goes public.
- Windows signing, Flathub, universal macOS binary (two dmgs today).
- A `cezar desktop` version chip somewhere in the cockpit (the sidecar knows `CEZ_DESKTOP`,
  the shell version could ride along in an env var) so a bug report names both versions.
- Windows/Linux title bar: native today; the macOS overlay treatment needs a custom bar there.
