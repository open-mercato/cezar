import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  path: '', replacement: '', replaceOnOpen: 0, opens: 0, closes: 0, failStat: false,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (args[0] !== control.path) return fs.open(...args);
      control.opens++;
      if (control.opens === control.replaceOnOpen) await fs.rename(control.replacement, control.path);
      const handle = await fs.open(...args);
      const originalStat = handle.stat.bind(handle);
      const originalClose = handle.close.bind(handle);
      handle.stat = ((...statArgs: Parameters<typeof handle.stat>) => {
        if (control.failStat) return Promise.reject(new Error('metadata failed'));
        return originalStat(...statArgs);
      }) as typeof handle.stat;
      handle.close = async () => { control.closes++; return originalClose(); };
      return handle;
    },
  };
});

import { readRunHistoryPage } from './event-history.ts';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  Object.assign(control, { path: '', replacement: '', replaceOnOpen: 0, opens: 0, closes: 0, failStat: false });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'cez-history-race-'));
  control.path = join(dir, 'events.ndjson');
  control.replacement = join(dir, 'replacement.ndjson');
  await writeFile(control.path, JSON.stringify({ seq: 1, ts: 'x', type: 'note', message: 'old' }) + '\n');
}

describe('event history file identity', () => {
  for (const [reader, openIndex] of [['high-water tail', 1], ['reverse page', 2]] as const) {
    it(`sizes the opened replacement in the ${reader} reader`, async () => {
      await setup();
      const replacement = { seq: 99, ts: 'x', type: 'note', message: 'replacement'.repeat(1000) };
      await writeFile(control.replacement, JSON.stringify(replacement) + '\n');
      control.replaceOnOpen = openIndex;
      const page = await readRunHistoryPage(control.path);
      if (openIndex === 1) expect(page.asOfSeq).toBe(99);
      expect(page.events).toEqual([replacement]);
      expect(control.closes).toBe(control.opens);
    });
  }

  it('closes both descriptors for empty histories', async () => {
    await setup();
    await writeFile(control.path, '');
    expect((await readRunHistoryPage(control.path)).events).toEqual([]);
    expect(control.opens).toBe(2);
    expect(control.closes).toBe(2);
  });

  it('closes the descriptor when metadata fails', async () => {
    await setup();
    control.failStat = true;
    await expect(readRunHistoryPage(control.path)).rejects.toThrow('metadata failed');
    expect(control.closes).toBe(1);
  });

  it('preserves an empty response for a missing history', async () => {
    await setup();
    await rm(control.path);
    expect((await readRunHistoryPage(control.path)).events).toEqual([]);
  });
});
