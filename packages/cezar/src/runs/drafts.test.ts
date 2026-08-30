import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_STORE_MAX_BYTES,
  deleteRunDraftImage,
  deleteRunDraftSurface,
  deleteRunDrafts,
  draftsRoot,
  readRunDraftImage,
  readRunDrafts,
  writeRunDraftImage,
  writeRunDraftSurface,
} from './drafts.ts';

/**
 * The per-run draft store (#939). Everything here is about the two promises the module makes:
 * a read NEVER throws whatever it finds on disk, and the only thing that deletes a draft the user
 * did not empty is the whole-store backstop.
 */
describe('run draft store', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-drafts-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const png = 'iVBORw0KGgoAAAANSUhEUg==';

  it('round-trips one surface', () => {
    const written = writeRunDraftSurface(dataDir, 'run-1', 'composer', {
      text: 'half a sentence',
      images: [],
    });
    expect(written.ok).toBe(true);
    expect(readRunDrafts(dataDir, 'run-1').surfaces.composer?.text).toBe('half a sentence');
  });

  it('keeps surfaces of one run independent, and runs independent of each other', () => {
    writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: 'a reply', images: [] });
    writeRunDraftSurface(dataDir, 'run-1', 'review-notes', { text: 'some notes', images: [] });
    writeRunDraftSurface(dataDir, 'run-2', 'composer', { text: 'another task', images: [] });

    const one = readRunDrafts(dataDir, 'run-1').surfaces;
    expect(one.composer?.text).toBe('a reply');
    expect(one['review-notes']?.text).toBe('some notes');
    expect(readRunDrafts(dataDir, 'run-2').surfaces.composer?.text).toBe('another task');
  });

  it('an empty write deletes the entry — "cleared when emptied" is the store\'s rule', () => {
    writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: 'typed', images: [] });
    const emptied = writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: '', images: [] });

    expect(emptied.ok).toBe(true);
    expect(readRunDrafts(dataDir, 'run-1').surfaces).toEqual({});
  });

  it('emptying the LAST surface removes the run directory, blobs and all', () => {
    const image = writeRunDraftImage(dataDir, 'run-1', { mediaType: 'image/png', name: 'shot.png', data: png });
    expect(image.ok).toBe(true);
    writeRunDraftSurface(dataDir, 'run-1', 'composer', {
      text: 'look at this',
      images: [image.ok ? image.image.id : ''],
    });

    writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: '', images: [] });

    expect(existsSync(join(draftsRoot(dataDir), 'run-1'))).toBe(false);
  });

  it('refuses an unknown surface id rather than reaching the filesystem with it', () => {
    const result = writeRunDraftSurface(dataDir, 'run-1', '../../escape', { text: 'x', images: [] });
    expect(result).toEqual({ ok: false, error: 'unknown draft surface' });
    expect(existsSync(draftsRoot(dataDir))).toBe(false);
  });

  it('refuses a PUT naming an image the store has never seen', () => {
    const result = writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: 'x', images: ['nope'] });
    expect(result).toEqual({ ok: false, error: 'unknown image: nope' });
  });

  it('reads a corrupt draft.json as absent instead of throwing', () => {
    mkdirSync(join(draftsRoot(dataDir), 'run-1'), { recursive: true });
    writeFileSync(join(draftsRoot(dataDir), 'run-1', 'draft.json'), '{ not json', 'utf8');

    expect(readRunDrafts(dataDir, 'run-1')).toEqual({ surfaces: {} });
  });

  it('salvages the siblings of one malformed entry, and drops an unknown surface id', () => {
    mkdirSync(join(draftsRoot(dataDir), 'run-1'), { recursive: true });
    writeFileSync(
      join(draftsRoot(dataDir), 'run-1', 'draft.json'),
      JSON.stringify({
        surfaces: {
          composer: { text: 'kept', images: [], updatedAt: '2026-08-30T10:00:00.000Z' },
          'review-notes': 'not an object',
          'made-up-surface': { text: 'dropped', images: [], updatedAt: '2026-08-30T10:00:00.000Z' },
        },
      }),
      'utf8',
    );

    const surfaces = readRunDrafts(dataDir, 'run-1').surfaces;
    expect(Object.keys(surfaces)).toEqual(['composer']);
    expect(surfaces.composer?.text).toBe('kept');
  });

  it('an unwritable store never throws — it answers with the reason', () => {
    mkdirSync(draftsRoot(dataDir), { recursive: true });
    chmodSync(draftsRoot(dataDir), 0o500);
    try {
      const result = writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: 'typed', images: [] });
      // Root ignores the mode bits, so accept either outcome — what is pinned is that neither
      // path throws and a failure is REPORTED rather than raised.
      expect(typeof result.ok).toBe('boolean');
      expect(readRunDrafts(dataDir, 'run-1')).toBeDefined();
    } finally {
      chmodSync(draftsRoot(dataDir), 0o700);
    }
  });

  it('deleting a surface leaves its siblings, and deleting the run removes everything', () => {
    writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: 'a', images: [] });
    writeRunDraftSurface(dataDir, 'run-1', 'title', { text: 'b', images: [] });

    deleteRunDraftSurface(dataDir, 'run-1', 'composer');
    expect(Object.keys(readRunDrafts(dataDir, 'run-1').surfaces)).toEqual(['title']);

    deleteRunDrafts(dataDir, 'run-1');
    expect(readRunDrafts(dataDir, 'run-1')).toEqual({ surfaces: {} });
    expect(existsSync(join(draftsRoot(dataDir), 'run-1'))).toBe(false);
  });

  describe('attachments', () => {
    it('stores, reads back and resolves into the surface listing', () => {
      const stored = writeRunDraftImage(dataDir, 'run-1', {
        mediaType: 'image/png',
        name: 'shot.png',
        data: png,
      });
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;

      writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: 'see this', images: [stored.image.id] });

      const entry = readRunDrafts(dataDir, 'run-1').surfaces.composer;
      expect(entry?.images).toEqual([
        { id: stored.image.id, mediaType: 'image/png', name: 'shot.png', bytes: expect.any(Number) },
      ]);
      // The metadata listing never carries the bytes; the blob route does.
      expect(readRunDraftImage(dataDir, 'run-1', stored.image.id)?.data).toBe(png);
    });

    it('a traversal-shaped image id reads as missing rather than escaping the directory', () => {
      expect(readRunDraftImage(dataDir, 'run-1', '../../etc/passwd')).toBeUndefined();
    });

    it('deleting an image drops it from every surface that named it', () => {
      const stored = writeRunDraftImage(dataDir, 'run-1', { mediaType: 'image/png', name: 's.png', data: png });
      if (!stored.ok) throw new Error('setup failed');
      writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: 'text', images: [stored.image.id] });

      deleteRunDraftImage(dataDir, 'run-1', stored.image.id);

      expect(readRunDrafts(dataDir, 'run-1').surfaces.composer?.images).toEqual([]);
      expect(readRunDraftImage(dataDir, 'run-1', stored.image.id)).toBeUndefined();
    });

    it('a blob that vanished simply stops being listed — the text draft survives it', () => {
      const stored = writeRunDraftImage(dataDir, 'run-1', { mediaType: 'image/png', name: 's.png', data: png });
      if (!stored.ok) throw new Error('setup failed');
      writeRunDraftSurface(dataDir, 'run-1', 'composer', { text: 'still here', images: [stored.image.id] });

      rmSync(join(draftsRoot(dataDir), 'run-1', 'images', `${stored.image.id}.json`), { force: true });

      const entry = readRunDrafts(dataDir, 'run-1').surfaces.composer;
      expect(entry?.text).toBe('still here');
      expect(entry?.images).toEqual([]);
    });

    it('sweeps an orphaned blob on the next write — but only once it is past the grace window', () => {
      const orphan = writeRunDraftImage(dataDir, 'run-1', { mediaType: 'image/png', name: 'o.png', data: png });
      if (!orphan.ok) throw new Error('setup failed');
      const path = join(draftsRoot(dataDir), 'run-1', 'images', `${orphan.image.id}.json`);

      // Fresh: an upload the debounced PUT has not named yet must survive a write to any surface.
      writeRunDraftSurface(dataDir, 'run-1', 'review-notes', { text: 'notes', images: [] });
      expect(existsSync(path)).toBe(true);

      // Aged past the grace window: nothing references it, so it goes.
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(path, old, old);
      writeRunDraftSurface(dataDir, 'run-1', 'review-notes', { text: 'notes, edited', images: [] });
      expect(existsSync(path)).toBe(false);
    });
  });

  describe('the whole-store backstop', () => {
    /** One draft whose file is big enough to move the total. */
    const fatDraft = (runId: string, updatedAt: string, bytes: number) => {
      mkdirSync(join(draftsRoot(dataDir), runId), { recursive: true });
      writeFileSync(
        join(draftsRoot(dataDir), runId, 'draft.json'),
        JSON.stringify({ surfaces: { composer: { text: 'x'.repeat(bytes), images: [], updatedAt } } }),
        'utf8',
      );
    };

    it('evicts least-recently-touched runs, and never the one being written', () => {
      const big = Math.ceil(DRAFT_STORE_MAX_BYTES / 2) + 1024;
      fatDraft('old-run', '2026-01-01T00:00:00.000Z', big);
      fatDraft('newer-run', '2026-08-01T00:00:00.000Z', big);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // The write that tips it over the ceiling — its own run must survive.
      writeRunDraftSurface(dataDir, 'writing-run', 'composer', { text: 'mine', images: [] });

      const left = readdirSync(draftsRoot(dataDir));
      expect(left).toContain('writing-run');
      expect(left).not.toContain('old-run');
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('leaves a store that fits entirely alone — no expiry, no count sweep', () => {
      for (let i = 0; i < 50; i += 1) {
        writeRunDraftSurface(dataDir, `run-${i}`, 'composer', {
          text: `draft ${i}`,
          images: [],
        });
      }
      expect(readdirSync(draftsRoot(dataDir))).toHaveLength(50);
      expect(readRunDrafts(dataDir, 'run-0').surfaces.composer?.text).toBe('draft 0');
    });
  });
});
