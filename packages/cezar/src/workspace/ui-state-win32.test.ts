import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Win32 sharing semantics: replacing a file fails EPERM while any handle reads it. Telemetry
// 4a7c9f6c: the sync rename retry blocked the event loop, so a concurrent request's async read
// of ui-state.json never got to close its handle, and every retry hit the same EPERM.
const sharing = vi.hoisted(() => ({ readers: 0 }));

function sharingViolation(): NodeJS.ErrnoException {
  return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
}

async function heldOpenRead<T>(read: () => Promise<T>): Promise<T> {
  sharing.readers += 1;
  try {
    const content = await read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return content;
  } finally {
    sharing.readers -= 1;
  }
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const promises = {
    ...actual.promises,
    readFile: ((...args: Parameters<typeof actual.promises.readFile>) =>
      heldOpenRead(() => actual.promises.readFile(...args))) as typeof actual.promises.readFile,
    rename: async (from: string, to: string) => {
      if (sharing.readers > 0) throw sharingViolation();
      return actual.promises.rename(from, to);
    },
  };
  const renameSync = (from: string, to: string) => {
    if (sharing.readers > 0) throw sharingViolation();
    actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, promises, renameSync }, promises, renameSync };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((...args: Parameters<typeof actual.readFile>) =>
    heldOpenRead(() => actual.readFile(...args))) as typeof actual.readFile;
  const rename = async (from: string, to: string) => {
    if (sharing.readers > 0) throw sharingViolation();
    return actual.rename(from, to);
  };
  return { ...actual, default: { ...actual, readFile, rename }, readFile, rename };
});

const { mergeWriteWorkspaceUiState, readWorkspaceUiState } = await import('./ui-state.ts');
const { mergeWriteWorkspaceConfig } = await import('./config.ts');

describe('workspace state writers under win32 sharing violations', () => {
  const platform = process.platform;
  beforeEach(() => {
    sharing.readers = 0;
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('saves concurrent ui-state PUTs while a GET reads the same file', async () => {
    await mergeWriteWorkspaceUiState((state) => ({ ...state, theme: 'light' }));
    const results = await Promise.allSettled([
      mergeWriteWorkspaceUiState((state) => ({ ...state, density: 'compact' })),
      readWorkspaceUiState(),
      mergeWriteWorkspaceUiState((state) => ({ ...state, theme: 'dark' })),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    await expect(readWorkspaceUiState()).resolves.toMatchObject({ density: 'compact', theme: 'dark' });
  });

  it('saves concurrent workspace config writes without losing either', async () => {
    const results = await Promise.allSettled([
      mergeWriteWorkspaceConfig((config) => ({ ...config, resources: { ...config.resources, memoryLimitMb: 2048 } })),
      mergeWriteWorkspaceConfig((config) => ({ ...config, resources: { ...config.resources, maxParallel: 3 } })),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const { loadWorkspaceConfig } = await import('./config.ts');
    await expect(loadWorkspaceConfig()).resolves.toMatchObject({ resources: { memoryLimitMb: 2048, maxParallel: 3 } });
  });
});
