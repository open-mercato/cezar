# Mobile app testing: Flutter, Android emulator, iOS Simulator

cezar can provision the toolchains a task needs to test a mobile app, so an agent that finds
`flutter` missing installs it instead of giving up. Everything lives under `~/.cezar/tools`
(`CEZ_HOME` moves it), needs no `sudo`, and is **off until you opt in**: the switch in Settings → Resources → Test toolchains, or `CEZ_TOOL_INSTALL=1` in the environment that starts cezar (`CEZ_TOOL_INSTALL=0` forces it off).

```
cezar tools list                      what is installed (jdk, android-sdk, android-emulator, ios-simulator, flutter)
cezar tools ensure flutter android-emulator [--json] [--shell bash|powershell]
cezar tools env [--shell bash|powershell]      exports for the installed tools
cezar tools emulator start|stop       headless Android emulator "cezar"
cezar tools simulator boot|shutdown   iOS Simulator (macOS + Xcode)
```

Progress goes to stderr; stdout is the answer (a table, JSON, or shell exports), so
`eval "$(cezar tools env)"` works. Installs happen only when enabled in Settings or by `CEZ_TOOL_INSTALL=1` in the environment that starts cezar (there is deliberately no per-call flag: agents run this CLI).

## What gets installed

| id | What | Where | Notes |
|---|---|---|---|
| `jdk` | Temurin 17 (Adoptium assets API: newest 17 GA, SHA-256 checked) | `tools/jdk` | Needed by `sdkmanager`/`avdmanager`. A JDK 17+ already on the machine is used instead. |
| `android-sdk` | newest stable cmdline-tools, `platform-tools`, the newest stable `platforms;android-N` that also has a google_apis image for this CPU, matching `build-tools`, licenses accepted. All resolved from Google's repository manifests, with the published checksum verified | `tools/android-sdk` | An existing SDK (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, Android Studio's default folder) is used and extended instead. |
| `android-emulator` | `emulator`, `system-images;android-35;google_apis;<x86_64 or arm64-v8a>`, AVD `cezar` (pixel_6) | SDK + `tools/android-avd` | The AVD lives under cezar's tools dir (`ANDROID_AVD_HOME`), never in your `~/.android/avd`. |
| `ios-simulator` | **Detects** Xcode; with installs on, adds the iOS runtime (`xcodebuild -downloadPlatform iOS`) | system | macOS only. Xcode itself needs the App Store and an Apple ID: cezar cannot install it and says so. |
| `flutter` | Flutter stable from the official release archive (SHA-256 checked), then `flutter precache` | `tools/flutter` | Sets `FLUTTER_ROOT`. `flutter doctor` output is logged after the install. |

Android versions are read from Google's own manifests (`repository2-3.xml`, `sys-img2-3.xml`) at install time. If they cannot be fetched or parsed, cezar falls back to the pins in `packages/cezar/src/tools/constants.ts` (cmdline-tools 15859902, API 35) and logs that it did. The JDK is the newest Temurin 17 from the Adoptium API, Flutter the current stable from its release manifest.

Extraction uses what the OS ships, no new dependency: `tar` for `.tar.gz`/`.tar.xz`; for zips,
Windows `System32\tar.exe` (PowerShell `Expand-Archive` as fallback), macOS `tar`, Linux `unzip`
(install it if missing).

## Using it from a task

When installs are enabled and the cockpit is running (`serve` sets `CEZ_BIN`), every task's
system prompt says the command exists. Tools cezar already installed are on the task's `PATH`
(and on check steps' `PATH`) with `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME` and
`FLUTTER_ROOT` set, with no flag needed. The agent runs:

`ensure` prints its progress and result on stderr and only shell exports on stdout, so it can be
`eval`ed directly:

```sh
eval "$(node "$CEZ_BIN" tools ensure flutter android-emulator)"   # installs what is missing, puts it on PATH
node "$CEZ_BIN" tools emulator start                    # -> emulator-5554 booted
flutter test integration_test -d emulator-5554
```

Parallel tasks are safe: each tool has its own lock file, the loser waits and finds it
installed, and a half-finished download is a staging directory that is discarded, never a tool
that looks installed. A second task asking for a booted emulator reuses the running one.

## Flutter on Android

```sh
eval "$(node "$CEZ_BIN" tools ensure flutter android-emulator)"
node "$CEZ_BIN" tools emulator start
flutter test integration_test -d emulator-5554     # use the serial `start` printed
node "$CEZ_BIN" tools emulator stop
```

`start` and `stop` only touch an emulator running cezar's `cezar` AVD (asked with `adb emu avd name`).
Another emulator on the machine (BlueStacks, your own AVD) is never reused or killed, and cezar's takes
the next free even port, so use the serial `start` prints rather than assuming `emulator-5554`.

## Flutter on the iOS Simulator (macOS)

```sh
node "$CEZ_BIN" tools ensure flutter ios-simulator   # fails with instructions if Xcode is absent
node "$CEZ_BIN" tools simulator boot                 # prints the UDID
flutter test integration_test -d <udid>
node "$CEZ_BIN" tools simulator shutdown             # only the simulator cezar booted; one already running is left alone
```

## As workflow checks

[`docs/examples/implement-and-mobile-test.yaml`](examples/implement-and-mobile-test.yaml) is a
workflow whose check steps provision the toolchain, boot the emulator and run the tests, retrying
the implement step on failure. Copy it to `.ai/cezar/workflows/`. Check steps run under `serve`,
which exports `CEZ_BIN`. A headless `cezar run` has none, so call `cezar tools …` there. The
emulator is left running after the tests so the next step or task reuses it; stop it with
`node "$CEZ_BIN" tools emulator stop` (add that as a last check step if you want it gone).

## Limits

- The Android emulator needs hardware acceleration: KVM on Linux (`/dev/kvm`, your user in the `kvm` group), Hypervisor.framework on macOS, WHPX/Hyper-V on Windows. Without it the emulator is unusably slow or refuses to start; cezar warns on Linux. It also does not run on Windows for ARM. Linux hosts need the usual emulator libraries (`libpulse0`, `libnss3`, `libgl1`) and `unzip`.
- Parallel tasks share the one `cezar` emulator (`start` reuses a booted one). Tests that mutate device state can interfere with each other; there is a single AVD, so a second concurrent emulator is not offered.
- Pointing a task at the `cezar` AVD sets `ANDROID_AVD_HOME`; your own AVDs are invisible to that task.
- The iOS Simulator cannot be installed, only used. Flutter on Linux also needs `git`, `curl`, `xz-utils`, `zip`, `libglu1-mesa`.
- First install downloads roughly 2-4 GB (JDK 190 MB, cmdline-tools 150-180 MB, system image ~1.5 GB, Flutter ~1 GB with precache). `tools/logs/android-emulator.log` has the emulator's output.
- On Windows the SDK launchers are `.bat` files. In Git Bash call them by that name (`sdkmanager.bat --list`, or `cmd //c sdkmanager.bat …`); cezar itself runs them through `cmd.exe`.

To remove everything: delete `~/.cezar/tools`.
