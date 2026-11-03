# Self-update, managed install and the desktop shell (PoC)

**Status:** proof of concept on branch `cez/5dd4afed`, 2026-09-25. Everything below runs
locally; nothing is published.

## Problem

`npx cezar-cli` reuses a stale cached version forever, `npm i -g` needs write access to a
global prefix, and neither gives the cockpit a way to update the process it runs in. The user
asked for: one command to install, a plain `cezar` on PATH, an update button in the cockpit
that restarts the app, channel picking (stable/nightly), version picking (downgrades), the
current `npx` flow untouched — and a desktop app for macOS/Windows/Linux.

## Design

### Managed install — `~/.cezar/versions`

```
~/.cezar/versions/<id>/                                one `npm install --prefix` tree per version
~/.cezar/versions/<id>/.cezar-install.json             {version, source: registry|local, installedAt}
~/.cezar/versions/<id>/node_modules/@open-mercato/cezar/dist/index.js
~/.cezar/versions/current -> <id>                      the active version (symlink, renamed into place)
~/.cezar/bin/cezar, cez                                launchers: exec node <current entry>
```

`<id>` is the version, plus `+local` for a build installed from a checkout or the npx cache
(`npm pack` of the running package). npm is the downloader and verifier — the same thing `npx`
does, into a directory cezar owns. Node stays an external requirement. State, never
configuration: delete the directory and `cezar install` rebuilds it.

`cezar install` packs THIS running package into the layout, writes the launchers and appends
one marked `export PATH=…` line to the shell rc (`--no-modify-path` to skip). `cezar update
[--channel] [--version]`, `cezar versions` and `cezar use <id>` are the headless twins of the
dialog. The launcher itself understands `cezar use` too, so a downgrade into a version that
predates all of this can always be undone from the shell.

### Install kinds

`detectInstallKind(process.argv[1])`: `managed`, `npx` (`/_npx/`), `global-npm`
(`/node_modules/`), `checkout` (`dist/` with a sibling `src/`), `unknown`. Only `managed` can
self-update; every other kind gets the reason and the one command that gets it there.
`npx cezar-cli` is unchanged.

### API — `/api/v1/workspace/self-update` (workspace-level, single-mount)

`GET` status · `POST refresh` · `PUT channel {channel}` · `POST apply {version}`. Contract in
`packages/contract/src/self-update.ts`. The browser sends a version STRING or a channel name,
never a URL or path. Apply = install (or reuse an installed id) → `activate` → restart; the
job's npm log is on the status, and the cockpit polls health until a different process answers
(a different version, or the same version with no job) and reloads. Not gated on
`localHandoff`: a hosted cockpit behind the installer's auth updates from here.

Channel lives in `~/.cezar/config.json` as `updateChannel`, seeded by `CEZ_UPDATE_CHANNEL`,
default stable. The boot-time check (#368) now resolves the channel's dist-tag with a
prerelease-aware compare, so nightlies work.

### Restart

`reexec` (terminal): close the listener, spawn `node <current entry> <same argv> --port <same>
--no-open` detached, exit. `supervisor` (`CEZ_SUPERVISED=1`, implied by `CEZ_DESKTOP=1`): exit
75 and let the supervisor relaunch through `current`. A systemd/launchd unit should set it
and `Restart=always`. Running agents die with the process; boot recovery (#367) re-queues them
and the dialog says so.

### Desktop shell — `packages/desktop` (Tauri 2)

A thin Rust supervisor, not an npm workspace: resolves `~/.cezar/versions/current` (or
`CEZ_DESKTOP_ENTRY`), spawns `node … serve --no-open --port <free>` through the user's LOGIN
shell (so nvm/volta/homebrew PATH and the agent CLIs resolve as in their terminal), waits for
health, navigates the webview to the cockpit. Exit 75 → relaunch (the cockpit updated itself).
Other exit → splash with the log tail. `CEZ_SUPERVISOR_PID` lets the sidecar follow a
force-quit shell down. Closing the window hides it (Dock app); Cmd+Q quits and kills the
sidecar. `CEZ_DESKTOP_CWD` overrides the boot folder, else the most recently opened registered
project. The shell needs no release to ship a cezar update.

## Not done (PoC)

- Windows launcher (`.cmd`) is untested. `current` on Windows is a junction (layout tests run
  on `windows-latest` in `desktop-check.yml`); a text file naming the id is still READ, for
  homes written by an earlier build.
- No spec-grade tests for the installer (npm shell-outs); layout, semver, registry parse and
  restart args are unit-tested.
- Tauri updater plugin for the shell itself, code signing, CI bundles per platform.
- `server-install` should switch to the managed layout and set `CEZ_SUPERVISED=1`.
- Only stable and nightly are offered in the picker; `pr-N` / `develop` previews are filtered.
