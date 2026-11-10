import { constants, realpathSync, mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as module from './outbox.ts';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
const dirs: string[] = [];
const directory = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-outbox-')); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const record = (sequence: number) => ({
  version: 1 as const, id: `evt_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`, sequence, installationId: 'inst_test', projectId: 'project', previousStatus: 'running' as const,
  episodeId: `task-1-${sequence}`, type: 'task.finished' as const, occurredAt: '2026-10-13T12:00:00Z', mode: 'local' as const,
  snapshot: { id: 'task-1', status: 'done' as const, archived: false, continuation: 0 },
});
describe('webhook source outbox', () => {
  it('loads a valid existing outbox without requiring write access (#1981)', async () => {
    const dir = directory(); const box = await module.Outbox.open(dir, 'inst_test'); box.append(record(1));
    const originalOpen = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === join(dir, 'outbox.ndjson') && typeof args[1] === 'number' &&
          (args[1] & (constants.O_WRONLY | constants.O_RDWR))) {
        throw Object.assign(new Error('read-only outbox'), { code: 'EACCES' });
      }
      return originalOpen(...args);
    });
    expect((await module.Outbox.open(dir, 'inst_test')).sources()).toEqual([record(1)]);
  });
  it('reads the same file whose size was checked when its pathname is replaced (#1981)', async () => {
    const dir = directory(), replacementDir = directory();
    const box = await module.Outbox.open(dir, 'inst_test'); box.append(record(1));
    const replacement = await module.Outbox.open(replacementDir, 'inst_test');
    replacement.append(record(1)); replacement.append(record(2));
    const path = join(dir, 'outbox.ndjson');
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      renameSync(path, join(dir, 'original.ndjson'));
      renameSync(join(replacementDir, 'outbox.ndjson'), path);
    };
    const originalStat = fsPromises.stat;
    vi.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
      const result = await originalStat(...args); if (String(args[0]) === path) swap(); return result;
    });
    const originalOpen = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const file = await originalOpen(...args);
      if (String(args[0]) === path) {
        const stat = file.stat.bind(file);
        vi.spyOn(file, 'stat').mockImplementation(async (...options) => { const result = await stat(...options); swap(); return result; });
      }
      return file;
    });
    const recovered = await module.Outbox.open(dir, 'inst_test');
    expect(swapped).toBe(true);
    expect(recovered.sources().map(source => source.sequence)).toEqual([1]);
  });
  it('never truncates a replacement regular file during torn-tail recovery (#1981)', async () => {
    const dir = directory();
    const box = await module.Outbox.open(dir, 'inst_test'); box.append(record(1));
    const path = join(dir, 'outbox.ndjson'); appendFileSync(path, '{incomplete');
    const victim = Buffer.from('unrelated replacement data that must survive\n'.repeat(40));
    writeFileSync(join(dir, 'replacement.ndjson'), victim);
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      renameSync(path, join(dir, 'original.ndjson'));
      renameSync(join(dir, 'replacement.ndjson'), path);
    };
    const originalRead = fsPromises.readFile;
    vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
      const result = await originalRead(...args); if (String(args[0]) === path) swap(); return result;
    });
    const originalOpen = fsPromises.open;
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const file = await originalOpen(...args);
      if (String(args[0]) === path) {
        const read = file.readFile.bind(file);
        vi.spyOn(file, 'readFile').mockImplementation(async (...options) => { const result = await read(...options); swap(); return result; });
      }
      return file;
    });
    await expect(module.Outbox.open(dir, 'inst_test')).rejects.toThrow(/changed/);
    expect(swapped).toBe(true);
    expect(readFileSync(path)).toEqual(victim);
  });
  it('removes the compaction candidate when preparing its bytes fails', async () => {
    const dir = directory(); const box = await module.Outbox.open(dir, 'inst_test'); box.append(record(1));
    const original = fsPromises.open;
    const spy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const file = await original(...args);
      if (String(args[0]).endsWith('.tmp')) vi.spyOn(file, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC'));
      return file;
    });
    try { await expect(box.compact()).rejects.toThrow('ENOSPC'); } finally { spy.mockRestore(); }
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect((await module.Outbox.open(dir, 'inst_test')).peek()!.source.id).toBe(record(1).id);
  });
  it('recovers stable ids and high water, and rescans on cursor segment mismatch', async () => {
    const dir = directory(); const box = await module.Outbox.open(dir, 'inst_test');
    expect(box.append(record(1))).toBe(true); expect(box.append(record(2))).toBe(true);
    const first = box.peek()!; await box.advance(first.end);
    expect(box.peek()!.source.sequence).toBe(2);
    writeFileSync(join(dir, 'cursor.json'), JSON.stringify({ segment: 'old', offset: 999999 }));
    const recovered = await module.Outbox.open(dir, 'inst_test', 4);
    expect(recovered.highWater).toBe(4); expect(recovered.peek()!.source.id).toBe(record(1).id);
    expect(recovered.append(record(3))).toBe(false); expect(recovered.append(record(5))).toBe(true);
  });
  it('quarantines a truncated tail before appending new complete records', async () => {
    const dir = directory(); const box = await module.Outbox.open(dir, 'inst_test'); box.append(record(1));
    appendFileSync(join(dir, 'outbox.ndjson'), '{incomplete');
    const recovered = await module.Outbox.open(dir, 'inst_test');
    expect(recovered.append(record(2))).toBe(true);
    expect(readdirSync(dir).some(name => name.startsWith('outbox-tail-'))).toBe(true);
    expect(readFileSync(join(dir, 'outbox.ndjson'), 'utf8')).not.toContain('incomplete');
  });
  it('bounds quarantined crash diagnostics across repeated truncated tails', async () => {
    const dir = directory(); await module.Outbox.open(dir, 'inst_test');
    for (let i = 0; i < 3; i++) {
      appendFileSync(join(dir, 'outbox.ndjson'), 'x'.repeat(200000));
      await module.Outbox.open(dir, 'inst_test');
    }
    const evidence = readdirSync(dir).filter(name => name.endsWith('.quarantine'));
    expect(evidence).toHaveLength(1);
    expect(readFileSync(join(dir, evidence[0]!)).length).toBeLessThanOrEqual(65536);
  });
  it('refuses malformed interior records instead of skipping captured history', async () => {
    const dir = directory(); const box = await module.Outbox.open(dir, 'inst_test'); box.append(record(1));
    appendFileSync(join(dir, 'outbox.ndjson'), '{broken}\n');
    await expect(module.Outbox.open(dir, 'inst_test')).rejects.toThrow('outbox');
  });
  it('does not lose an append racing asynchronous compaction preparation', async () => {
    const dir = directory(); const box = await module.Outbox.open(dir, 'inst_test'); box.append(record(1));
    await box.advance(box.peek()!.end);
    const compacting = box.compact(); box.append(record(2)); await compacting;
    const recovered = await module.Outbox.open(dir, 'inst_test');
    expect(recovered.highWater).toBe(2); expect(recovered.peek()!.source.id).toBe(record(2).id);
    expect(recovered.append(record(3))).toBe(true);
  });
  it('rejects capacity overflow without throwing into lifecycle capture', async () => {
    const box = await module.Outbox.open(directory(), 'inst_test', 0, 700);
    expect(box.append(record(1))).toBe(true); expect(box.append(record(2))).toBe(false);
    expect(box.captureGap).toBe(true); expect(box.highWater).toBe(1);
  });
});
