import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A macOS privacy (TCC) denial cannot be produced on a real filesystem in a test — it needs the
 * user to have clicked "Don't Allow" — so this one case fakes the `readdir` answer. Everything
 * else about the picker is proven against real directories in `fs-browse.test.ts`.
 */
const denied = new Set<string>();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: ((path: string, ...rest: unknown[]) =>
      denied.has(String(path))
        ? Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
        : (actual.readdir as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.readdir,
  };
});

const { browseDirectory, MACOS_PRIVACY_BLOCKED } = await import('./fs-browse.ts');

describe('browseDirectory — a folder macOS privacy blocks', () => {
  const platform = process.platform;
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-fs-privacy-')));
    mkdirSync(join(root, 'Documents'));
    denied.add(join(root, 'Documents'));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    denied.clear();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers 403 with the privacy reason on macOS, not "no such directory"', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(await browseDirectory({ root, path: 'Documents' })).toEqual({ ok: false, status: 403, error: MACOS_PRIVACY_BLOCKED });
  });

  it('keeps an unreadable folder indistinguishable from an absent one elsewhere', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(await browseDirectory({ root, path: 'Documents' })).toEqual({ ok: false, status: 404, error: 'no such directory' });
  });
});
