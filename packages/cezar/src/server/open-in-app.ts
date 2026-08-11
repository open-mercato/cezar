import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RunnerId } from '../core/agent-runner.ts';
import { openInTerminal, refuseSpawnUnderTest } from './open-in-terminal.ts';
import { isWsl, translateToWindowsPath } from './wsl.ts';

/**
 * "Open in…" session takeover (#open-in): detect the editors / file managers / terminals on THIS
 * machine, and open a run's worktree in the one the user picks — the desktop-app equivalent of
 * the "cd <path>" hint. Local-only; the server gates these behind `localHandoff` (CEZ_REMOTE).
 *
 * Detection is best-effort and cross-platform: an editor counts as present if its CLI is on PATH
 * or (macOS) its .app bundle is installed. Finder/file-manager and Terminal are always offered.
 *
 * WSL (#361): when this process itself runs inside WSL, `process.platform` reads `linux` but the
 * user's GUI apps mostly live on the Windows side, reachable through interop. `resolveOnPath`
 * additionally probes directly-spawnable `.com`/`.exe` suffixes there (Node's own PATH lookup
 * only does that under real win32), and `openInApp`/`openFileManager` translate the worktree path
 * to its `\\wsl$\…` (or `C:\…`) form before handing it to a resolved Windows-side binary — a WSL-native
 * launcher (e.g. VS Code's Remote-WSL `code` shim) keeps the POSIX path unchanged.
 */

export interface OpenTarget {
  id: string;
  label: string;
  /** A stable icon key the UI maps to a concrete icon component (#361). Optional so an older
   *  server talking to a newer client (or vice versa) just falls back to a generic icon —
   *  never a protocol break. */
  icon?: string;
}

interface EditorDef {
  id: string;
  label: string;
  icon: string;
  /** CLI launcher name on PATH, if any. */
  cli?: string;
  /** macOS .app bundle name(s) (without `.app`), for `open -a` when no CLI is present. Some
   *  JetBrains products ship differently-named Community/Ultimate/Professional editions, hence
   *  an array — any installed candidate counts. */
  mac?: string | string[];
}

const EDITORS: EditorDef[] = [
  { id: 'vscode', label: 'VS Code', icon: 'vscode', cli: 'code', mac: 'Visual Studio Code' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor', cli: 'cursor', mac: 'Cursor' },
  { id: 'zed', label: 'Zed', icon: 'zed', cli: 'zed', mac: 'Zed' },
  { id: 'windsurf', label: 'Windsurf', icon: 'windsurf', cli: 'windsurf', mac: 'Windsurf' },
  { id: 'sublime', label: 'Sublime Text', icon: 'sublime', cli: 'subl', mac: 'Sublime Text' },
  // JetBrains (#361 gap 3): Toolbox's "generate shell scripts" produces one bare-name launcher
  // per product on every OS (idea, pycharm, …); the .app names below cover the Community /
  // Ultimate / Professional edition splits Toolbox and the standalone installers both produce.
  { id: 'idea', label: 'IntelliJ IDEA', icon: 'idea', cli: 'idea', mac: ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'] },
  { id: 'pycharm', label: 'PyCharm', icon: 'pycharm', cli: 'pycharm', mac: ['PyCharm', 'PyCharm CE', 'PyCharm Professional'] },
  { id: 'webstorm', label: 'WebStorm', icon: 'webstorm', cli: 'webstorm', mac: 'WebStorm' },
  { id: 'goland', label: 'GoLand', icon: 'goland', cli: 'goland', mac: 'GoLand' },
  { id: 'rubymine', label: 'RubyMine', icon: 'rubymine', cli: 'rubymine', mac: 'RubyMine' },
  { id: 'phpstorm', label: 'PhpStorm', icon: 'phpstorm', cli: 'phpstorm', mac: 'PhpStorm' },
  { id: 'clion', label: 'CLion', icon: 'clion', cli: 'clion', mac: 'CLion' },
  { id: 'rider', label: 'Rider', icon: 'rider', cli: 'rider', mac: 'Rider' },
  { id: 'android-studio', label: 'Android Studio', icon: 'android-studio', cli: 'studio', mac: 'Android Studio' },
  { id: 'xcode', label: 'Xcode', icon: 'xcode', mac: 'Xcode' },
  { id: 'warp', label: 'Warp', icon: 'warp', cli: 'warp', mac: 'Warp' },
];

const FILE_MANAGER_LABEL =
  process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' || isWsl() ? 'Explorer' : 'Files';

/** Is `bin` (with a directly-spawnable Windows suffix under win32/WSL interop) on PATH?
 *  Returns the exact resolved name (which may carry the suffix) — pure filesystem probe, no
 *  child process — or null. `.cmd`/`.bat` are intentionally excluded: modern Node refuses to
 *  spawn them directly, while launching them through a shell would reintroduce the BatBadBut
 *  command-injection surface fixed in #459. An unavailable target is safer than one the menu
 *  offers and then silently fails to open (#469 review).
 *
 *  The optional environment arguments keep Windows/WSL suffix behavior testable on any host. */
export function resolveOnPath(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  wsl: boolean = isWsl(),
  searchPath: string = process.env.PATH ?? '',
): string | null {
  const dirs = searchPath.split(platform === 'win32' ? ';' : ':');
  const suffixed = platform === 'win32' || wsl;
  const names = suffixed ? [bin, `${bin}.com`, `${bin}.exe`] : [bin];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return name;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function onPath(bin: string): boolean {
  return resolveOnPath(bin) !== null;
}

/** macOS: is any of `names` (`<name>.app`) installed in a standard Applications dir? */
function macAppExists(names: string | string[]): boolean {
  if (process.platform !== 'darwin') return false;
  const candidates = Array.isArray(names) ? names : [names];
  return candidates.some((name) =>
    [
      `/Applications/${name}.app`,
      join(homedir(), 'Applications', `${name}.app`),
      `/System/Applications/${name}.app`,
    ].some((p) => existsSync(p)),
  );
}

function editorAvailable(editor: EditorDef): boolean {
  if (editor.cli && onPath(editor.cli)) return true;
  if (editor.mac && macAppExists(editor.mac)) return true;
  return false;
}

/** Coding-agent CLIs a session can be handed off to (#cli-handoff). Selecting one opens a
 *  terminal that resumes THIS run's session when the runner matches, or launches a fresh CLI in
 *  the worktree otherwise. The actual command is built server-side (needs the run's session). */
const AGENT_CLIS: Array<{ runner: RunnerId; label: string; icon: string; bin: string; envBin?: string }> = [
  { runner: 'claude', label: 'Claude CLI', icon: 'claude', bin: 'claude', envBin: process.env.CEZ_CLAUDE_BIN },
  { runner: 'codex', label: 'Codex CLI', icon: 'codex', bin: 'codex', envBin: process.env.CEZ_CODEX_BIN },
  { runner: 'opencode', label: 'OpenCode', icon: 'opencode', bin: 'opencode', envBin: process.env.CEZ_OPENCODE_BIN },
  { runner: 'pi', label: 'pi CLI', icon: 'pi', bin: 'pi', envBin: process.env.CEZ_PI_BIN },
];

/** The runner behind a `cli:<runner>` open target, or null when the id isn't a CLI handoff. */
export function agentCliRunner(targetId: string): RunnerId | null {
  const match = AGENT_CLIS.find((c) => `cli:${c.runner}` === targetId);
  return match ? match.runner : null;
}

/** The open targets available on this machine: the file manager, a terminal, every detected
 *  editor, and every installed coding-agent CLI. Order is stable so the menu never reshuffles. */
export function detectOpenTargets(): OpenTarget[] {
  const targets: OpenTarget[] = [
    { id: 'finder', label: FILE_MANAGER_LABEL, icon: 'folder' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  ];
  for (const editor of EDITORS) {
    if (editorAvailable(editor)) targets.push({ id: editor.id, label: editor.label, icon: editor.icon });
  }
  for (const cli of AGENT_CLIS) {
    if ((cli.envBin && existsSync(cli.envBin)) || onPath(cli.bin)) {
      targets.push({ id: `cli:${cli.runner}`, label: cli.label, icon: cli.icon });
    }
  }
  return targets;
}

/** The (bin, args) a file-manager launch resolves to — pure so the per-platform routing
 *  (including the WSL→Explorer interop branch) is unit-testable without spawning anything.
 *  `platform`/`wsl` default to the real environment; tests pass them explicitly. */
export function fileManagerLaunch(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  wsl: boolean = isWsl(),
): { bin: string; args: string[] } {
  if (platform === 'darwin') return { bin: 'open', args: [dir] };
  if (platform === 'win32') return { bin: 'explorer', args: [dir] };
  if (wsl) return { bin: 'explorer.exe', args: [translateToWindowsPath(dir)] };
  return { bin: 'xdg-open', args: [dir] };
}

/** Open `dir` in the file manager, natively per platform. Under WSL there is no Linux desktop to
 *  hand `xdg-open` to — go through interop to Windows Explorer instead, translating the path. */
async function openFileManager(dir: string): Promise<boolean> {
  const { bin, args } = fileManagerLaunch(dir);
  return runDetached(bin, args);
}

/** Open a single worktree FILE with whatever application the OS has registered as its
 *  default handler — the diff pane's "open in default app" action for images (#365). Distinct
 *  from `openFileManager` above: that opens a *directory* in the file manager; this launches
 *  the file itself (e.g. the OS's default image viewer), never a directory listing. Local-only
 *  by construction — the caller gates this behind `localHandoff`.
 *
 *  `path` is worktree CONTENT — a filename some cloned repo or coding agent chose — so it is
 *  hostile input, and it must never reach a process that re-parses its command line. That rules
 *  `cmd.exe` out on Windows: an argument array does NOT protect you there, because libuv quotes
 *  a spawn arg only when it contains a space/tab/quote and passes everything else verbatim, so
 *  `cmd /c start "" C:\dev\proj\a&calc&.png` would let cmd's `&` run `calc` (BatBadBut,
 *  CVE-2024-27980). `explorer <file>` hands the file to its registered handler with no such
 *  re-parsing — the same launcher `openFileManager` already uses for directories. */
export async function openFileInDefaultApp(path: string): Promise<boolean> {
  if (process.platform === 'darwin') return runDetached('open', [path]);
  if (process.platform === 'win32') return runDetached('explorer', [path]);
  return runDetached('xdg-open', [path]);
}

/** Open `dir` in the given target. Unknown/unavailable target → false (the caller 409s). */
export async function openInApp(targetId: string, dir: string): Promise<boolean> {
  if (targetId === 'finder') return openFileManager(dir);
  // A bare interactive shell at the worktree — `:` is a no-op so no command actually runs.
  if (targetId === 'terminal') return openInTerminal(dir, ':');

  const editor = EDITORS.find((e) => e.id === targetId);
  if (!editor) return false;
  if (editor.cli) {
    const resolved = resolveOnPath(editor.cli);
    if (resolved) return runDetached(resolved, [launchPathFor(resolved, dir)]);
  }
  if (editor.mac && macAppExists(editor.mac)) return runDetached('open', ['-a', pickInstalledMacApp(editor.mac), dir]);
  return false;
}

/** The path argument to hand a resolved binary: a Windows-suffixed name found through WSL
 *  interop needs the Windows-side path; a bare-name binary (native Linux, or a WSL-aware shim
 *  like VS Code's Remote-WSL `code`) takes the POSIX path unchanged. `wsl` defaults to the real
 *  environment; tests pass it explicitly so this needs no global platform stubbing. */
export function launchPathFor(resolvedBin: string, dir: string, wsl: boolean = isWsl()): string {
  if (wsl && /\.(com|exe)$/i.test(resolvedBin)) return translateToWindowsPath(dir);
  return dir;
}

/** Which of an editor's candidate .app names is actually installed — `macAppExists` already
 *  confirmed at least one is, this just picks it for the `open -a` argument. */
function pickInstalledMacApp(names: string | string[]): string {
  const candidates = Array.isArray(names) ? names : [names];
  return (
    candidates.find((name) =>
      [
        `/Applications/${name}.app`,
        join(homedir(), 'Applications', `${name}.app`),
        `/System/Applications/${name}.app`,
      ].some((p) => existsSync(p)),
    ) ?? candidates[0]!
  );
}

/** Spawn detached; success = no error within a short settle window (mirrors open-in-terminal). */
function runDetached(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    refuseSpawnUnderTest(bin, args);
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', detached: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once('error', () => settle(false));
    setTimeout(() => {
      child.unref();
      settle(true);
    }, 250);
  });
}
