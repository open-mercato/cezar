# Tool provisioning — mobile test toolchains

Status: implemented (2026-10-21). Code: `packages/cezar/src/tools/`; user doc: `docs/mobile-testing.md`.

## Problem

An agent asked to test a Flutter/Android/iOS app stops at "flutter: command not found" or "no
emulator". The e2e runner already supports an `agent-device` mobile engine, but nothing gets the
SDKs onto the machine or boots a device.

## Shape

- **Recipe registry** (`registry.ts`). Each tool: `detect()` (system first, then `~/.cezar/tools`),
  `install()`, a sync stat-only `env()` (PATH additions and variables), a manual `hint()`.
  Ids: `jdk`, `android-sdk`, `android-emulator`, `ios-simulator`, `flutter`. `requires` orders the
  chain (emulator -> sdk -> jdk) and a failed dependency makes its dependents `blocked`.
- **User-space installs** under `cezarHomeDir()/tools` — no sudo, no system package manager (brew/apt/winget
  fallbacks were left out: they prompt, need root, and cannot be made non-interactive reliably). Archives
  are downloaded with `fetch`, verified by SHA-256 when the vendor publishes one (Android cmdline-tools,
  Flutter), extracted by the OS's `tar`/`unzip` into a per-process staging dir and moved into place by
  rename, so an interrupted install never looks installed. All URLs and pins: `constants.ts`.
- **Concurrency.** Per-tool lock file (exclusive create, pid liveness, 60 min staleness — the
  `skills-update.ts` pattern). The loser waits, re-detects inside the lock, and does not install twice.
  Emulator start/boot take their own run-lock so parallel agents share one booted device.
- **CLI** (`tools-cli.ts`, routed in `index.ts` like `telemetry`): in-process, no cockpit needed.
  `tools list|status`, `tools ensure <id…>`, `tools env`, `tools emulator start|stop`,
  `tools simulator boot|shutdown`; `--json`, `--shell bash|powershell`, `--install`. Exit 0 ready, 1 not
  ready, 2 usage. Agents call it as `node "$CEZ_BIN" tools …` (the same entrypoint `cez task` uses).
- **Opt-in.** `CEZ_TOOL_INSTALL=1` enables network installs (AGENTS.md § Zero config: network + disk).
  Off, `ensure` only detects and prints what is missing and the flag to set. `--install` enables it for one
  invocation — an explicit act by whoever types it.
- **Agent integration.**
  - `agentEnv` and `checkStepEnv` add the PATH entries and `ANDROID_HOME`/`ANDROID_SDK_ROOT`/`JAVA_HOME`/
    `FLUTTER_ROOT`/`ANDROID_AVD_HOME` of tools **cezar installed** (`managedToolsEnv`: stat only, never
    installs, `{}` when `~/.cezar/tools` is empty, so the env is unchanged for everyone else). System SDKs
    are deliberately not injected at launch.
  - `buildChildEnv` already passed `PATH`, `ANDROID_*`, `JAVA*`; `FLUTTER_` and `PUB_` were added.
  - A short prompt (`tools/prompt.ts`), composed beside the automations prompt at both `ActiveRun`
    construction sites, only when `CEZ_TOOL_INSTALL` is on and `CEZ_BIN` is known. `CEZ_BIN` is also
    handed to agents in that case (it used to travel only with `CEZ_API_URL`).
- **iOS.** Xcode cannot be installed unattended. The recipe detects `xcrun simctl`, adds the iOS runtime
  when installs are on, and `simulator boot` picks/creates an iPhone and waits on `simctl bootstatus -b`.
  Elsewhere it reports `unsupported`.

## Resolved assumptions

| Question | Decision |
|---|---|
| git clone or archive for Flutter? | Official archive. A `--depth 1` clone has no tags, so `flutter --version` reports `0.0.0-unknown`. |
| System SDK vs cezar's own? | An existing SDK/JDK is used when complete; cezar installs only what is missing, into the SDK it resolved (its own when none exists). |
| AVD location | `tools/android-avd` via `ANDROID_AVD_HOME`, so the user's AVD folder is untouched. |
| Settings toggle | Skipped; it would add a contract field and UI for a flag that is set once. Env var and `--install` only. |
| `agent-device` / other npm tools | Skipped; `npx` already covers them and they are not a toolchain install. |

## Not covered / follow-ups

- Windows-on-ARM (no JDK 17/emulator), Linux without `unzip`, hosts without virtualization.
- Real-hardware runs of the install and boot paths are manual; tests inject `exec`/`fetch` against a temp dir.
- A Settings toggle and a progress surface in the cockpit.
