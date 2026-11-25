import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGER_MEMORY_LIMITS } from '@open-mercato/cezar-contract';
import { claudeAutoMemory, memoryBytes, readMemory, removeMemoryEntry, renderMemory, setMemoryEntry, writeMemory, type MemoryFile } from './memory.ts';

const AT = '2026-11-21T08:00:00.000Z';

describe('manager memory', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cez-memory-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const set = (file: MemoryFile, key: string, text: string) => setMemoryEntry(file, key, { kind: 'feedback', text }, AT, 'user');

  it('replaces by key and keeps the order', () => {
    const one = set({ entries: [] }, 'a', 'Open full PRs') as MemoryFile;
    const two = set(one, 'b', 'HTML design first') as MemoryFile;
    const three = set(two, 'a', 'Open full PRs, never drafts') as MemoryFile;
    expect(three.entries.map((entry) => [entry.key, entry.text])).toEqual([['a', 'Open full PRs, never drafts'], ['b', 'HTML design first']]);
  });

  it('refuses a near-duplicate under another key, naming the key', () => {
    const one = set({ entries: [] }, 'a', 'Open full PRs.') as MemoryFile;
    expect(set(one, 'b', 'open FULL prs')).toEqual({ error: 'memory "a" already says this: replace that key instead', status: 409 });
  });

  it('refuses a write past the budget and names the oldest entries', () => {
    let file: MemoryFile = { entries: [] };
    for (let i = 0; i < MANAGER_MEMORY_LIMITS.entries; i++) file = set(file, `k${i}`, `fact number ${i}`) as MemoryFile;
    const refused = set(file, 'one-more', 'past the budget');
    expect(refused).toMatchObject({ status: 409 });
    expect('error' in refused && refused.error).toContain('oldest: k0');
    expect(memoryBytes(file.entries)).toBeLessThanOrEqual(MANAGER_MEMORY_LIMITS.bytes);
  });

  it('removes, and answers 404 for an unknown key', () => {
    const one = set({ entries: [] }, 'a', 'x') as MemoryFile;
    expect(removeMemoryEntry(one, 'a')).toEqual({ entries: [] });
    expect(removeMemoryEntry(one, 'z')).toMatchObject({ status: 404 });
  });

  it('round-trips the file, drops a bad entry and keeps the rest', () => {
    writeMemory(dir, { entries: [{ key: 'a', kind: 'pointer', text: 'tracking #2363', updatedAt: AT, source: 'user' }], imported: { at: AT, count: 0 } });
    expect(readMemory(dir)?.entries).toHaveLength(1);
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({ entries: [{ key: 'BAD KEY' }, { key: 'b', kind: 'decision', text: 'ok', updatedAt: AT, source: 'user' }] }));
    expect(readMemory(dir)?.entries.map((entry) => entry.key)).toEqual(['b']);
    expect(readMemory(join(dir, 'missing'))).toBeUndefined();
  });

  it('renders one line per entry, and nothing when empty', () => {
    expect(renderMemory([])).toBe('');
    expect(renderMemory([{ key: 'a', kind: 'feedback', text: 'Full PRs', why: 'drafts stall', updatedAt: AT, source: 'user' }]))
      .toContain('- Full PRs (why: drafts stall) [feedback: a]');
  });

  it('imports Claude Code’s auto-memory files, MEMORY.md excluded', () => {
    const workdir = '/Users/someone/.cezar/managers/m1/workdir';
    const memoryDir = join(dir, 'projects', workdir.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Full PRs](full-prs.md)\n');
    writeFileSync(join(memoryDir, 'full-prs.md'), '---\nname: full-prs\ndescription: "Open full PRs, not drafts"\nmetadata:\n  type: feedback\n---\n\nBody.\n**Why:** reviews start sooner.\n');
    writeFileSync(join(memoryDir, 'stack.md'), '---\nname: Mobile stack\ndescription: fixes go into the owning PR\ntype: project\n---\n');
    expect(claudeAutoMemory(workdir, dir, AT)).toEqual([
      { key: 'full-prs', kind: 'feedback', text: 'Open full PRs, not drafts', why: 'reviews start sooner.', updatedAt: AT, source: 'import' },
      { key: 'mobile-stack', kind: 'pointer', text: 'fixes go into the owning PR', updatedAt: AT, source: 'import' },
    ]);
    expect(claudeAutoMemory('/nowhere', dir, AT)).toEqual([]);
  });
});
