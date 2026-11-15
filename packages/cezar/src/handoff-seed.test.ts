import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeFileSync: vi.fn(),
}));

import { handoffPath, seedHandoffFile } from './handoff.ts';

const run = { id: 'seed-race', title: 'Task', workflow: 'quick-task', task: 'Preserve my notes' };

describe('handoff initialization', () => {
  let dataDir: string;
  let write: typeof fs.writeFileSync;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(join(tmpdir(), 'cezar-handoff-seed-'));
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    write = actual.writeFileSync;
    vi.mocked(fs.writeFileSync).mockImplementation(write);
  });

  afterEach(() => {
    vi.mocked(fs.writeFileSync).mockReset();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates the expected journal and preserves it on repeated initialization', () => {
    const file = seedHandoffFile(dataDir, run);
    expect(file).toBe(handoffPath(dataDir, run.id));
    expect(fs.readFileSync(file, 'utf8')).toContain('## Goal\n\nPreserve my notes');
    write(file, 'Existing agent notes');
    expect(seedHandoffFile(dataDir, run)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('Existing agent notes');
  });

  it('preserves a journal created immediately before the seed write', () => {
    const file = handoffPath(dataDir, run.id);
    vi.mocked(fs.writeFileSync).mockImplementationOnce((...args) => {
      write(file, 'Concurrent agent notes');
      write(...args);
    });
    expect(seedHandoffFile(dataDir, run)).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('Concurrent agent notes');
  });

  it.skipIf(process.platform === 'win32')('does not follow a dangling journal symlink', () => {
    const file = handoffPath(dataDir, run.id);
    const target = join(dataDir, 'other-file');
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.symlinkSync(target, file);
    expect(seedHandoffFile(dataDir, run)).toBe(file);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('returns the journal path when its parent cannot be created', () => {
    write(join(dataDir, 'runs'), 'not a directory');
    expect(seedHandoffFile(dataDir, run)).toBe(handoffPath(dataDir, run.id));
  });
});
