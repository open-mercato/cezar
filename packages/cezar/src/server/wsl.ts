import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * WSL (Windows Subsystem for Linux) support for "Open in…" (#361): when cezar's server runs
 * inside a WSL distro, its own `process.platform` reads `linux` — worktree paths are POSIX
 * (`/home/…`) even though the user's editors, file explorer and terminal emulator mostly live on
 * the Windows side, reachable through WSL interop (binfmt_misc lets a WSL process exec a `.exe`
 * directly). Two things are needed to hand a worktree off correctly:
 *  1. detect that we ARE inside WSL (`isWsl`), so the terminal/file-manager branches in
 *     open-in-terminal.ts / open-in-app.ts know to go through interop instead of xdg-open;
 *  2. translate the POSIX path to the `\\wsl$\<Distro>\…` (or `C:\…` for a `/mnt/<drive>` path)
 *     form a Windows-side executable actually understands (`translateToWindowsPath`).
 *
 * Every helper here takes its inputs as optional parameters (defaulting to the real
 * env/platform/`/proc/version`) so the detection and translation logic is unit-testable from any
 * host OS, without needing to actually run inside WSL or stub globals.
 */

/** Best-effort read of `/proc/version`; empty string when unavailable (non-Linux, sandboxed,
 *  permission-denied, etc) — absence just means "not WSL", never a crash. */
function safeProcVersion(): string {
  try {
    return readFileSync('/proc/version', 'utf8');
  } catch {
    return '';
  }
}

/** True when this process is running inside WSL. The Linux kernel WSL ships identifies itself
 *  in `/proc/version` (contains "microsoft"); WSL also sets `WSL_DISTRO_NAME`/`WSL_INTEROP` for
 *  every process it starts, which is cheaper to check first. */
export function isWsl(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  procVersion: string = safeProcVersion(),
): boolean {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return /microsoft/i.test(procVersion);
}

/** Distro names are user-chosen (`wsl --import <name> …`), so `WSL_DISTRO_NAME` is untrusted
 *  input that we go on to put on a command line and into a UNC path. WSL's own naming rules are
 *  narrower than this, so nothing legitimate is rejected — but a name like `a&calc&` is. */
const SAFE_DISTRO_NAME = /^[A-Za-z0-9._-]+$/;

/** The distro name Windows-side tools address this environment as (`wsl.exe -d <name>`, the
 *  `\\wsl$\<name>\…` UNC prefix). Falls back to "Ubuntu" — WSL's own default — when unset or
 *  when the name fails `SAFE_DISTRO_NAME`, so no unvalidated env value is ever interpolated into
 *  a command line or a path. The launchers this feeds are shell-free anyway
 *  (`wslTerminalLaunchers`); this is the belt to their braces. */
export function wslDistroName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.WSL_DISTRO_NAME;
  return name && SAFE_DISTRO_NAME.test(name) ? name : 'Ubuntu';
}

/** Pure POSIX → Windows path translation, no `wslpath` required (used as its fallback, and
 *  directly in tests). Two cases:
 *   - `/mnt/<drive>/…` (the Windows filesystem mounted into WSL) → `<DRIVE>:\…`, the native path,
 *     not a UNC round-trip through the distro.
 *   - anything else (the Linux filesystem proper) → `\\wsl$\<Distro>\…`, the UNC path Windows
 *     apps use to reach into the distro. */
export function toWindowsPath(posixPath: string, distro: string = wslDistroName()): string {
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(posixPath);
  if (mnt) {
    const drive = mnt[1]!.toUpperCase();
    const rest = (mnt[2] ?? '').split('/').filter(Boolean).join('\\');
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }
  const trimmed = posixPath.replace(/^\/+/, '');
  const backslashed = trimmed.split('/').filter(Boolean).join('\\');
  return backslashed ? `\\\\wsl$\\${distro}\\${backslashed}` : `\\\\wsl$\\${distro}`;
}

/** The reverse of the UNC case above: `\\wsl$\<Distro>\…` or `\\wsl.localhost\<Distro>\…` →
 *  the POSIX path WSL-side tools expect. Anything else (a plain `C:\…`, an unrecognized UNC
 *  share) passes through unchanged — it isn't a WSL path to begin with. */
export function toPosixPath(windowsPath: string): string {
  const match = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(\\.*)?$/i.exec(windowsPath);
  if (!match) return windowsPath;
  const rest = match[1] ?? '';
  return `/${rest.replace(/^\\+/, '').split('\\').join('/')}`;
}

/** The translation actually used at launch time: prefer the real `wslpath -w` (it knows about
 *  every mount, not just `/mnt/<drive>`), falling back to the pure `toWindowsPath` above when
 *  `wslpath` is missing or errors — degrade, never throw. */
export function translateToWindowsPath(posixPath: string): string {
  try {
    const out = execFileSync('wslpath', ['-w', posixPath], { encoding: 'utf8', timeout: 2000 }).trim();
    if (out) return out;
  } catch {
    // wslpath not on PATH (shouldn't happen inside real WSL, but never trust it) — fall through.
  }
  return toWindowsPath(posixPath);
}
