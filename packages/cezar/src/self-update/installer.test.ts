import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFromRegistry, type InstallOptions, npmCacheUnwritable, npmFallbackCache, npmVersionNotFound, REGISTRY_RETRY_DELAYS_MS } from './installer.ts';
import { ensurePathHook } from './launcher.ts';
import { listInstalled, readManifest, versionDir, versionEntry, versionsDir } from './layout.ts';
import { SelfUpdateService } from './service.ts';

/**
 * The install path is the one that changes the user's machine, so its promises are pinned with
 * an npm that touches no network: a stub that does what `npm install --prefix` would have done
 * to the staging directory — or fails half way.
 */
describe('installing into the managed layout', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-installer-'));
    env = { ...process.env, CEZ_HOME: home, HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** What a successful `npm install --prefix <staging>` leaves behind. */
  const npmThatInstalls = (marker = 'v1'): NonNullable<InstallOptions['runNpm']> => async (args) => {
    const staging = args[args.indexOf('--prefix') + 1] ?? '';
    const dist = join(staging, 'node_modules', '@open-mercato', 'cezar', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), `// ${marker}\n`);
  };
  const staged = () => (existsSync(versionsDir(env)) ? readdirSync(versionsDir(env)).filter((name) => name.startsWith('.staging-')) : []);

  it('moves a finished install into place, writes its manifest and leaves no staging behind', async () => {
    const seen: string[][] = [];
    const result = await installFromRegistry('0.12.1', {
      env,
      runNpm: async (args, cwd, onLog) => {
        seen.push(args);
        // While npm runs, the version is NOT there yet — only the staging directory is.
        expect(existsSync(versionDir('0.12.1', env))).toBe(false);
        expect(staged()).toHaveLength(1);
        await npmThatInstalls()(args, cwd, onLog);
      },
    });
    expect(result).toEqual({ id: '0.12.1', version: '0.12.1', entry: versionEntry('0.12.1', env) });
    expect(seen[0]?.at(-1)).toBe('@open-mercato/cezar@0.12.1');
    expect(existsSync(versionEntry('0.12.1', env))).toBe(true);
    expect(readManifest('0.12.1', env)).toMatchObject({ version: '0.12.1', source: 'registry' });
    expect(staged()).toEqual([]);
    expect(listInstalled(env).map((entry) => entry.id)).toEqual(['0.12.1']);
  });

  it('leaves nothing behind when npm fails', async () => {
    await expect(
      installFromRegistry('0.12.1', {
        env,
        runNpm: async () => {
          throw new Error('npm install failed (exit 1): ETARGET');
        },
      }),
    ).rejects.toThrow('ETARGET');
    expect(staged()).toEqual([]);
    expect(existsSync(versionDir('0.12.1', env))).toBe(false);
    expect(listInstalled(env)).toEqual([]);
  });

  // telemetry 7a3f659a: a root-owned ~/.npm failed every install.
  const rootOwnedCache = [
    'npm error code EACCES',
    'npm error syscall mkdir',
    'npm error path /Users/ann/.npm/_cacache/index-v5/57/89',
    'npm error Your cache folder contains root-owned files, due to a bug in previous versions of npm which has since been addressed.',
  ];

  it('retries with a cache cezar owns when npm cannot write its own', async () => {
    const seen: string[][] = [];
    await installFromRegistry('0.12.1', {
      env,
      runNpm: async (args, cwd, onLog) => {
        seen.push(args);
        if (!args.includes('--cache')) {
          rootOwnedCache.forEach((line) => onLog?.(line));
          throw new Error('npm install failed (exit 1)');
        }
        await npmThatInstalls()(args, cwd, onLog);
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.[seen[1].indexOf('--cache') + 1]).toBe(npmFallbackCache(env));
    expect(seen[1]?.at(-1)).toBe('@open-mercato/cezar@0.12.1');
    expect(existsSync(versionEntry('0.12.1', env))).toBe(true);
    expect(staged()).toEqual([]);
  });

  it('does not retry an npm failure that is neither its cache nor a missing version', async () => {
    let runs = 0;
    await expect(
      installFromRegistry('0.12.1', {
        env,
        sleep: async () => {},
        runNpm: async (_args, _cwd, onLog) => {
          runs += 1;
          onLog?.('npm error code ERESOLVE');
          throw new Error('npm install failed (exit 1): ERESOLVE');
        },
      }),
    ).rejects.toThrow('ERESOLVE');
    expect(runs).toBe(1);
  });

  // A nightly the cockpit already offers can still be missing from npm's view of the registry.
  const notYetVisible = [
    'npm error code ETARGET',
    'npm error notarget No matching version found for @open-mercato/cezar@0.21.0-nightly.20261116.115.',
  ];

  it('retries a version npm cannot see yet, with backoff and a revalidated packument', async () => {
    const seen: string[][] = [];
    const waits: number[] = [];
    const log: string[] = [];
    await installFromRegistry('0.12.1', {
      env,
      onLog: (line) => log.push(line),
      sleep: async (ms) => {
        waits.push(ms);
      },
      runNpm: async (args, cwd, onLog) => {
        seen.push(args);
        // Each attempt starts from an empty staging directory.
        expect(readdirSync(cwd)).toEqual([]);
        if (seen.length < 3) {
          notYetVisible.forEach((line) => onLog?.(line));
          throw new Error('npm install failed (exit 1)');
        }
        await npmThatInstalls()(args, cwd, onLog);
      },
    });
    expect(seen).toHaveLength(3);
    expect(waits).toEqual(REGISTRY_RETRY_DELAYS_MS.slice(0, 2));
    expect(seen[0]).not.toContain('--prefer-online');
    expect(seen[1]).toContain('--prefer-online');
    expect(seen[2]?.filter((arg) => arg === '--prefer-online')).toHaveLength(1);
    expect(seen[2]?.at(-1)).toBe('@open-mercato/cezar@0.12.1');
    expect(log.some((line) => line.includes(`retry 1 of ${REGISTRY_RETRY_DELAYS_MS.length}`))).toBe(true);
    expect(existsSync(versionEntry('0.12.1', env))).toBe(true);
    expect(staged()).toEqual([]);
  });

  it('gives up after a bounded number of retries with a message that says what to do', async () => {
    let runs = 0;
    const waits: number[] = [];
    await expect(
      installFromRegistry('0.12.1', {
        env,
        sleep: async (ms) => {
          waits.push(ms);
        },
        runNpm: async (_args, _cwd, onLog) => {
          runs += 1;
          notYetVisible.forEach((line) => onLog?.(line));
          throw new Error('npm install failed (exit 1)');
        },
      }),
    ).rejects.toThrow(/@open-mercato\/cezar@0\.12\.1 is not visible on npm's registry yet.*try again in a few minutes/);
    expect(runs).toBe(REGISTRY_RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual([...REGISTRY_RETRY_DELAYS_MS]);
    expect(staged()).toEqual([]);
    expect(existsSync(versionDir('0.12.1', env))).toBe(false);
  });

  it('falls back to its own cache and still retries a version npm cannot see yet', async () => {
    const seen: string[][] = [];
    await installFromRegistry('0.12.1', {
      env,
      sleep: async () => {},
      runNpm: async (args, cwd, onLog) => {
        seen.push(args);
        if (seen.length === 1) {
          rootOwnedCache.forEach((line) => onLog?.(line));
          throw new Error('npm install failed (exit 1)');
        }
        if (seen.length === 2) {
          notYetVisible.forEach((line) => onLog?.(line));
          throw new Error('npm install failed (exit 1)');
        }
        await npmThatInstalls()(args, cwd, onLog);
      },
    });
    expect(seen).toHaveLength(3);
    expect(seen[2]).toContain('--cache');
    expect(seen[2]).toContain('--prefer-online');
    expect(existsSync(versionEntry('0.12.1', env))).toBe(true);
  });

  it('recognizes only missing-version failures as not yet visible', () => {
    expect(npmVersionNotFound(notYetVisible)).toBe(true);
    expect(npmVersionNotFound(['npm ERR! code E404', 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/@open-mercato%2fcezar'])).toBe(true);
    expect(npmVersionNotFound([])).toBe(false);
    expect(npmVersionNotFound(['npm error code ETIMEDOUT'])).toBe(false);
    expect(npmVersionNotFound(rootOwnedCache)).toBe(false);
  });

  it('recognizes only permission failures inside npm cache folders', () => {
    expect(npmCacheUnwritable(rootOwnedCache)).toBe(true);
    expect(npmCacheUnwritable(['npm ERR! code EPERM', 'npm ERR! path C:\\Users\\ann\\AppData\\Local\\npm-cache\\_cacache\\tmp'])).toBe(true);
    expect(npmCacheUnwritable([])).toBe(false);
    expect(npmCacheUnwritable(['npm error code EACCES', 'npm error path /Users/ann/.cezar/versions/.staging-1'])).toBe(false);
    expect(npmCacheUnwritable(['npm error code ETIMEDOUT', 'npm error path /Users/ann/.npm/_cacache/tmp'])).toBe(false);
  });

  it('refuses an install whose entry file never appeared', async () => {
    await expect(installFromRegistry('0.12.1', { env, runNpm: async () => {} })).rejects.toThrow('entry file is missing');
    expect(staged()).toEqual([]);
    expect(existsSync(versionDir('0.12.1', env))).toBe(false);
  });

  it('answers an already installed version without running npm', async () => {
    await installFromRegistry('0.12.1', { env, runNpm: npmThatInstalls('first') });
    let ran = false;
    await installFromRegistry('0.12.1', {
      env,
      runNpm: async () => {
        ran = true;
      },
    });
    expect(ran).toBe(false);
    expect(readFileSync(versionEntry('0.12.1', env), 'utf8')).toContain('first');
  });

  it('never builds a path from an unsafe version id', async () => {
    let ran = false;
    await expect(
      installFromRegistry('..', {
        env,
        runNpm: async () => {
          ran = true;
        },
      }),
    ).rejects.toThrow();
    expect(ran).toBe(false);
    expect(existsSync(home)).toBe(true);
  });
});

describe('ensurePathHook', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-path-hook-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  // Skipped where the function only reports a line (it never edits anything on Windows).
  it.skipIf(process.platform === 'win32')('writes to the home it was given, once', () => {
    const env = { HOME: home, SHELL: '/bin/zsh' };
    const dir = join(home, '.cezar', 'bin');
    const first = ensurePathHook(dir, env);
    expect(first).toMatchObject({ file: join(home, '.zshrc'), alreadyPresent: false });
    expect(first.line).toContain('export PATH="$HOME/.cezar/bin:$PATH"');
    const second = ensurePathHook(dir, env);
    expect(second.alreadyPresent).toBe(true);
    const rc = readFileSync(join(home, '.zshrc'), 'utf8');
    expect(rc.split('\n').filter((line) => line.includes('.cezar/bin'))).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('keeps what the profile already held, and picks the file by shell', () => {
    writeFileSync(join(home, '.bashrc'), 'alias ll="ls -l"\n');
    const result = ensurePathHook(join(home, '.cezar', 'bin'), { HOME: home, SHELL: '/usr/bin/bash' });
    expect(result.file).toBe(join(home, '.bashrc'));
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toMatch(/^alias ll="ls -l"\n\nexport PATH=/);
    expect(ensurePathHook(join(home, '.cezar', 'bin'), { HOME: home, SHELL: '/usr/bin/fish' }).file).toBe(join(home, '.profile'));
  });
});

describe('a read-only service', () => {
  // The fallback `createApp` builds when no updater is injected: it has no way to restart the
  // process, so it must not be able to install either — whatever the install kind.
  it('cannot apply, even from a managed install', () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-readonly-'));
    try {
      const env = { ...process.env, CEZ_HOME: home };
      const entry = join(versionsDir(env), 'current', 'node_modules', '@open-mercato', 'cezar', 'dist', 'index.js');
      const base = { pkgName: '@open-mercato/cezar', version: '0.12.0', entry, restart: () => {}, env };
      expect(new SelfUpdateService(base).capability().canSelfUpdate).toBe(true);
      const readOnly = new SelfUpdateService({ ...base, readOnly: true });
      expect(readOnly.capability()).toMatchObject({ canSelfUpdate: false });
      expect(() => readOnly.apply('0.12.1')).toThrow('without an updater');
      expect(existsSync(versionsDir(env))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
