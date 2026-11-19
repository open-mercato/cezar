import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './store.ts';
import { attachmentLibraryPath, runImagesDir } from './task-files.ts';

// Spec 2026-11-19-worktree-disk-usage: a task's artifacts and dispatch tree go with the task, and
// the attachment library never does (BACKWARD_COMPATIBILITY.md §3: the user's own files).
describe('task files are cleaned up with the task', () => {
  let dataDir: string;
  const old = new Date(Date.now() - 2 * 60 * 60_000); // past the library grace window

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-taskfiles-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const file = (path: string, body: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    utimesSync(path, old, old);
  };
  const aged = (dir: string) => utimesSync(dir, old, old);
  const library = (name: string) => join(attachmentLibraryPath(dataDir), name);
  const newRun = (store: RunStore, title: string) => store.createRun({ title, workflow: 'w', task: 't', steps: [] });

  it('deleting a task removes its artifacts and its dispatch tree, never a library file', () => {
    const store = RunStore.open(dataDir);
    const a = newRun(store, 'a');
    const b = newRun(store, 'b');
    file(join(dataDir, 'artifacts', a.id, 'report.html'), '<p>a</p>');
    file(join(dataDir, 'dispatch', a.id, 'brief.md'), 'brief');
    file(join(runImagesDir(dataDir, a.id), 'pasted-1.pdf'), 'only-a');
    file(join(runImagesDir(dataDir, a.id), 'pasted-2.pdf'), 'shared');
    file(join(runImagesDir(dataDir, b.id), 'pasted-1.pdf'), 'shared');
    file(library('mine.pdf'), 'only-a');
    file(library('shared.pdf'), 'shared');
    file(library('unrelated.pdf'), 'someone else');

    expect(store.deleteRun(a.id)).toBe(true);

    expect(existsSync(join(dataDir, 'artifacts', a.id))).toBe(false);
    expect(existsSync(join(dataDir, 'dispatch', a.id))).toBe(false);
    expect(existsSync(library('mine.pdf'))).toBe(true);
    expect(existsSync(library('shared.pdf'))).toBe(true);
    expect(existsSync(library('unrelated.pdf'))).toBe(true);
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
    file(join(runImagesDir(dataDir, live.id), 'pasted-1.pdf'), 'held');
    file(library('held.pdf'), 'held');
    file(library('orphan.pdf'), 'nobody');
    file(join(dataDir, 'artifacts', 'fresh-run', 'a.html'), 'x'); // too new: its run may be unsaved
    for (const dir of ['artifacts/gone-run', 'artifacts/' + live.id, 'dispatch/gone-root', 'dispatch/root-of-live']) {
      aged(join(dataDir, dir));
    }

    const swept = store.sweepOrphanTaskFiles();

    expect(swept.artifacts).toEqual(['gone-run']);
    expect(swept.dispatch).toEqual(['gone-root']);
    expect(existsSync(join(dataDir, 'artifacts', live.id))).toBe(true);
    expect(existsSync(join(dataDir, 'artifacts', 'fresh-run'))).toBe(true);
    expect(existsSync(join(dataDir, 'dispatch', 'root-of-live'))).toBe(true);
    expect(existsSync(library('held.pdf'))).toBe(true);
    expect(existsSync(library('orphan.pdf'))).toBe(true); // the user's file, whoever held it
  });

  it('the startup sweep removes nothing when the task index could not be loaded', () => {
    writeFileSync(join(dataDir, 'runs.json'), '{ truncated');
    const store = RunStore.open(dataDir);
    expect(store.getIndexReadHealth().state).toBe('unavailable');
    file(join(dataDir, 'artifacts', 'some-run', 'a.html'), 'x');
    file(join(dataDir, 'dispatch', 'some-root', 'brief.md'), 'x');
    file(library('held.pdf'), 'held');
    for (const dir of ['artifacts/some-run', 'dispatch/some-root']) aged(join(dataDir, dir));

    expect(store.sweepOrphanTaskFiles()).toEqual({ artifacts: [], dispatch: [] });
    expect(existsSync(join(dataDir, 'artifacts', 'some-run'))).toBe(true);
    expect(existsSync(join(dataDir, 'dispatch', 'some-root'))).toBe(true);
    expect(existsSync(library('held.pdf'))).toBe(true);
  });

  it('the startup sweep removes nothing behind an empty index', () => {
    RunStore.open(dataDir);
    file(join(dataDir, 'artifacts', 'some-run', 'a.html'), 'x');
    aged(join(dataDir, 'artifacts', 'some-run'));
    expect(RunStore.open(dataDir).sweepOrphanTaskFiles()).toEqual({ artifacts: [], dispatch: [] });
    expect(existsSync(join(dataDir, 'artifacts', 'some-run'))).toBe(true);
  });
});
