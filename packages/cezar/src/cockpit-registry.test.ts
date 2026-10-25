import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCockpit, liveCockpits, pickCockpit, registerCockpit, type CockpitRecord } from './cockpit-registry.ts';

describe('cockpit registry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-cockpits-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const record = (pid: number, repoRoot: string, startedAt: string, port = 4000 + pid): CockpitRecord => ({ url: `http://127.0.0.1:${port}`, pid, repoRoot, startedAt });
  const write = (r: CockpitRecord) => writeFileSync(join(dir, `${r.pid}.json`), JSON.stringify(r));
  const everyoneAlive = () => true;

  it('registers url, pid, repoRoot and startedAt, and removes the file on request', () => {
    const remove = registerCockpit({ url: 'http://127.0.0.1:4321', repoRoot: '/r/app' }, { dir, pid: 4242, now: () => new Date('2026-10-21T10:00:00Z') });
    expect(liveCockpits({ dir, alive: everyoneAlive })).toEqual([{ url: 'http://127.0.0.1:4321', pid: 4242, repoRoot: '/r/app', startedAt: '2026-10-21T10:00:00.000Z' }]);
    remove();
    expect(readdirSync(dir)).toEqual([]);
    remove(); // idempotent
  });

  it('ignores and sweeps dead pids, malformed files and foreign files', () => {
    write(record(1, '/a', '2026-10-21T10:00:00Z'));
    write(record(2, '/b', '2026-10-21T11:00:00Z'));
    writeFileSync(join(dir, '3.json'), '{not json');
    writeFileSync(join(dir, '4.json'), JSON.stringify({ url: 'nope' }));
    writeFileSync(join(dir, 'readme.txt'), 'x');
    const live = liveCockpits({ dir, alive: (pid) => pid === 2 });
    expect(live.map((r) => r.pid)).toEqual([2]);
    expect(readdirSync(dir).sort()).toEqual(['2.json', '3.json', '4.json', 'readme.txt']); // 1.json swept
  });

  it('a missing directory is no cockpit, not an error', () => {
    expect(liveCockpits({ dir: join(dir, 'nope') })).toEqual([]);
  });

  it('one live cockpit: use it, whatever cwd is', () => {
    const pick = pickCockpit([record(7, '/r/app', '2026-10-21T10:00:00Z')], '/elsewhere');
    expect(pick?.record.pid).toBe(7);
    expect(pick?.reason).toMatch(/only running cockpit/);
  });

  it('several: prefer the one serving cwd (deepest root), say which', () => {
    const outer = record(1, resolve('/r/mono'), '2026-10-21T12:00:00Z');
    const inner = record(2, resolve('/r/mono/pkg'), '2026-10-21T09:00:00Z');
    const other = record(3, resolve('/r/other'), '2026-10-21T13:00:00Z');
    const pick = pickCockpit([other, outer, inner], resolve('/r/mono/pkg/src'));
    expect(pick?.record.pid).toBe(2);
    expect(pick?.reason).toMatch(/3 cockpits running; chose the one serving/);
  });

  it('several, none serving cwd: the most recent, and say so; a sibling dir with a shared prefix is not a match', () => {
    const a = record(1, resolve('/r/app'), '2026-10-21T09:00:00Z');
    const b = record(2, resolve('/r/app2'), '2026-10-21T11:00:00Z');
    const pick = pickCockpit([b, a], resolve('/r/app-extra'));
    expect(pick?.record.pid).toBe(2);
    expect(pick?.reason).toMatch(/none serving .* most recent/);
    expect(pickCockpit([b, a], resolve('/r/app/sub'))?.record.pid).toBe(1);
  });

  it('never discovers inside a task: an absent CEZ_API_URL is the signal there', () => {
    mkdirSync(dir, { recursive: true });
    write(record(5, resolve('/r/app'), '2026-10-21T10:00:00Z'));
    expect(discoverCockpit({}, resolve('/r/app'), { dir, alive: everyoneAlive })?.record.pid).toBe(5);
    expect(discoverCockpit({ CEZ_TASK_ID: 'run-1' }, resolve('/r/app'), { dir, alive: everyoneAlive })).toBeUndefined();
  });
});
