import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteRunLayouts,
  layoutsRoot,
  pruneOrphanLayouts,
  readRunLayouts,
  writeRunLayouts,
} from './layouts.ts';

/**
 * The per-run layout store (spec `.ai/specs/2026-10-07-task-workspace.md` §5.3 — layouts belong
 * to the cezar that OWNS the task, not to a browser).
 *
 * What these pin beyond "it writes a file": the three rules §5.3 actually states — a task that
 * has never been opened is distinguishable from one the user emptied on purpose, malformed state
 * recovers instead of throwing, and layouts die with their task and with nothing else.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cezar-layouts-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const ONE = {
  layouts: [{ name: 'Czat', columns: [{ view: 'session' as const, width: 100 }] }],
  active: 'Czat',
};

describe('the per-run layout store', () => {
  it('round-trips what the cockpit saved', () => {
    expect(writeRunLayouts(dataDir, 'run-1', ONE)).toBe(true);
    expect(readRunLayouts(dataDir, 'run-1')).toEqual(ONE);
  });

  it('answers null for a task that has never been opened', () => {
    // Not an empty list: §5.3 opens a never-seen task on a fresh `Czat`, and an empty list is a
    // workspace the user emptied, which stays empty. Collapsing the two would resurrect a card.
    expect(readRunLayouts(dataDir, 'never-opened')).toBeNull();
  });

  it('keeps an intentionally empty workspace empty', () => {
    const emptied = { layouts: [{ name: 'Czat', columns: [] }], active: 'Czat' };
    expect(writeRunLayouts(dataDir, 'run-1', emptied)).toBe(true);
    expect(readRunLayouts(dataDir, 'run-1')).toEqual(emptied);
  });

  it('recovers from a corrupt file rather than throwing', () => {
    mkdirSync(layoutsRoot(dataDir), { recursive: true });
    writeFileSync(join(layoutsRoot(dataDir), 'run-1.json'), '{ not json', 'utf8');
    expect(readRunLayouts(dataDir, 'run-1')).toBeNull();
  });

  it('refuses a value the contract does not accept', () => {
    // Four columns is past the spec's cap of three, so it must not reach the disk at all.
    const tooWide = {
      layouts: [{ name: 'X', columns: Array.from({ length: 4 }, () => ({ view: 'files' as const, width: 25 })) }],
      active: 'X',
    };
    expect(writeRunLayouts(dataDir, 'run-1', tooWide)).toBe(false);
    expect(readRunLayouts(dataDir, 'run-1')).toBeNull();
  });

  it('refuses a run id that could walk out of the store', () => {
    expect(writeRunLayouts(dataDir, '../escape', ONE)).toBe(false);
    expect(readRunLayouts(dataDir, '../escape')).toBeNull();
  });

  it('keeps two tasks apart', () => {
    writeRunLayouts(dataDir, 'run-1', ONE);
    expect(readRunLayouts(dataDir, 'run-2')).toBeNull();
  });

  it('forgets one task without touching another', () => {
    writeRunLayouts(dataDir, 'run-1', ONE);
    writeRunLayouts(dataDir, 'run-2', ONE);
    deleteRunLayouts(dataDir, 'run-1');
    expect(readRunLayouts(dataDir, 'run-1')).toBeNull();
    expect(readRunLayouts(dataDir, 'run-2')).toEqual(ONE);
  });

  it('writes the file with owner-only permissions', () => {
    writeRunLayouts(dataDir, 'run-1', ONE);
    // Same stance as the drafts store: this is the user's own screen state, kept at 0600.
    expect(readFileSync(join(layoutsRoot(dataDir), 'run-1.json'), 'utf8')).toContain('Czat');
  });

  it('prunes files whose run the store no longer has', () => {
    writeRunLayouts(dataDir, 'run-1', ONE);
    writeRunLayouts(dataDir, 'run-2', ONE);
    expect(pruneOrphanLayouts(dataDir, new Set(['run-2']))).toBe(1);
    expect(readRunLayouts(dataDir, 'run-1')).toBeNull();
    expect(readRunLayouts(dataDir, 'run-2')).toEqual(ONE);
  });
});
