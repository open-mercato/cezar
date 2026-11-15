import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manager, ManagerMessage } from '@open-mercato/cezar-contract';
import { managersPath } from '../paths.ts';
import { ManagerStore } from './store.ts';

const manager = (id: string): Manager => ({
  id, name: id, instructions: '', avatar: 0, projects: 'all', cronMinutes: 15, jobs: [], createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z',
});
const user = (id: string, seq: number, text: string): ManagerMessage => ({ id, seq, at: '2026-10-31T00:00:00.000Z', kind: 'user', text });

describe('ManagerStore', () => {
  let home: string;
  const previous = process.env.CEZ_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-managers-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    process.env.CEZ_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it('degrades a corrupt definitions file to empty with one warning and keeps it aside', () => {
    writeFileSync(managersPath(), '{ not json');
    const warn = vi.fn();
    const store = new ManagerStore(warn);
    expect(store.list()).toEqual([]);
    store.list();
    expect(warn).toHaveBeenCalledOnce();
    store.mutate((managers) => [...managers, manager('a')]);
    expect(store.list().map((row) => row.id)).toEqual(['a']);
    expect(readdirSync(home).some((name) => name.startsWith('managers.json.corrupt-'))).toBe(true);
  });

  it('salvages per entry: one bad row neither evicts the rest nor is lost on rewrite', () => {
    writeFileSync(managersPath(), JSON.stringify({ managers: [{ id: 'BAD ID' }, manager('good')], future: 1 }));
    const store = new ManagerStore(() => undefined);
    expect(store.list().map((row) => row.id)).toEqual(['good']);
    store.update('good', (row) => ({ ...row, name: 'renamed' }));
    const file = JSON.parse(readFileSync(managersPath(), 'utf8'));
    expect(file.future).toBe(1);
    expect(file.managers).toHaveLength(2);
    expect(file.managers.some((row: { id: string }) => row.id === 'BAD ID')).toBe(true);
  });

  it('keeps a newer cezar\'s keys on a manager, and really drops a cleared one', () => {
    writeFileSync(managersPath(), JSON.stringify({ managers: [{ ...manager('a'), model: 'opus', fromTheFuture: true }] }));
    const store = new ManagerStore(() => undefined);
    store.update('a', ({ model: _model, ...row }) => row);
    const [row] = JSON.parse(readFileSync(managersPath(), 'utf8')).managers;
    expect(row.fromTheFuture).toBe(true);
    expect(row.model).toBeUndefined();
  });

  it('replays chat.ndjson newest-write-wins and skips a bad line', () => {
    const warn = vi.fn();
    const store = new ManagerStore(warn);
    store.persistMessage('a', user('m1', 0, 'first'));
    store.persistMessage('a', user('m2', 1, 'second'));
    store.persistMessage('a', user('m1', 0, 'replaced'));
    appendFileSync(join(store.dir('a'), 'chat.ndjson'), 'garbage\n');
    const fresh = new ManagerStore(warn);
    expect(fresh.messages('a').map((row) => (row.kind === 'user' ? row.text : ''))).toEqual(['replaced', 'second']);
    expect(fresh.nextSeq('a')).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('sees what a second process appended', () => {
    const one = new ManagerStore(() => undefined);
    const two = new ManagerStore(() => undefined);
    one.persistMessage('a', user('m1', 0, 'hello'));
    expect(two.messages('a')).toHaveLength(1);
    two.persistMessage('a', user('m2', two.nextSeq('a'), 'back'));
    expect(one.nextSeq('a')).toBe(2);
  });

  it('survives a corrupt state file, and deleting the directory loses history only', () => {
    const store = new ManagerStore(() => undefined);
    mkdirSync(store.dir('a'), { recursive: true });
    writeFileSync(join(store.dir('a'), 'state.json'), 'nope');
    expect(store.state('a').costUsd).toBe(0);
    store.persistMessage('a', user('m1', 0, 'hello'));
    store.removeFiles('a');
    expect(existsSync(store.dir('a'))).toBe(false);
    expect(store.messages('a')).toEqual([]);
  });
});
