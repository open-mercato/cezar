import { homedir } from 'node:os';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEnvNameIssue } from '@open-mercato/cezar-contract';
import { CheckEnv, CheckEnvError, parseCheckEnv, serializeCheckEnv } from './check-env.ts';

describe('CheckEnv store (spec 2026-10-06-agentic-e2e-checks Phase 1)', () => {
  let home: string;
  let root: string;
  let store: CheckEnv;
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, CEZ_HOME: home });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cez-check-env-home-'));
    root = await mkdtemp(join(tmpdir(), 'cez-check-env-root-'));
    store = new CheckEnv(env());
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('writes a 0600 file inside a 0700 directory that ignores itself', async () => {
    await store.set('demo', root, 'E2E_KEY', 'value-1');
    const dir = join(home, 'check-env');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'demo.env'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('*');
    expect(await store.values('demo', root)).toEqual({ E2E_KEY: 'value-1' });
  });

  it('answers names only, sorted, and removes one', async () => {
    await store.set('demo', root, 'ZED', 'z');
    await store.set('demo', root, 'ALPHA', 'a');
    expect(await store.names('demo', root)).toEqual(['ALPHA', 'ZED']);
    expect(await store.unset('demo', root, 'ZED')).toBe(true);
    expect(await store.unset('demo', root, 'ZED')).toBe(false);
    expect(await store.names('demo', root)).toEqual(['ALPHA']);
  });

  it.each([
    ['lowercase', 'e2e_key'],
    ['leading digit', '1KEY'],
    ['too long', `K${'A'.repeat(128)}`],
    ['cezar namespace', 'CEZ_RUN_ID'],
    ['loader', 'DYLD_INSERT_LIBRARIES'],
    ['shell', 'PATH'],
    ['shell', 'BASH_ENV'],
    ['node', 'NODE_OPTIONS'],
    ['loader', 'LD_PRELOAD'],
    ['temp dir', 'TMPDIR'],
  ])('refuses a %s name (%s) with a reason, never a silent drop', async (_class, name) => {
    expect(checkEnvNameIssue(name)).toBeTruthy();
    await expect(store.set('demo', root, name, 'x')).rejects.toBeInstanceOf(CheckEnvError);
  });

  it('refuses empty, multi-line and oversized values', async () => {
    await expect(store.set('demo', root, 'KEY', 'a\nB=b')).rejects.toBeInstanceOf(CheckEnvError);
    await expect(store.set('demo', root, 'KEY', 'x'.repeat(16 * 1024 + 1))).rejects.toBeInstanceOf(CheckEnvError);
    // An empty value would SHADOW the server's own variable of that name with '' rather than
    // read as unset, so the store refuses it exactly as the CLI and the cockpit do.
    await expect(store.set('demo', root, 'KEY', '')).rejects.toThrow(/not empty/);
    expect(await store.names('demo', root)).toEqual([]);
  });

  it('reports a store it found but could not use, and stays quiet when there is none', async () => {
    // Nothing stored: the ordinary case says nothing.
    expect(await store.read('demo', root)).toEqual({ values: {} });
    await store.set('demo', root, 'KEY', 'v');
    expect(await store.read('demo', root)).toEqual({ values: { KEY: 'v' } });

    const other = await mkdtemp(join(tmpdir(), 'cez-check-env-other-'));
    try {
      const mismatch = await store.read('demo', other);
      expect(mismatch.values).toEqual({});
      expect(mismatch.skipped).toMatch(/belongs to another project root/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }

    await writeFile(join(home, 'check-env', 'demo.env'), 'x'.repeat(300 * 1024), { mode: 0o600 });
    const corrupt = await store.read('demo', root);
    expect(corrupt.values).toEqual({});
    expect(corrupt.skipped).toMatch(/unreadable/);
  });

  it('round-trips values with quotes, = and spaces exactly', async () => {
    const value = `"quoted" it's a=b c`;
    await store.set('demo', root, 'KEY', value);
    expect((await store.values('demo', root)).KEY).toBe(value);
  });

  it('keeps every write under concurrent writers', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `KEY_${i}`);
    // Separate store instances, as two processes (cockpit + CLI) would be.
    await Promise.all(names.map((name) => new CheckEnv(env()).set('demo', root, name, name.toLowerCase())));
    expect(await store.names('demo', root)).toEqual([...names].sort());
  });

  it('does not follow a symlinked file', async () => {
    await store.set('demo', root, 'KEY', 'real');
    const target = join(home, 'elsewhere.env');
    await writeFile(target, serializeCheckEnv(root, { KEY: 'planted' }), { mode: 0o600 });
    await rm(join(home, 'check-env', 'demo.env'));
    await symlink(target, join(home, 'check-env', 'demo.env'));
    expect(await store.values('demo', root)).toEqual({});
  });

  it('never hands one repository\'s values to another that took over its project id', async () => {
    await store.set('demo', root, 'KEY', 'first-owner');
    const other = await mkdtemp(join(tmpdir(), 'cez-check-env-other-'));
    try {
      expect(await store.values('demo', other)).toEqual({});
      // The new owner's first write starts the file over instead of inheriting the key.
      await store.set('demo', other, 'OTHER', 'mine');
      expect(await store.values('demo', other)).toEqual({ OTHER: 'mine' });
      expect(await store.values('demo', root)).toEqual({});
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('degrades a missing or corrupt store to no values', async () => {
    expect(await store.values('demo', root)).toEqual({});
    expect(await store.values('../escape', root)).toEqual({});
    await store.set('demo', root, 'KEY', 'v');
    await writeFile(join(home, 'check-env', 'demo.env'), 'x'.repeat(300 * 1024), { mode: 0o600 });
    expect(await store.values('demo', root)).toEqual({});
  });

  it('trips the sandbox guard when a test would write the real cezar home', async () => {
    const unpinned = new CheckEnv({ ...process.env, CEZ_HOME: join(homedir(), '.cezar') });
    await expect(unpinned.set('demo', root, 'KEY', 'v')).rejects.toThrow(/refusing to write/);
  });

  it('parses NAME=value lines with one optional pair of quotes and nothing else', () => {
    const parsed = parseCheckEnv([
      '# comment',
      '# root: /repo',
      'A="double"',
      "B='single'",
      'C=bare',
      'D="unbalanced',
      'export E=no',
      'lower=no',
      'PATH=/evil',
      'F=$HOME',
    ].join('\n'));
    expect(parsed).toEqual({
      root: '/repo',
      values: { A: 'double', B: 'single', C: 'bare', D: '"unbalanced', F: '$HOME' },
    });
  });
});
