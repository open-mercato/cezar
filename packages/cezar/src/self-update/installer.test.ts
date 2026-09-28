import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installFromRegistry, type InstallOptions } from './installer.ts';
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
