import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_TAGS_MAX } from '@open-mercato/cezar-contract';
import { taskTagsPath } from '../paths.ts';
import {
  TASK_TAG_TOMBSTONES_MAX,
  applyRunTagDelta,
  colorForName,
  createTaskTag,
  defaultTaskTagStore,
  deleteTaskTag,
  listTaskTags,
  loadTaskTags,
  mergeWriteTaskTags,
  resetTaskTagWarningForTests,
  resolveTagRefs,
  resolveTagRefsIn,
  TaskTagError,
  updateTaskTag,
  visibleTaskTags,
  type TaskTagStore,
} from './task-tags.ts';

/** `~/.cezar/task-tags.json` (spec 2026-11-23-task-tags § 4.2). */
describe('task tag registry', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-task-tags-'));
    process.env.CEZ_HOME = home;
    resetTaskTagWarningForTests();
  });

  afterEach(() => {
    try {
      chmodSync(home, 0o700);
    } catch {
      // already gone
    }
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    vi.restoreAllMocks();
  });

  const write = (value: unknown) =>
    writeFileSync(taskTagsPath(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  const tag = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, createdAt: '2026-11-23T00:00:00Z', ...over });

  describe('loading', () => {
    it('an absent file is an empty registry and creates nothing', async () => {
      expect(await loadTaskTags()).toEqual(defaultTaskTagStore());
      expect(existsSync(taskTagsPath())).toBe(false);
    });

    it('salvages rows one at a time and keeps unknown keys', async () => {
      write({
        version: 1,
        future: 'kept',
        tags: [tag('tt-good000001', { extra: 1 }), { id: 'bad id', name: 'x' }, tag('tt-good000001'), 'junk', tag('tt-good000002', { color: 'neon' })],
        deleted: [{ id: 'tt-gone000001', deletedAt: 'x' }, { nope: true }],
      });
      const store = await loadTaskTags();
      expect(store.tags.map((t) => t.id)).toEqual(['tt-good000001', 'tt-good000002']);
      expect(store.tags[0]).toMatchObject({ extra: 1 });
      expect(store.tags[1]?.color).toBeUndefined();
      expect(store.deleted.map((t) => t.id)).toEqual(['tt-gone000001']);
      expect((store as Record<string, unknown>).future).toBe('kept');
    });

    it('a corrupt file degrades to empty with one warning, and is left on disk', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      write('{ not json');
      expect((await loadTaskTags()).tags).toEqual([]);
      expect((await loadTaskTags()).tags).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(readFileSync(taskTagsPath(), 'utf8')).toBe('{ not json');
    });
  });

  describe('writing', () => {
    it('merge-writes atomically at 0600 and round-trips', async () => {
      await mergeWriteTaskTags((store) => {
        createTaskTag(store, { name: 'first', projectRoot: null });
      });
      expect((await loadTaskTags()).tags.map((t) => t.name)).toEqual(['first']);
      if (process.platform !== 'win32') expect(statSync(taskTagsPath()).mode & 0o777).toBe(0o600);
    });

    it('a refusal in the mutator writes nothing', async () => {
      await mergeWriteTaskTags((store) => {
        createTaskTag(store, { name: 'one', projectRoot: null });
      });
      const before = readFileSync(taskTagsPath(), 'utf8');
      await expect(
        mergeWriteTaskTags((store) => {
          createTaskTag(store, { name: 'ONE', projectRoot: null });
        }),
      ).rejects.toBeInstanceOf(TaskTagError);
      expect(readFileSync(taskTagsPath(), 'utf8')).toBe(before);
    });

    it('caps tombstones, oldest first', async () => {
      write({
        tags: [tag('tt-newest00001')],
        deleted: Array.from({ length: TASK_TAG_TOMBSTONES_MAX }, (_, i) => ({
          id: `tt-old${String(i).padStart(8, '0')}`,
          deletedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
        })),
      });
      await mergeWriteTaskTags((store) => deleteTaskTag(store, 'tt-newest00001', new Date('2026-11-23T00:00:00Z')));
      const store = await loadTaskTags();
      expect(store.deleted).toHaveLength(TASK_TAG_TOMBSTONES_MAX);
      expect(store.deleted.some((t) => t.id === 'tt-newest00001')).toBe(true);
    });

    it('refuses a create past the live-tag cap, on every path', () => {
      const store: TaskTagStore = {
        ...defaultTaskTagStore(),
        tags: Array.from({ length: TASK_TAGS_MAX }, (_, i) => tag(`tt-cap${String(i).padStart(8, '0')}`, { name: `t${i}` })),
      };
      expect(() => createTaskTag(store, { name: 'one more', projectRoot: null })).toThrow(/delete a tag first/);
      expect(() => resolveTagRefsIn(store, [{ name: 'one more' }], '/repo')).toThrow(/delete a tag first/);
      // Applying an existing tag is unaffected.
      expect(resolveTagRefsIn(store, [{ name: 't1' }], '/repo').tags).toHaveLength(1);
    });
  });

  describe('names (D6)', () => {
    const store = (): TaskTagStore => ({
      ...defaultTaskTagStore(),
      tags: [tag('tt-globalapi01', { name: 'API' }), tag('tt-projecta001', { name: 'batch', projectRoot: '/a' })],
    });

    it('a project name collides with a global name, case-insensitively', () => {
      expect(() => createTaskTag(store(), { name: 'api', projectRoot: '/b' })).toThrow(TaskTagError);
    });

    it('two projects may each hold the same name', () => {
      expect(createTaskTag(store(), { name: 'Batch', projectRoot: '/b' }).name).toBe('Batch');
    });

    it('a new global name collides with any project tag of that name', () => {
      expect(() => createTaskTag(store(), { name: 'BATCH', projectRoot: null })).toThrow(TaskTagError);
    });

    it('promotion checks every project', () => {
      const s = store();
      createTaskTag(s, { name: 'batch', projectRoot: '/b' });
      expect(() => updateTaskTag(s, 'tt-projecta001', { global: true })).toThrow(/already exists/);
      const lone = createTaskTag(s, { name: 'lone', projectRoot: '/b' });
      expect(updateTaskTag(s, lone.id, { global: true }).projectRoot).toBeUndefined();
    });

    it('renaming to its own name in another case is allowed', () => {
      expect(updateTaskTag(store(), 'tt-globalapi01', { name: 'api' }).name).toBe('api');
    });

    it('lists project tags as orphaned when their root is not registered', () => {
      const listed = listTaskTags(store(), (root) => (root === '/a' ? 'proj-a' : undefined));
      expect(listed.tags.find((t) => t.id === 'tt-projecta001')?.projectId).toBe('proj-a');
      const orphaned = listTaskTags(store(), () => undefined);
      expect(orphaned.tags.find((t) => t.id === 'tt-projecta001')).toMatchObject({ orphaned: true });
      expect(orphaned.tags.find((t) => t.id === 'tt-globalapi01')?.orphaned).toBeUndefined();
    });

    it('a project sees its own tags plus globals', () => {
      expect(visibleTaskTags(store(), '/a').map((t) => t.id)).toEqual(['tt-globalapi01', 'tt-projecta001']);
      expect(visibleTaskTags(store(), '/b').map((t) => t.id)).toEqual(['tt-globalapi01']);
    });
  });

  describe('resolveTagRefs', () => {
    const base = (): TaskTagStore => ({
      ...defaultTaskTagStore(),
      tags: [tag('tt-globalapi01', { name: 'API' }), tag('tt-projecta001', { name: 'batch', projectRoot: '/a' })],
      deleted: [{ id: 'tt-deleted0001', deletedAt: '2026-11-01T00:00:00Z' }],
    });

    it('reuses a visible name and creates a project-scoped tag otherwise', () => {
      const store = base();
      const { tags, created } = resolveTagRefsIn(store, [{ name: 'api' }, { name: 'New one' }, { name: 'new ONE' }], '/a');
      expect(created).toBe(true);
      expect(tags.map((t) => t.name)).toEqual(['API', 'New one']);
      const made = store.tags.find((t) => t.name === 'New one');
      expect(made?.projectRoot).toBe('/a');
      expect(made?.color).toBe(colorForName('New one'));
      expect(store.tags.find((t) => t.id === 'tt-globalapi01')?.lastUsedAt).toBeDefined();
    });

    it('refuses a tombstoned id, an unknown id and an out-of-scope id', () => {
      expect(() => resolveTagRefsIn(base(), [{ id: 'tt-deleted0001' }], '/a')).toThrow(/deleted/);
      expect(() => resolveTagRefsIn(base(), [{ id: 'tt-unknown0001' }], '/a')).toThrow(/unknown/);
      expect(() => resolveTagRefsIn(base(), [{ id: 'tt-projecta001' }], '/b')).toThrow(/another project/);
      for (const refs of [[{ id: 'tt-deleted0001' }], [{ id: 'tt-projecta001' }]]) {
        try {
          resolveTagRefsIn(base(), refs, '/b');
        } catch (error) {
          expect((error as TaskTagError).status).toBe(400);
        }
      }
    });

    it('a failed lastUsedAt bump does not fail applying an existing tag', async () => {
      write({ tags: [tag('tt-existing001', { name: 'kept' })] });
      if (process.platform === 'win32') return;
      chmodSync(home, 0o500);
      try {
        expect((await resolveTagRefs([{ id: 'tt-existing001' }], null)).tags.map((t) => t.name)).toEqual(['kept']);
        // …but creating a tag that cannot be saved is a write error.
        await expect(resolveTagRefs([{ name: 'brand new' }], null)).rejects.toThrow(/could not save/);
      } finally {
        chmodSync(home, 0o700);
      }
    });
  });

  describe('applyRunTagDelta', () => {
    const a = { id: 'tt-aaaaaaaa01', name: 'a' };
    const b = { id: 'tt-bbbbbbbb01', name: 'b' };

    it('adds, refreshes a snapshot, and removes; a missing remove is a no-op', () => {
      expect(applyRunTagDelta(undefined, [a], [])).toEqual([a]);
      expect(applyRunTagDelta([a], [{ ...a, name: 'renamed' }], [])).toEqual([{ ...a, name: 'renamed' }]);
      expect(applyRunTagDelta([a, b], [], [a.id, 'tt-notthere01'])).toEqual([b]);
    });

    it('refuses an eleventh tag', () => {
      const ten = Array.from({ length: 10 }, (_, i) => ({ id: `tt-ten0000000${i}`, name: `${i}` }));
      expect(() => applyRunTagDelta(ten, [a], [])).toThrow(TaskTagError);
    });
  });

  it('writes go through the sandboxed-home guard', async () => {
    // vitest.setup pins CEZ_HOME; pointing it at the real home must be refused, never written.
    const { homedir } = await import('node:os');
    process.env.CEZ_HOME = join(homedir(), '.cezar');
    await expect(mergeWriteTaskTags(() => {})).rejects.toThrow();
  });
});
