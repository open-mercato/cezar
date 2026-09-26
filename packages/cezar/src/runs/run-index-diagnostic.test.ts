import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import * as index from '../runs/run-index.ts';

const roots: string[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), 'cez-dashboard-'));
  roots.push(p);
  return p;
};
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const record = (id: string, status = 'waiting') => ({
  id,
  title: id,
  workflow: 'build',
  task: 't',
  status,
  createdAt: '2026-09-01T00:00:00Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
});
function disk(p: string, value: unknown) {
  mkdirSync(join(p, '.ai/cezar'), { recursive: true });
  writeFileSync(join(p, '.ai/cezar/runs.json'), JSON.stringify(value));
}

describe('diagnostic run index', () => {
  it('distinguishes empty, missing, corrupt, and partially salvageable projects without changing the legacy wrapper', () => {
    const p = root();
    expect(index.readRunIndexDiagnostic(join(p, '.ai/cezar'), p)).toMatchObject({
      state: 'complete',
      runs: [],
      omittedRuns: 0,
    });
    expect(index.readRunIndexDiagnostic(join(p, 'gone/.ai/cezar'), join(p, 'gone'))).toMatchObject({
      state: 'unavailable',
    });
    disk(p, [record('good'), { garbage: true }]);
    expect(index.readRunIndexDiagnostic(join(p, '.ai/cezar'), p)).toMatchObject({
      state: 'partial',
      runs: [{ id: 'good' }],
      omittedRuns: 1,
    });
    expect(index.readRunIndexFromDisk(join(p, '.ai/cezar'))).toEqual([]);
    disk(p, { invalid: true });
    expect(index.readRunIndexDiagnostic(join(p, '.ai/cezar'), p)).toMatchObject({
      state: 'unavailable',
    });
  });
});
