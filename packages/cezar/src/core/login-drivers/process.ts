import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAntigravityBin } from '../antigravity-runner.ts';
import { resolveClaudeBin } from '../claude-bin.ts';
import { resolveCursorAgentBin } from '../cursor-bin.ts';
import { resolveKimiExecutable } from '../kimi-runner.ts';
import type { ProviderId } from '../provider-auth.ts';
import { spawnableCommand } from '../windows-shim.ts';
import type { BrowserShim, DriverControl, LoginChild, LoginFetch, SpawnLogin } from './types.ts';

/** The same binaries `provider-auth.ts`'s descriptors resolve, so the login signs in what the probe reads. */
export function loginExecutable(provider: ProviderId): string {
  switch (provider) {
    case 'claude': return resolveClaudeBin();
    case 'codex': return process.env.CEZ_CODEX_BIN ?? 'codex';
    case 'opencode': return process.env.CEZ_OPENCODE_BIN ?? 'opencode';
    case 'cursor': return resolveCursorAgentBin();
    case 'pi': return process.env.CEZ_PI_BIN ?? 'pi';
    case 'junie': return process.env.CEZ_JUNIE_BIN ?? 'junie';
    case 'copilot': return process.env.CEZ_COPILOT_BIN ?? 'copilot';
    case 'omp': return process.env.CEZ_OMP_BIN ?? 'omp';
    case 'antigravity': return resolveAntigravityBin();
    case 'gemini': return process.env.CEZ_GEMINI_BIN ?? 'gemini';
    case 'kimi': return resolveKimiExecutable();
  }
}

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** The hosts each sign-in may send the user to; anything else falls back to the terminal. */
const VERIFICATION_HOSTS: Partial<Record<string, readonly string[]>> = {
  claude: ['claude.com', 'claude.ai', 'platform.claude.com'],
  codex: ['auth.openai.com'],
  cursor: ['cursor.com', 'www.cursor.com'],
  copilot: ['github.com'],
  // OpenCode's own auth providers, keyed `opencode:<id>`.
  'opencode:openai': ['auth.openai.com'],
  'opencode:github-copilot': ['github.com'],
  'opencode:anthropic': ['claude.ai', 'claude.com', 'console.anthropic.com'],
};

/** `url` when it is an https page on `key`'s allow-list, else undefined. */
export function allowedVerificationUrl(key: string, url: string): string | undefined {
  const hosts = VERIFICATION_HOSTS[key];
  if (!hosts) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    return hosts.includes(parsed.hostname.toLowerCase()) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Kill a detached child's whole group (POSIX) or tree (Windows). */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } catch {
      // already gone
    }
    return;
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const send = () => {
      try {
        process.kill(-pid, signal);
      } catch {
        // group already empty
      }
    };
    if (signal === 'SIGTERM') send();
    else setTimeout(send, 2_000).unref?.();
  }
}

/** Piped stdio, its own process group so cancel takes everything it started. */
export const spawnLoginProcess: SpawnLogin = (executable, args, { env }) => {
  const [file, argv] = spawnableCommand(executable, args);
  const outputs: Array<(text: string) => void> = [];
  const exits: Array<(code: number | null, error?: string) => void> = [];
  let exited = false;
  const finish = (code: number | null, error?: string) => {
    if (exited) return;
    exited = true;
    for (const listener of exits) listener(code, error);
  };
  const child = spawn(file, argv, {
    env,
    cwd: homedir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.on('error', (error: NodeJS.ErrnoException) => finish(null, error.code ?? 'ERROR'));
  child.on('close', (code) => finish(code));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      for (const listener of outputs) listener(chunk);
    });
  }
  child.stdin?.on('error', () => {});
  return {
    onOutput: (listener) => outputs.push(listener),
    onExit: (listener) => exits.push(listener),
    write: (text) => {
      child.stdin?.write(text);
    },
    closeStdin: () => {
      child.stdin?.end();
    },
    kill: () => {
      if (exited || child.pid === undefined) return;
      killTree(child.pid);
    },
  } satisfies LoginChild;
};

export const defaultLoginFetch: LoginFetch = async (url, init) => {
  const { timeoutMs, ...rest } = init ?? {};
  const response = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs ?? 20_000) });
  return { ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown> };
};

/**
 * A PATH shim for `open` and `xdg-open` that records the URL instead of opening it, so a local
 * sign-in's browser page opens from the card (spec checks table: Claude launches through `open`).
 * POSIX only; Windows opens through the shell, which no PATH entry intercepts.
 */
export async function createBrowserShim(): Promise<BrowserShim | null> {
  if (process.platform === 'win32') return null;
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), 'cez-login-'));
    const log = join(dir, 'urls');
    if (log.includes("'")) throw new Error('unquotable');
    const script = `#!/bin/sh\nfor a in "$@"; do case "$a" in https://*) printf '%s\\n' "$a" >> '${log}';; esac; done\nexit 0\n`;
    for (const name of ['open', 'xdg-open']) {
      await writeFile(join(dir, name), script, { mode: 0o700 });
      await chmod(join(dir, name), 0o700);
    }
  } catch {
    return null;
  }
  const log = join(dir, 'urls');
  return {
    dir,
    urls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    dispose: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const OUTPUT_CAP = 64 * 1024;

/**
 * Spawn the vendor CLI and map its exit: 0 is success (the manager verifies), a missing binary is
 * `not-installed`, anything else `exited`. `onText` sees the ANSI-stripped output so far; the
 * output is never stored on the session or logged.
 */
export function runLoginCli(
  ctl: DriverControl,
  args: readonly string[],
  options: {
    extraEnv?: Record<string, string>;
    onText?: (text: string) => void;
    /** Return true when it handled a clean (non-spawn-error) exit itself. */
    onExit?: (code: number | null) => boolean;
  } = {},
): LoginChild | null {
  let child: LoginChild;
  try {
    child = ctl.spawn(ctl.executable, args, { env: { ...ctl.env, ...options.extraEnv } });
  } catch (error) {
    ctl.fail((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'not-installed' : 'unavailable');
    return null;
  }
  let text = '';
  child.onOutput((chunk) => {
    if (text.length < OUTPUT_CAP) text += stripAnsi(chunk);
    options.onText?.(text);
  });
  child.onExit((code, error) => {
    if (ctl.done()) return;
    if (error === 'ENOENT') ctl.fail('not-installed');
    else if (error) ctl.fail('unavailable');
    else if (options.onExit?.(code)) return;
    else if (code === 0) ctl.succeed();
    else ctl.fail('exited');
  });
  return child;
}

/** First complete (whitespace-terminated) https URL in `text` matching `pattern`, if any. */
export function findUrl(text: string, pattern: RegExp): string | undefined {
  for (const match of text.matchAll(/https:\/\/[^\s"'<>]+(?=\s)/g)) {
    if (pattern.test(match[0])) return match[0].replace(/[).,;]+$/, '');
  }
  return undefined;
}

/** A one-time device code in `XXXX-XXXX` / `XXXX-XXXXX` form. */
export function findDeviceCode(text: string): string | undefined {
  return text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/)?.[1];
}
