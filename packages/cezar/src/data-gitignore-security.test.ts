import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  beforeCreate: undefined as (() => void) | undefined,
  afterRead: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
  failStat: false,
  failRead: false,
  failWrite: false,
  descriptors: [] as number[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => {
      const exists = actual.existsSync(...args);
      if (!exists) {
        const hook = hooks.beforeCreate; hooks.beforeCreate = undefined; hook?.();
      }
      return exists;
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (typeof args[1] === 'number' && (args[1] & actual.constants.O_EXCL)) {
        const hook = hooks.beforeCreate; hooks.beforeCreate = undefined; hook?.();
      }
      const fd = actual.openSync(...args);
      hooks.descriptors.push(fd);
      const hook = hooks.afterOpen; hooks.afterOpen = undefined; hook?.();
      return fd;
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (hooks.failRead) throw new Error('read failure');
      const content = actual.readFileSync(...args);
      const hook = hooks.afterRead; hooks.afterRead = undefined; hook?.();
      return content;
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (hooks.failStat) throw new Error('metadata failure');
      return actual.fstatSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (hooks.failWrite) throw new Error('write failure');
      return actual.writeFileSync(...args);
    },
  };
});

import { DATA_GITIGNORE_ENTRIES, ensureDataGitignore } from './data-gitignore.js';

let root: string;
let path: string;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'cez-gitignore-security-'));
  fs.mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  path = join(root, '.ai/cezar/.gitignore');
});
afterEach(() => {
  hooks.beforeCreate = undefined;
  hooks.afterRead = undefined;
  hooks.afterOpen = undefined;
  hooks.failStat = false;
  hooks.failRead = false;
  hooks.failWrite = false;
  hooks.descriptors = [];
  fs.rmSync(root, { recursive: true, force: true });
});

function expectClosed(): void {
  expect(hooks.descriptors).toHaveLength(1);
  for (const fd of hooks.descriptors) {
    expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  }
}

describe('data gitignore file identity (CodeQL22)', () => {
  it('preserves a concurrent creator and appends missing entries', () => {
    hooks.beforeCreate = () => fs.writeFileSync(path, 'concurrent-private/\n');
    ensureDataGitignore(root);
    const contents = fs.readFileSync(path, 'utf8');
    expect(contents).toMatch(/^concurrent-private\/\n/);
    for (const entry of DATA_GITIGNORE_ENTRIES) expect(contents.split('\n')).toContain(entry);
  });

  it.skipIf(process.platform === 'win32')('does not rewrite an existing symlink target', () => {
    const target = join(root, 'victim');
    fs.writeFileSync(target, 'preserve victim bytes\n');
    fs.symlinkSync(target, path);
    expect(() => ensureDataGitignore(root)).not.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('preserve victim bytes\n');
  });

  it.skipIf(process.platform === 'win32')('does not create a dangling symlink target', () => {
    const target = join(root, 'absent-victim');
    fs.symlinkSync(target, path);
    ensureDataGitignore(root);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('keeps read and append on the same file when its name is replaced', () => {
    const target = join(root, 'victim');
    const original = join(root, 'moved-gitignore');
    fs.writeFileSync(target, 'untouched victim\n');
    fs.writeFileSync(path, 'user-entry/');
    hooks.afterRead = () => {
      fs.renameSync(path, original);
      fs.symlinkSync(target, path);
    };
    ensureDataGitignore(root);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched victim\n');
    expect(fs.readFileSync(original, 'utf8')).toBe(`user-entry/\n${DATA_GITIGNORE_ENTRIES.join('\n')}\n`);
    expectClosed();
  });

  it('closes the descriptor when no entries are missing', () => {
    fs.writeFileSync(path, `${DATA_GITIGNORE_ENTRIES.join('\n')}\n`);
    ensureDataGitignore(root);
    expectClosed();
  });

  it('rejects a pathname whose identity no longer matches the opened file', () => {
    const original = join(root, 'moved-gitignore');
    fs.writeFileSync(path, 'original bytes\n');
    hooks.afterOpen = () => {
      fs.renameSync(path, original);
      fs.writeFileSync(path, 'replacement bytes\n');
    };
    ensureDataGitignore(root);
    expect(fs.readFileSync(path, 'utf8')).toBe('replacement bytes\n');
    expect(fs.readFileSync(original, 'utf8')).toBe('original bytes\n');
    expectClosed();
  });

  it('closes the descriptor and degrades quietly after a metadata failure', () => {
    fs.writeFileSync(path, 'preserve\n');
    hooks.failStat = true;
    expect(() => ensureDataGitignore(root)).not.toThrow();
    hooks.failStat = false;
    expect(fs.readFileSync(path, 'utf8')).toBe('preserve\n');
    expectClosed();
  });

  it('closes the descriptor and degrades quietly after a write failure', () => {
    fs.writeFileSync(path, 'preserve\n');
    hooks.failWrite = true;
    expect(() => ensureDataGitignore(root)).not.toThrow();
    hooks.failWrite = false;
    expect(fs.readFileSync(path, 'utf8')).toBe('preserve\n');
    expectClosed();
  });

  it('closes the descriptor and degrades quietly after a read failure', () => {
    fs.writeFileSync(path, 'preserve\n');
    hooks.failRead = true;
    expect(() => ensureDataGitignore(root)).not.toThrow();
    hooks.failRead = false;
    expect(fs.readFileSync(path, 'utf8')).toBe('preserve\n');
    expectClosed();
  });

  it('closes a freshly created gitignore after writing all entries', () => {
    ensureDataGitignore(root);
    expect(fs.readFileSync(path, 'utf8')).toBe(`${DATA_GITIGNORE_ENTRIES.join('\n')}\n`);
    expectClosed();
  });

  it('does not throw when the gitignore path is a directory', () => {
    fs.mkdirSync(path);
    expect(() => ensureDataGitignore(root)).not.toThrow();
    expect(fs.statSync(path).isDirectory()).toBe(true);
  });
});
