import { describe, expect, it, vi } from 'vitest';
import { open } from 'node:fs/promises';
import { syncDirectory } from './storage.ts';

// `open` is mocked at the module boundary so the tolerated-errno matrix is pinned per platform:
// the tolerance decides whether a crash-durability barrier silently degrades or fails the write.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() , open: vi.fn() }));
const mockedOpen = vi.mocked(open);

async function withPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try { return await run(); } finally { Object.defineProperty(process, 'platform', original); }
}

const failed = (code: string) => Object.assign(new Error(code), { code });
const handle = (sync: () => Promise<void>) => ({ sync, close: vi.fn().mockResolvedValue(undefined) }) as unknown as Awaited<ReturnType<typeof open>>;

describe('directory sync durability tolerance', () => {
  it('tolerates the Windows-only errnos on win32 and not on macOS', async () => {
    for (const code of ['EPERM', 'EACCES', 'EISDIR']) {
      mockedOpen.mockRejectedValueOnce(failed(code));
      await expect(withPlatform('win32', () => syncDirectory('/x'))).resolves.toBeUndefined();
      mockedOpen.mockRejectedValueOnce(failed(code));
      await expect(withPlatform('darwin', () => syncDirectory('/x'))).rejects.toThrow(code);
    }
  });

  it('tolerates a refused fsync on every platform but never a real error', async () => {
    for (const code of ['EINVAL', 'ENOTSUP', 'EBADF']) {
      mockedOpen.mockResolvedValueOnce(handle(() => Promise.reject(failed(code))));
      await expect(withPlatform('darwin', () => syncDirectory('/x'))).resolves.toBeUndefined();
    }
    mockedOpen.mockResolvedValueOnce(handle(() => Promise.reject(failed('EIO'))));
    await expect(withPlatform('win32', () => syncDirectory('/x'))).rejects.toThrow('EIO');
  });
});
