import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  beforeCreate: undefined as (() => void) | undefined,
  afterWrite: undefined as (() => void) | undefined,
  denyReadWrite: false,
  shortWrite: false,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => {
      const result = actual.existsSync(...args);
      if (!result) { const hook = hooks.beforeCreate; hooks.beforeCreate = undefined; hook?.(); }
      return result;
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (typeof args[1] === 'number' && (args[1] & actual.constants.O_EXCL)) {
        const hook = hooks.beforeCreate; hooks.beforeCreate = undefined; hook?.();
      }
      if (hooks.denyReadWrite && typeof args[1] === 'number' && (args[1] & actual.constants.O_RDWR) && !(args[1] & actual.constants.O_EXCL)) {
        throw Object.assign(new Error('read-only fixture'), { code: 'EACCES' });
      }
      return actual.openSync(...args);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      const result = hooks.shortWrite
        ? actual.writeSync(args[0], args[1].slice(0, 3), args[2], args[3])
        : actual.writeSync(...args);
      const hook = hooks.afterWrite; hooks.afterWrite = undefined; hook?.();
      return result;
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      actual.writeFileSync(...args);
      const hook = hooks.afterWrite; hooks.afterWrite = undefined; hook?.();
    },
  };
});
import { ensureLaunchKey } from './launch-key.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'cez-launch-key-')); });
afterEach(() => { hooks.beforeCreate = undefined; hooks.afterWrite = undefined; hooks.denyReadWrite = false; hooks.shortWrite = false; fs.rmSync(dir, { recursive: true, force: true }); });
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

describe('ensureLaunchKey', () => {
  it('creates missing state directories and reuses the persisted key', () => {
    const data = join(dir, 'nested', 'state');
    const key = ensureLaunchKey(data);
    expect(key).toMatch(uuid);
    expect(fs.readFileSync(join(data, 'launch-key'), 'utf8')).toBe(`${key}\n`);
    expect(ensureLaunchKey(data)).toBe(key);
    if (process.platform !== 'win32') expect(fs.statSync(join(data, 'launch-key')).mode & 0o777).toBe(0o600);
  });
  it('persists the complete key even when descriptor writes are short', () => {
    hooks.shortWrite = true;
    const key = ensureLaunchKey(dir);
    expect(fs.readFileSync(join(dir, 'launch-key'), 'utf8')).toBe(`${key}\n`);
    expect(ensureLaunchKey(dir)).toBe(key);
  });
  it('reuses an existing non-UUID key byte-for-byte after trimming', () => {
    fs.writeFileSync(join(dir, 'launch-key'), '  legacy-secret\n');
    expect(ensureLaunchKey(dir)).toBe('legacy-secret');
    expect(fs.readFileSync(join(dir, 'launch-key'), 'utf8')).toBe('  legacy-secret\n');
  });
  it('reuses a readable key when a writable open is denied', () => {
    fs.writeFileSync(join(dir, 'launch-key'), 'read-only-key\n');
    hooks.denyReadWrite = true;
    expect(ensureLaunchKey(dir)).toBe('read-only-key');
  });
  it('reuses a concurrent creator rather than overwriting its key', () => {
    hooks.beforeCreate = () => fs.writeFileSync(join(dir, 'launch-key'), 'concurrent-key\n');
    expect(ensureLaunchKey(dir)).toBe('concurrent-key');
    expect(fs.readFileSync(join(dir, 'launch-key'), 'utf8')).toBe('concurrent-key\n');
  });
  it('regenerates an empty persisted key', () => {
    fs.writeFileSync(join(dir, 'launch-key'), ' \n', { mode: 0o644 });
    const key = ensureLaunchKey(dir);
    expect(key).toMatch(uuid);
    expect(ensureLaunchKey(dir)).toBe(key);
    expect(fs.readFileSync(join(dir, 'launch-key'), 'utf8')).toBe(`${key}\n`);
    if (process.platform !== 'win32') expect(fs.statSync(join(dir, 'launch-key')).mode & 0o777).toBe(0o600);
  });
  it('degrades to an ephemeral key when the state directory cannot be created', () => {
    const file = join(dir, 'file'); fs.writeFileSync(file, 'preserve');
    expect(ensureLaunchKey(join(file, 'state'))).toMatch(uuid);
    expect(fs.readFileSync(file, 'utf8')).toBe('preserve');
  });
  it.skipIf(process.platform === 'win32')('refuses an existing symlink to an attacker-selected key', () => {
    const victim = join(dir, 'victim'); fs.writeFileSync(victim, 'known-key\n');
    fs.symlinkSync(victim, join(dir, 'launch-key'));
    expect(ensureLaunchKey(dir)).toMatch(uuid);
    expect(fs.readFileSync(victim, 'utf8')).toBe('known-key\n');
  });
  it.skipIf(process.platform === 'win32')('does not create a dangling symlink target', () => {
    const victim = join(dir, 'missing'); fs.symlinkSync(victim, join(dir, 'launch-key'));
    expect(ensureLaunchKey(dir)).toMatch(uuid);
    expect(fs.existsSync(victim)).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('does not truncate a symlink target inserted immediately before creation', () => {
    const victim = join(dir, 'victim'); fs.writeFileSync(victim, 'preserve', { mode: 0o644 });
    hooks.beforeCreate = () => fs.symlinkSync(victim, join(dir, 'launch-key'));
    expect(ensureLaunchKey(dir)).toMatch(uuid);
    expect(fs.readFileSync(victim, 'utf8')).toBe('preserve');
    expect(fs.statSync(victim).mode & 0o777).toBe(0o644);
  });
  it.skipIf(process.platform === 'win32')('does not chmod a replacement pathname after writing the key', () => {
    const victim = join(dir, 'victim'); fs.writeFileSync(victim, 'preserve', { mode: 0o644 });
    hooks.afterWrite = () => { fs.renameSync(join(dir, 'launch-key'), join(dir, 'original')); fs.symlinkSync(victim, join(dir, 'launch-key')); };
    expect(ensureLaunchKey(dir)).toMatch(uuid);
    expect(fs.readFileSync(victim, 'utf8')).toBe('preserve');
    expect(fs.statSync(victim).mode & 0o777).toBe(0o644);
    expect(fs.statSync(join(dir, 'original')).mode & 0o777).toBe(0o600);
  });
});
