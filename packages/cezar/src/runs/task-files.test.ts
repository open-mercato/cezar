import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './store.ts';

// Spec 2026-11-19-worktree-disk-usage: a task's artifacts and dispatch tree go with the task, and a
// startup sweep removes leftovers of tasks already gone. The attachment library (#929) outlives tasks.
describe('task files are cleaned up with the task', () => {
  let dataDir: string;
  const old = new Date(Date.now() - 2 * 60 * 60_000); // past the orphan grace window

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-taskfiles-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const file = (path: string, body: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    utimesSync(path, old, old);
  };
  const aged = (dir: string) => utimesSync(join(dataDir, dir), old, old);
  const library = (name: string) => join(dataDir, 'attachments', name);
  const newRun = (store: RunStore, title: string) => store.createRun({ title, workflow: 'w', task: 't', steps: [] });

  it('deleting a task removes its artifacts and dispatch tree, and never the attachment library', () => {
    const store = RunStore.open(dataDir);
    const a = newRun(store, 'a');
    file(join(dataDir, 'artifacts', a.id, 'report.html'), '<p>a</p>');
    file(join(dataDir, 'dispatch', a.id, 'brief.md'), 'brief');
    file(join(dataDir, 'runs', `${a.id}-images`, 'pasted-1.pdf'), 'only-a');
    file(library('mine.pdf'), 'only-a');

    expect(store.deleteRun(a.id)).toBe(true);

    expect(existsSync(join(dataDir, 'artifacts', a.id))).toBe(false);
    expect(existsSync(join(dataDir, 'dispatch', a.id))).toBe(false);
    expect(existsSync(library('mine.pdf'))).toBe(true);
  });

  it('keeps a dispatch tree while a member of it remains', () => {
    const store = RunStore.open(dataDir);
    const root = newRun(store, 'root');
    const child = newRun(store, 'child');
    store.updateRun(root.id, { dispatch: { rootRunId: root.id } });
    store.updateRun(child.id, { dispatch: { rootRunId: root.id, parentRunId: root.id } });
    file(join(dataDir, 'dispatch', root.id, 'brief.md'), 'brief');

    store.deleteRun(root.id);
    expect(existsSync(join(dataDir, 'dispatch', root.id))).toBe(true);
    store.deleteRun(child.id);
    expect(existsSync(join(dataDir, 'dispatch', root.id))).toBe(false);
  });

  it('pruning past the run cap removes the pruned tasks\' files too', () => {
    process.env.CEZ_RUNS_KEEP = '1';
    try {
      const store = RunStore.open(dataDir);
      const first = newRun(store, 'first');
      file(join(dataDir, 'artifacts', first.id, 'a.html'), 'x');
      store.updateRun(first.id, { status: 'done', createdAt: '2026-01-01T00:00:00.000Z' });
      store.updateRun(newRun(store, 'second').id, { status: 'done' });
      expect(store.getRun(first.id)).toBeUndefined();
      expect(existsSync(join(dataDir, 'artifacts', first.id))).toBe(false);
    } finally {
      delete process.env.CEZ_RUNS_KEEP;
    }
  });

  it('the startup sweep removes leftovers of gone tasks and keeps everything a known task holds', () => {
    const store = RunStore.open(dataDir);
    const live = newRun(store, 'live');
    store.updateRun(live.id, { status: 'running', dispatch: { rootRunId: 'root-of-live' } });
    file(join(dataDir, 'artifacts', live.id, 'a.html'), 'x');
    file(join(dataDir, 'artifacts', 'gone-run', 'a.html'), 'x');
    file(join(dataDir, 'dispatch', 'root-of-live', 'brief.md'), 'x');
    file(join(dataDir, 'dispatch', 'gone-root', 'brief.md'), 'x');
    file(join(dataDir, 'artifacts', 'fresh-run', 'a.html'), 'x'); // too new: its run may be unsaved
    file(library('orphan.pdf'), 'nobody');
    for (const dir of ['artifacts/gone-run', `artifacts/${live.id}`, 'dispatch/gone-root', 'dispatch/root-of-live']) aged(dir);

    expect(store.sweepOrphanTaskFiles()).toEqual({ artifacts: ['gone-run'], dispatch: ['gone-root'] });
    expect(existsSync(join(dataDir, 'artifacts', live.id))).toBe(true);
    expect(existsSync(join(dataDir, 'artifacts', 'fresh-run'))).toBe(true);
    expect(existsSync(join(dataDir, 'dispatch', 'root-of-live'))).toBe(true);
    expect(existsSync(library('orphan.pdf'))).toBe(true);
  });

  it('sweeps nothing when the task index could not be read', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify({ invalid: true }));
    file(join(dataDir, 'artifacts', 'unread-run', 'a.html'), 'x');
    file(join(dataDir, 'dispatch', 'unread-root', 'brief.md'), 'x');
    aged('artifacts/unread-run');
    aged('dispatch/unread-root');
    const store = RunStore.open(dataDir);
    expect(store.getIndexReadHealth().state).toBe('unavailable');

    expect(store.sweepOrphanTaskFiles()).toEqual({ artifacts: [], dispatch: [] });
    expect(existsSync(join(dataDir, 'artifacts', 'unread-run'))).toBe(true);
    expect(existsSync(join(dataDir, 'dispatch', 'unread-root'))).toBe(true);
  });
});
