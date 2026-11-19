/**
 * Installing one version into the managed layout. npm does the heavy lifting — download,
 * integrity check, dependency resolution — through `npm install --prefix <dir> <spec>`, which is
 * what `npx` does too, only into a directory cezar owns. Two sources:
 *
 *   registry  `<spec>` = `@open-mercato/cezar@<version>`
 *   local     `<spec>` = a tarball from `npm pack` of the running package (a checkout or the npx
 *             cache) — how a PoC build, or an npx user pressing "install permanently", lands in
 *             `~/.cezar/versions` without a publish.
 *
 * The install goes into a staging dir and is renamed into place only after the entry file
 * exists, so a killed install never leaves a half version `listInstalled` could offer.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { cezarHomeDir } from '../paths.ts';
import { assertSafeId, installId, PACKAGE_NAME, versionDir, versionEntry, versionsDir, writeManifest } from './layout.ts';
import { acquireVersionsLock } from './versions-prune.ts';

const packageJsonSchema = z.object({ name: z.string(), version: z.string().min(1) }).passthrough();

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export interface InstallOptions {
  onLog?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** The npm runner; tests substitute one that touches no network. */
  runNpm?: typeof runNpm;
  /** Waits between registry retries; tests substitute one that does not. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long to wait before each retry of a registry install npm cannot see yet. A nightly is
 * offered as soon as the full packument lists it, while npm reads the abbreviated one — a
 * separately cached CDN object (plus npm's own cache) that can lag a fresh publish by minutes.
 */
export const REGISTRY_RETRY_DELAYS_MS: readonly number[] = [10_000, 20_000, 40_000, 60_000];

export interface InstallResult {
  id: string;
  version: string;
  entry: string;
}

/** Install `version` from the npm registry. Returns the existing install untouched when present. */
export async function installFromRegistry(version: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const env = opts.env ?? process.env;
  const id = installId(version, 'registry');
  if (existsSync(versionEntry(id, env))) {
    opts.onLog?.(`${id} is already installed`);
    return { id, version, entry: versionEntry(id, env) };
  }
  await installSpec(id, `${PACKAGE_NAME}@${version}`, { version, source: 'registry' }, opts, REGISTRY_RETRY_DELAYS_MS);
  return { id, version, entry: versionEntry(id, env) };
}

/** Pack the package at `packageRoot` (must be built) and install the tarball as `<version>+local`. */
export async function installFromLocal(packageRoot: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const env = opts.env ?? process.env;
  // The package.json is read back off disk, so it goes through a schema like every other
  // persisted file cezar parses — a malformed one is "not a built package", never a crash.
  const pkg = packageJsonSchema.safeParse(readJson(join(packageRoot, 'package.json')));
  if (!pkg.success || pkg.data.name !== PACKAGE_NAME) throw new Error(`${packageRoot} is not a built ${PACKAGE_NAME} package`);
  const version = pkg.data.version;
  const id = installId(version, 'local');
  const packDir = join(tmpdir(), `cezar-pack-${process.pid}-${Date.now()}`);
  mkdirSync(packDir, { recursive: true });
  try {
    opts.onLog?.(`packing ${packageRoot}`);
    await (opts.runNpm ?? runNpm)(['pack', '--pack-destination', packDir, '--silent'], packageRoot, opts.onLog);
    const tarball = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack produced no tarball');
    // A local reinstall replaces the previous local build of the same version — it is the
    // point of the exercise when iterating on a checkout.
    rmSync(versionDir(id, env), { recursive: true, force: true });
    await installSpec(id, join(packDir, tarball), { version, source: 'local' }, opts, []);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
  return { id, version, entry: versionEntry(id, env) };
}

async function installSpec(
  id: string,
  spec: string,
  manifest: { version: string; source: 'registry' | 'local' },
  opts: InstallOptions,
  retryDelaysMs: readonly number[],
): Promise<void> {
  const env = opts.env ?? process.env;
  const npm = opts.runNpm ?? runNpm;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Both callers validate before they get here, but the staging path is built from `id` and
  // recursively removed — make that invariant structural rather than a property of call order.
  const staging = join(versionsDir(env), `.staging-${assertSafeId(id)}-${process.pid}`);
  const freshStaging = () => {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
  };
  freshStaging();
  try {
    opts.onLog?.(`npm install --prefix ${staging} ${spec}`);
    const args = ['install', '--prefix', staging, '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=notice'];
    const extra: string[] = [];
    let retries = 0;
    for (;;) {
      const output: string[] = [];
      try {
        await npm([...args, ...extra, spec], staging, (line) => {
          output.push(line);
          opts.onLog?.(line);
        });
        break;
      } catch (error) {
        // A root-owned ~/.npm (an old `sudo npm`) must not block the install (telemetry 7a3f659a).
        if (!extra.includes('--cache') && npmCacheUnwritable(output)) {
          const cache = npmFallbackCache(env);
          opts.onLog?.(`npm's cache is not writable; retrying with ${cache}`);
          extra.push('--cache', cache);
          freshStaging();
          continue;
        }
        if (!npmVersionNotFound(output)) throw error;
        const delay = retryDelaysMs[retries];
        if (delay === undefined) {
          if (retryDelaysMs.length === 0) throw error;
          throw new Error(
            `${spec} is not visible on npm's registry yet. A version published minutes ago can take a while to reach every registry mirror — try again in a few minutes.`,
          );
        }
        retries += 1;
        opts.onLog?.(`${spec} is not visible on the registry yet (a fresh publish can lag); retry ${retries} of ${retryDelaysMs.length} in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        // Revalidate every cached packument instead of trusting npm's copy from before the publish.
        if (!extra.includes('--prefer-online')) extra.push('--prefer-online');
        freshStaging();
      }
    }
    const entry = join(staging, 'node_modules', ...PACKAGE_NAME.split('/'), 'dist', 'index.js');
    if (!existsSync(entry)) throw new Error('install finished but the entry file is missing');
    // The commit runs under the prune's lock, so a prune never trashes the id mid-swap. A lock
    // still held after the wait is not worth failing an update over.
    const release = await acquireVersionsLock({ env, waitMs: 30_000 });
    if (!release) opts.onLog?.('versions/.lock is still held — installing anyway');
    try {
      // A stale complete install of the same id (registry re-install after a manual delete of
      // the manifest, say) is replaced wholesale.
      rmSync(versionDir(id, env), { recursive: true, force: true });
      renameSync(staging, versionDir(id, env));
      writeManifest(id, { ...manifest, installedAt: new Date().toISOString() }, env);
    } finally {
      release?.();
    }
    opts.onLog?.(`installed ${id}`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** The value of npm's `npm error <field> <value>` line (`npm ERR!` before npm 10). */
function npmErrorField(output: readonly string[], field: string): string | undefined {
  for (const line of output) {
    const match = /^npm (?:error|ERR!) (\S+) (.+)$/.exec(line.trim());
    if (match?.[1] === field) return match[2]?.trim();
  }
  return undefined;
}

/**
 * npm could not find the requested version (`ETARGET`) or package (`E404`) — what a registry that
 * has not caught up with a fresh publish answers.
 */
export function npmVersionNotFound(output: readonly string[]): boolean {
  const code = npmErrorField(output, 'code');
  return code === 'ETARGET' || code === 'E404';
}

/**
 * npm failed because it may not write its cache folder (root-owned files left by `sudo npm`),
 * not because of the package. Mirrors the desktop shell's `npm_cache_unwritable`.
 */
export function npmCacheUnwritable(output: readonly string[]): boolean {
  const code = npmErrorField(output, 'code');
  if (code !== 'EACCES' && code !== 'EPERM') return false;
  const path = npmErrorField(output, 'path') ?? '';
  return ['_cacache', '_logs', '_npx'].some((dir) => path.includes(dir)) || output.some((line) => line.includes('cache folder contains root-owned files'));
}

/** A cache folder cezar owns, for when npm's own is not writable. */
export function npmFallbackCache(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'npm-cache');
}

/**
 * Run npm the way the repo's scripts do: through `npm_execpath` under the current node when we
 * were started by npm, else the `npm` on PATH (`npm.cmd` via a shell on Windows). Output is
 * streamed line by line to `onLog` so the cockpit can show progress.
 */
export function runNpm(args: string[], cwd: string, onLog?: (line: string) => void): Promise<void> {
  const npmExecpath = process.env.npm_execpath;
  const viaNode = npmExecpath !== undefined && npmExecpath !== '';
  const file = viaNode ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const full = npmExecpath ? [npmExecpath, ...args] : args;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, full, {
      cwd,
      shell: !viaNode && process.platform === 'win32',
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const feed = (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          // npm's last line points at its debug log; the line before it names the problem.
          if (!/A complete log of this run can be found in/.test(trimmed)) tail = trimmed;
          onLog?.(trimmed);
        }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`npm ${args[0]} failed (exit ${code})${tail ? `: ${tail}` : ''}`));
    });
  });
}
