import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cezarHomeDir } from '../paths.ts';

/** Tool provisioning runtime: the injectable seams (exec, fetch, platform) every recipe works through. */

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin then closed — how license prompts are answered without a `yes |` shell pipe. */
  input?: string;
  timeoutMs?: number;
  /** Called with each chunk of stdout/stderr as it arrives (progress for long installs). */
  onOutput?: (chunk: string) => void;
}
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ToolsContext {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** `cezarHomeDir()/tools` — the only place cezar writes provisioned tools. */
  toolsDir: string;
  /** `CEZ_TOOL_INSTALL`: may we touch the network and disk to install? */
  install: boolean;
  /** Never rejects: a spawn failure is `code: -1` with the reason in `stderr`. */
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
  /** Start a long-lived process (the emulator) that outlives this CLI; output goes to `logFile`. */
  spawnDetached: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; logFile: string }) => { exitCode: () => number | null };
  fetch: typeof fetch;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export type ToolId = 'jdk' | 'android-sdk' | 'android-emulator' | 'ios-simulator' | 'flutter';

export interface ToolStatus {
  installed: boolean;
  version?: string;
  path?: string;
  /** `cezar` = under `toolsDir`; `system` = found on the machine already. */
  source?: 'system' | 'cezar';
  note?: string;
}

/** What a tool contributes to a process environment. PATH entries come first, in order. */
export interface ToolEnv {
  path: string[];
  vars: Record<string, string>;
}

export interface ToolRecipe {
  id: ToolId;
  title: string;
  requires: ToolId[];
  /** Why this tool cannot work here at all (wrong OS/arch), or undefined. */
  unsupported(ctx: ToolsContext): string | undefined;
  detect(ctx: ToolsContext): Promise<ToolStatus>;
  /** Called with the lock held and only when installs are enabled. `env` already carries earlier installs. */
  install(ctx: ToolsContext, env: NodeJS.ProcessEnv): Promise<void>;
  /** Sync and stat-only: it runs at every agent launch. `managedOnly` ignores tools cezar did not install. */
  env(ctx: ToolsContext, managedOnly?: boolean): ToolEnv;
  /** How to get the tool by hand, shown when installs are off or impossible. */
  hint(ctx: ToolsContext): string;
}

export function isOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isOff(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/**
 * Are installs allowed? The operator's `CEZ_TOOL_INSTALL` wins both ways (`0` forces off, `1`
 * forces on); with it unset, the Settings switch (`toolsAutoInstall` in `~/.cezar/config.json`)
 * decides; default off.
 */
export function resolveInstallEnabled(env: NodeJS.ProcessEnv, stored: boolean | undefined): boolean {
  if (isOff(env.CEZ_TOOL_INSTALL)) return false;
  if (isOn(env.CEZ_TOOL_INSTALL)) return true;
  return stored === true;
}

/** The Settings switch as the cockpit last read it (boot and every config save); undefined until then. */
let storedInstall: boolean | undefined;
export function setStoredToolsInstall(value: boolean | undefined): void {
  storedInstall = value;
}
export function toolsInstallEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveInstallEnabled(env, storedInstall);
}

/** Env names are case-insensitive on Windows (`Path`), so look the key up that way everywhere. */
export function envKey(env: NodeJS.ProcessEnv, name: string): string {
  const upper = name.toUpperCase();
  return Object.keys(env).find((k) => k.toUpperCase() === upper) ?? name;
}

export function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

export function exeName(ctx: ToolsContext, name: string): string {
  return ctx.platform === 'win32' ? `${name}.exe` : name;
}
export function batName(ctx: ToolsContext, name: string): string {
  return ctx.platform === 'win32' ? `${name}.bat` : name;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve `name` on `ctx.env`'s PATH without executing anything (honours PATHEXT on Windows). */
export function findOnPath(ctx: ToolsContext, name: string): string | undefined {
  const dirs = (ctx.env[envKey(ctx.env, 'PATH')] ?? '').split(pathDelimiter(ctx.platform)).filter(Boolean);
  // Windows never runs an extensionless file (Flutter ships a bash `flutter` beside `flutter.bat`).
  const exts = ctx.platform === 'win32' ? (ctx.env[envKey(ctx.env, 'PATHEXT')] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `;` `,` `=` are batch-file argument delimiters: `platforms;android-36` reaches a `.bat` as two words unless quoted. */
export function quoteForCmd(arg: string): string {
  return /[\s"&|<>^%();,=]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** Node (>= 20.12) refuses to spawn `.bat`/`.cmd` directly on Windows, so those go through cmd.exe. */
function spawnTarget(command: string, args: string[], platform: NodeJS.Platform): { file: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(command)) {
    const line = [command, ...args].map(quoteForCmd).join(' ');
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { file: command, args, verbatim: false };
}

export function realExec(platform: NodeJS.Platform): ToolsContext['exec'] {
  return (command, args, options = {}) =>
    new Promise((resolve) => {
      const target = spawnTarget(command, args, platform);
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = (result: ExecResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      try {
        const child = spawn(target.file, target.args, {
          cwd: options.cwd,
          env: options.env,
          windowsVerbatimArguments: target.verbatim,
          windowsHide: true,
        });
        if (options.timeoutMs) {
          timer = setTimeout(() => {
            child.kill();
            done({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${Math.round(options.timeoutMs! / 1000)}s` });
          }, options.timeoutMs);
        }
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          options.onOutput?.(chunk.toString('utf8'));
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          options.onOutput?.(chunk.toString('utf8'));
        });
        child.on('error', (error) => done({ code: -1, stdout, stderr: error.message }));
        child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
        // A tool that exits before reading its prompts closes stdin on us: EPIPE is not a failure.
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.input ?? '');
      } catch (error) {
        done({ code: -1, stdout, stderr: error instanceof Error ? error.message : String(error) });
      }
    });
}

export function defaultContext(env: NodeJS.ProcessEnv = process.env): ToolsContext {
  const platform = process.platform;
  return {
    platform,
    arch: process.arch,
    env,
    home: homedir(),
    toolsDir: join(cezarHomeDir(env), 'tools'),
    install: resolveInstallEnabled(env, storedInstall),
    exec: realExec(platform),
    spawnDetached(command, args, options) {
      mkdirSync(dirname(options.logFile), { recursive: true });
      const log = openSync(options.logFile, 'a');
      const target = spawnTarget(command, args, platform);
      const child = spawn(target.file, target.args, {
        env: options.env,
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
        windowsVerbatimArguments: target.verbatim,
      });
      let exitCode: number | null = null;
      // A spawn failure or an immediate exit (no hypervisor) must be visible to the caller's wait loop.
      child.on('error', () => (exitCode = -1));
      child.on('exit', (code) => (exitCode = code ?? -1));
      child.unref();
      return { exitCode: () => exitCode };
    },
    fetch,
    log: (line) => console.error(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Stream a URL to `dest`, verifying the checksum (sha256, or sha1 where a manifest only has that) when given. */
export async function downloadFile(ctx: ToolsContext, url: string, dest: string, checksum?: string, algo: 'sha256' | 'sha1' = 'sha256'): Promise<void> {
  ctx.log(`downloading ${url}`);
  const response = await ctx.fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${url}`);
  const hash = createHash(algo);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(dest),
  );
  if (checksum && hash.digest('hex') !== checksum.toLowerCase()) {
    await rm(dest, { force: true });
    throw new Error(`checksum mismatch for ${url}`);
  }
}

/**
 * Extract with what the OS already ships — no new dependency:
 *  - `.tar.gz` / `.tar.xz`: `tar` everywhere;
 *  - `.zip`: Windows' System32 `tar.exe` (bsdtar; Git Bash's GNU tar cannot read zips) with
 *    PowerShell `Expand-Archive` as the fallback, macOS `tar` (bsdtar), Linux `unzip`.
 */
export async function extractArchive(ctx: ToolsContext, archive: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const isZip = archive.endsWith('.zip');
  const attempts: Array<[string, string[]]> = [];
  if (!isZip) {
    attempts.push(['tar', [archive.endsWith('.xz') ? '-xJf' : '-xzf', archive, '-C', destDir]]);
  } else if (ctx.platform === 'win32') {
    const system32 = join(ctx.env.SystemRoot ?? 'C:\\Windows', 'System32');
    attempts.push([join(system32, 'tar.exe'), ['-xf', archive, '-C', destDir]]);
    attempts.push([
      join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`],
    ]);
  } else if (ctx.platform === 'darwin') {
    attempts.push(['tar', ['-xf', archive, '-C', destDir]]);
  } else {
    attempts.push(['unzip', ['-q', '-o', archive, '-d', destDir]]);
  }
  let last = '';
  for (const [command, args] of attempts) {
    const result = await ctx.exec(command, args, { timeoutMs: 20 * 60_000 });
    if (result.code === 0) return;
    last = `${command}: ${(result.stderr || result.stdout).trim()}`;
  }
  throw new Error(`could not extract ${archive} (${last}${isZip && ctx.platform === 'linux' ? '; install "unzip"' : ''})`);
}

/** The single top-level directory an archive unpacks to (`jdk-17.0.9+9/`, `flutter/`, `cmdline-tools/`). */
export function singleRoot(dir: string): string {
  const entries = readdirSync(dir).filter((name) => isDir(join(dir, name)));
  if (entries.length !== 1) throw new Error(`unexpected archive layout in ${dir}: ${entries.join(', ') || 'empty'}`);
  return join(dir, entries[0]!);
}

/**
 * Run `work` in a fresh staging directory under `toolsDir` and always remove it, so an
 * interrupted install leaves nothing a later `detect` could mistake for a working tool. Staging
 * lives beside the final location because `rename` must not cross filesystems.
 */
export async function withStaging<T>(ctx: ToolsContext, id: string, work: (staging: string) => Promise<T>): Promise<T> {
  const staging = join(ctx.toolsDir, `.staging-${id}-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    return await work(staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove `.staging-<id>-<pid>` dirs whose process is gone (a killed install). Call under the tool's lock. */
export async function sweepStaging(ctx: ToolsContext, id: string): Promise<void> {
  const prefix = `.staging-${id}-`;
  for (const name of await readdir(ctx.toolsDir).catch(() => [] as string[])) {
    const pid = name.startsWith(prefix) ? Number(name.slice(prefix.length)) : NaN;
    if (Number.isSafeInteger(pid) && pid !== process.pid && !pidAlive(pid)) await rm(join(ctx.toolsDir, name), { recursive: true, force: true });
  }
}

/** Replace `final` with `staged` by rename. */
export async function moveInto(staged: string, final: string): Promise<void> {
  await mkdir(dirname(final), { recursive: true });
  await rm(final, { recursive: true, force: true });
  await rename(staged, final);
}

/** Pull the first `x.y.z`-looking token out of a tool's version banner. */
export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+(?:\.\d+)*(?:[-+][\w.]+)?)/.exec(text)?.[1];
}
