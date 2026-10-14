import {
  accessSync,
  constants,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import {
  execFile,
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptions,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

/** A runnable FILE. On Windows, verifies file exists and is a regular file. */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * When OpenCode is installed on Windows via npm (`npm i -g opencode-ai`), npm generates
 * shims (`opencode.cmd`, `opencode.ps1`, and extensionless `opencode`) that wrap the native
 * executable at `node_modules/opencode-ai/bin/opencode.exe`.
 *
 * Spawning the native `.exe` directly avoids `cmd.exe` indirection and modern Node's
 * `spawn EINVAL` restriction on `.cmd` files (CVE-2024-27980).
 */
export function unwrapOpencodeShim(shimPath: string): string | null {
  try {
    const dir = dirname(shimPath);
    // 1. Direct npm package binary: <npm-prefix>/node_modules/opencode-ai/bin/opencode.exe
    const npmExe = join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (isExecutable(npmExe)) return npmExe;

    // 2. Sibling opencode.exe in the same directory
    const siblingExe = join(dir, 'opencode.exe');
    if (isExecutable(siblingExe)) return siblingExe;

    // 3. One level up node_modules: <dir>/../node_modules/opencode-ai/bin/opencode.exe
    const parentNpmExe = join(dir, '..', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (isExecutable(parentNpmExe)) return parentNpmExe;

    // 4. Batch script inspection: inspect "%dp0%\..." target
    const lower = shimPath.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const content = readFileSync(shimPath, 'utf8');
      const match = content.match(/"([^"]+\.exe)"/i);
      if (match && match[1]) {
        const resolved = match[1].replace(/%~?dp0%[\\/]?/i, `${dir}\\`);
        if (isExecutable(resolved)) return resolved;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Known locations where OpenCode installers place binaries or shims, most specific first.
 */
export function opencodeInstallCandidates(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  nodeBinDir: string = dirname(execPath),
  appData: string = process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
  localAppData: string = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
): string[] {
  if (platform === 'win32') {
    return [
      join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      join(nodeBinDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      join(appData, 'npm', 'opencode.cmd'),
      join(appData, 'npm', 'opencode.ps1'),
      join(nodeBinDir, 'opencode.cmd'),
      join(localAppData, 'Programs', 'opencode', 'opencode.exe'),
      join(home, '.opencode', 'bin', 'opencode.exe'),
      join(home, '.local', 'bin', 'opencode.exe'),
      join(home, '.local', 'bin', 'opencode.cmd'),
    ];
  }
  return [
    join(home, '.local', 'bin', 'opencode'),
    join(home, '.opencode', 'bin', 'opencode'),
    join(nodeBinDir, 'opencode'),
    join(home, '.npm-global', 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ];
}

/**
 * Find `opencode` on `searchPath`. On Windows, probes `.exe`, `.cmd`, `.bat`, `.ps1`, and bare name,
 * unwrapping shims to `.exe` when possible.
 */
export function findOpencodeOnPath(
  bin: string = 'opencode',
  searchPath: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!searchPath) return null;
  const sep = (platform === 'win32' || process.platform === 'win32' || searchPath.includes(';')) ? ';' : ':';
  const dirs = searchPath.split(sep).filter(Boolean);

  if (platform === 'win32') {
    const hasExt = /\.(exe|cmd|bat|ps1|com)$/i.test(bin);
    const extensions = hasExt ? [''] : ['.exe', '.cmd', '.bat', '.ps1', ''];

    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = join(dir, `${bin}${ext}`);
        if (isExecutable(candidate)) {
          if (candidate.toLowerCase().endsWith('.exe')) return candidate;
          const unwrapped = unwrapOpencodeShim(candidate);
          return unwrapped ?? candidate;
        }
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the OpenCode executable or shim:
 * 1. Honors explicit `bin` or `CEZ_OPENCODE_BIN` (unwrapping Windows shims to `.exe` if present).
 * 2. Probes PATH.
 * 3. Probes standard candidate directories.
 * 4. Falls back to `'opencode'`.
 */
export function resolveOpencodeBin(
  bin?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  searchPath: string = env.PATH ?? process.env.PATH ?? '',
  candidates?: string[],
): string {
  const explicit = bin?.trim() || env.CEZ_OPENCODE_BIN?.trim();
  if (explicit) {
    if (platform === 'win32') {
      const lower = explicit.toLowerCase();
      if (explicit.includes('/') || explicit.includes('\\') || isExecutable(explicit)) {
        if (lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1')) {
          const unwrapped = unwrapOpencodeShim(explicit);
          if (unwrapped) return unwrapped;
        }
        return explicit;
      }
      const onPath = findOpencodeOnPath(explicit, searchPath, platform);
      if (onPath) return onPath;
    }
    return explicit;
  }

  const onPathResult = findOpencodeOnPath('opencode', searchPath, platform);
  if (onPathResult) return onPathResult;

  const candidateList = candidates ?? opencodeInstallCandidates(
    homedir(),
    platform,
    dirname(execPath),
    env.APPDATA,
    env.LOCALAPPDATA,
  );
  for (const candidate of candidateList) {
    if (isExecutable(candidate)) {
      if (platform === 'win32') {
        const unwrapped = unwrapOpencodeShim(candidate);
        if (unwrapped) return unwrapped;
      }
      return candidate;
    }
  }

  return 'opencode';
}

/** Escape a single argument for safe inclusion in a `cmd.exe /c` command string. */
export function escapeCmdArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[ \t\n\v"&|<>^%]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface PreparedCommand {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Prepare `bin` and `args` for process spawning. On Windows:
 * - `.cmd` / `.bat` shims are wrapped via `cmd.exe /d /s /c` with safe quoting and `windowsVerbatimArguments: true`.
 * - `.ps1` shims are wrapped via `powershell.exe -File`.
 * - `.mjs` / `.js` fixtures (test mocks) are run via `node`.
 * - Native executables (`.exe`) and POSIX binaries are spawned directly without shell overhead.
 */
export function prepareOpencodeCommand(
  bin: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): PreparedCommand {
  if (platform === 'win32') {
    const lower = bin.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
      const quotedBin = `"${bin.replace(/"/g, '""')}"`;
      const fullCmd = [quotedBin, ...args.map(escapeCmdArg)].join(' ');
      return {
        file: comspec,
        args: ['/d', '/s', '/c', `"${fullCmd}"`],
        windowsVerbatimArguments: true,
      };
    }
    if (lower.endsWith('.ps1')) {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bin, ...args],
      };
    }
    if (lower.endsWith('.mjs') || lower.endsWith('.js')) {
      return {
        file: process.execPath,
        args: [bin, ...args],
      };
    }
  }
  return {
    file: bin,
    args: [...args],
  };
}

/** Spawn an OpenCode process handling platform-specific shims safely. */
export function spawnOpencodeProcess(
  bin: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
  platform: NodeJS.Platform = process.platform,
): ChildProcessWithoutNullStreams {
  const prepared = prepareOpencodeCommand(bin, args, platform);
  return nodeSpawn(prepared.file, prepared.args, {
    ...options,
    ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

/** Execute an OpenCode CLI command handling platform-specific shims safely. */
export function execOpencode(
  bin: string,
  args: readonly string[],
  options: ExecFileOptions = {},
  platform: NodeJS.Platform = process.platform,
): Promise<{ stdout: string; stderr: string }> {
  const prepared = prepareOpencodeCommand(bin, args, platform);
  return new Promise((resolve, reject) => {
    execFile(
      prepared.file,
      prepared.args,
      {
        ...options,
        windowsHide: true,
        ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });
}
